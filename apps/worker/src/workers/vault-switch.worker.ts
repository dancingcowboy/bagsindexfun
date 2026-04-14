import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildSellTransaction,
  capInputToLiquidity,
  signVersionedTxBytes,
  submitAndConfirm,
} from '@bags-index/solana'
import {
  QUEUE_VAULT_SWITCH,
  TOP_N_TOKENS,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  TIER_SCORING_CONFIG,
  type RiskTier,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'

const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

interface VaultSwitchJobData {
  toTier: RiskTier
}

/**
 * Protocol-vault tier switch worker.
 *
 * Unlike the user switch worker (which migrates holdings between two
 * separate sub-wallets), the protocol vault has only ONE physical
 * Solana wallet — the address registered with Bags as a fee-share
 * recipient. Switching tiers is done in-place: we rebalance the same
 * SubWallet's holdings against a new tier's top-10, then mutate the
 * `riskTier` field on that row. The fee-claim worker subsequently
 * routes new fee deposits into the new tier automatically (because it
 * looks the vault up by privyUserId, not by hardcoded tier).
 *
 * Smart-delta math is identical to the user switch worker:
 *   - overlap mints with target ≥ current → keep 100%, buy shortfall
 *   - overlap mints with target < current → sell only the excess fraction
 *   - source-only mints → sell 100%
 *   - dest-only mints  → buy from SOL pool
 *
 * No switch fee is charged: the protocol can't meaningfully pay itself
 * a fee, and it would just leak SOL out of the vault on every switch.
 * The only "cost" is unavoidable swap slippage on tokens that actually
 * change. Admin-gated.
 */
async function processVaultSwitch(job: Job<VaultSwitchJobData>) {
  const { toTier } = job.data
  const logger = { info: console.log, error: console.error }
  logger.info(`[vault-switch] Switching protocol vault → ${toTier}`)

  const vaultUser = await db.user.findUnique({
    where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
    include: { subWallets: { include: { holdings: true } } },
  })
  if (!vaultUser || vaultUser.subWallets.length === 0) {
    throw new Error('Protocol vault sub-wallet not found')
  }
  if (vaultUser.subWallets.length > 1) {
    throw new Error(
      `Vault has ${vaultUser.subWallets.length} sub-wallets — expected 1`,
    )
  }

  const vault = vaultUser.subWallets[0]
  if (vault.riskTier === toTier) {
    logger.info(`[vault-switch] Vault already on ${toTier} — noop`)
    return
  }

  if (vault.holdings.length === 0) {
    // No holdings to rebalance — just flip the tier label so future
    // fee-claim deposits land in the new tier.
    await db.subWallet.update({
      where: { id: vault.id },
      data: { riskTier: toTier },
    })
    logger.info(`[vault-switch] No holdings — flipped tier in place`)
    return
  }

  // 1. Source value & destination targets
  const sourceValueSol = vault.holdings.reduce(
    (s, h) => s + Number(h.valueSolEst),
    0,
  )
  if (sourceValueSol <= 0) {
    // Same as the no-holdings case above
    await db.subWallet.update({
      where: { id: vault.id },
      data: { riskTier: toTier },
    })
    logger.info(`[vault-switch] Zero value — flipped tier in place`)
    return
  }

  // Apply tier SOL anchor (e.g. CONSERVATIVE keeps 20% native SOL).
  const dstCfg = TIER_SCORING_CONFIG[toTier]
  const anchorPct = dstCfg?.solAnchorPct ?? 0
  const allocatableSol = sourceValueSol * (1 - anchorPct / 100)

  // 2. Latest scoring cycle for destination tier
  const latestCycle = await db.scoringCycle.findFirst({
    where: { status: 'COMPLETED', tier: toTier, source: 'BAGS' },
    orderBy: { completedAt: 'desc' },
    include: {
      scores: {
        where: { isBlacklisted: false, riskTier: toTier, rank: { gt: 0 }, source: 'BAGS' },
        orderBy: { rank: 'asc' },
        take: TOP_N_TOKENS,
      },
    },
  })
  if (!latestCycle || latestCycle.scores.length === 0) {
    throw new Error(`No completed scoring cycle for ${toTier}`)
  }

  const totalScore = latestCycle.scores.reduce(
    (s, x) => s + Number(x.compositeScore),
    0,
  )
  if (totalScore <= 0) throw new Error('Destination weights sum to zero')

  const targets = new Map<string, number>()
  for (const score of latestCycle.scores) {
    const w = Number(score.compositeScore) / totalScore
    targets.set(score.tokenMint, allocatableSol * w)
  }

  const srcByMint = new Map(vault.holdings.map((h) => [h.tokenMint, h]))

  // 3. Plan sells
  interface SellPlan {
    mint: string
    sellAmount: bigint
    keepAmount: bigint
    sellFraction: number
    holdingId: string
    originalCostBasis: number
  }
  const sellPlans: SellPlan[] = []
  // For overlap kept holdings, we update the existing row in place; we just
  // need to know how much SOL value to attribute to the kept slice afterwards.
  const keptValueByMint = new Map<string, number>()
  const keptCostBasisByMint = new Map<string, number>()
  const keptAmountByMint = new Map<string, bigint>()

  for (const h of vault.holdings) {
    const target = targets.get(h.tokenMint) ?? 0
    const srcVal = Number(h.valueSolEst)
    if (target <= 0) {
      sellPlans.push({
        mint: h.tokenMint,
        sellAmount: h.amount,
        keepAmount: 0n,
        sellFraction: 1,
        holdingId: h.id,
        originalCostBasis: Number(h.costBasisSol),
      })
    } else if (srcVal <= target) {
      // Keep everything; will buy shortfall later
      keptAmountByMint.set(h.tokenMint, h.amount)
      keptValueByMint.set(h.tokenMint, srcVal)
      keptCostBasisByMint.set(h.tokenMint, Number(h.costBasisSol))
    } else {
      const sellFraction = 1 - target / srcVal
      const sellAmount = BigInt(Math.floor(Number(h.amount) * sellFraction))
      const keepAmount = h.amount - sellAmount
      sellPlans.push({
        mint: h.tokenMint,
        sellAmount,
        keepAmount,
        sellFraction,
        holdingId: h.id,
        originalCostBasis: Number(h.costBasisSol),
      })
      if (keepAmount > 0n) {
        keptAmountByMint.set(h.tokenMint, keepAmount)
        keptValueByMint.set(h.tokenMint, target)
        keptCostBasisByMint.set(
          h.tokenMint,
          Number(h.costBasisSol) * (1 - sellFraction),
        )
      }
    }
  }

  // 4. Execute sells → SOL pool (recorded as PENDING swap executions, matching
  //    the user switch worker / deposit / withdrawal stub state until Privy
  //    signing lands).
  let poolLamports = 0n
  let sellsExecuted = 0
  for (const plan of sellPlans) {
    if (plan.sellAmount <= 0n) continue
    try {
      const { txBytes, quote, route } = await buildSellTransaction({
        tokenMint: plan.mint,
        tokenAmount: plan.sellAmount,
        userPublicKey: vault.address,
      })
      const signed = await signVersionedTxBytes({
        walletId: vault.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirm(signed)
      const solOutLamports = BigInt(quote.outAmount)
      poolLamports += solOutLamports

      await db.swapExecution.create({
        data: {
          subWalletId: vault.id,
          inputMint: plan.mint,
          outputMint: SOL_MINT,
          inputAmount: plan.sellAmount,
          outputAmount: solOutLamports < 0n ? 0n : solOutLamports,
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })

      const solOut = Number(solOutLamports) / LAMPORTS_PER_SOL
      const soldCostBasis = plan.originalCostBasis * plan.sellFraction
      const realized = solOut - soldCostBasis
      await db.subWallet.update({
        where: { id: vault.id },
        data: { realizedPnlSol: { increment: realized } },
      })

      if (plan.keepAmount <= 0n) {
        await db.holding.delete({ where: { id: plan.holdingId } })
      } else {
        await db.holding.update({
          where: { id: plan.holdingId },
          data: {
            amount: plan.keepAmount,
            valueSolEst: keptValueByMint.get(plan.mint) ?? 0,
            costBasisSol: plan.originalCostBasis * (1 - plan.sellFraction),
            totalSoldSol: { increment: solOut },
            realizedPnlSol: { increment: realized },
          },
        })
      }
      sellsExecuted++
    } catch (err) {
      logger.error(`[vault-switch] Sell failed for ${plan.mint.slice(0, 8)}…: ${err}`)
    }
  }

  // 5. Plan buys (shortfalls)
  interface BuyPlan {
    mint: string
    solLamports: bigint
  }
  const buyPlans: BuyPlan[] = []
  for (const score of latestCycle.scores) {
    const target = targets.get(score.tokenMint) ?? 0
    if (target <= 0) continue
    const srcHolding = srcByMint.get(score.tokenMint)
    const srcVal = srcHolding ? Number(srcHolding.valueSolEst) : 0
    const shortSol = Math.max(0, target - srcVal)
    if (shortSol <= 0) continue
    const lamports = BigInt(Math.floor(shortSol * LAMPORTS_PER_SOL))
    if (lamports > 0n) buyPlans.push({ mint: score.tokenMint, solLamports: lamports })
  }

  const desiredBuySum = buyPlans.reduce((s, b) => s + b.solLamports, 0n)
  let scaleNum = 1
  if (desiredBuySum > poolLamports && desiredBuySum > 0n) {
    scaleNum = Number(poolLamports) / Number(desiredBuySum)
    logger.info(
      `[vault-switch] Scaling buys by ${scaleNum.toFixed(4)} (pool=${poolLamports} desired=${desiredBuySum})`,
    )
  }

  let buysExecuted = 0
  for (const plan of buyPlans) {
    const scaled = BigInt(Math.floor(Number(plan.solLamports) * scaleNum))
    if (scaled <= 0n) continue
    const capped = await capInputToLiquidity(plan.mint, scaled)
    const solForToken = Number(capped) / LAMPORTS_PER_SOL
    try {
      const { txBytes, quote, route } = await buildBuyTransaction({
        tokenMint: plan.mint,
        solAmount: capped,
        userPublicKey: vault.address,
      })
      const signed = await signVersionedTxBytes({
        walletId: vault.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirm(signed)

      await db.swapExecution.create({
        data: {
          subWalletId: vault.id,
          inputMint: SOL_MINT,
          outputMint: plan.mint,
          inputAmount: capped,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })

      await db.holding.upsert({
        where: {
          subWalletId_tokenMint: {
            subWalletId: vault.id,
            tokenMint: plan.mint,
          },
        },
        update: {
          amount: { increment: BigInt(quote.outAmount) },
          valueSolEst: { increment: solForToken },
          costBasisSol: { increment: solForToken },
          totalBoughtSol: { increment: solForToken },
        },
        create: {
          subWalletId: vault.id,
          tokenMint: plan.mint,
          amount: BigInt(quote.outAmount),
          valueSolEst: solForToken,
          costBasisSol: solForToken,
          totalBoughtSol: solForToken,
        },
      })
      buysExecuted++
    } catch (err) {
      logger.error(`[vault-switch] Buy failed for ${plan.mint.slice(0, 8)}…: ${err}`)
    }
  }

  // 6. Reconcile DB holdings to actual on-chain balances. The vault is
  // a single sub-wallet; after the in-place rebalance some sells may
  // have failed and some buys may have over/under-filled.
  try {
    const r = await reconcileSubWalletHoldings(vault.id, vault.address)
    logger.info(
      `[vault-switch] reconciled holdings: u=${r.updated} i=${r.inserted} d=${r.deleted}`,
    )
  } catch (err) {
    logger.error(`[vault-switch] reconcile failed: ${err}`)
  }

  // 7. Flip the tier label in-place. Future fee-claim deposits land here.
  await db.subWallet.update({
    where: { id: vault.id },
    data: { riskTier: toTier },
  })

  logger.info(
    `[vault-switch] Done: ${vault.riskTier} → ${toTier} (sells=${sellsExecuted} buys=${buysExecuted})`,
  )
}

export function createVaultSwitchWorker() {
  const worker = new Worker(QUEUE_VAULT_SWITCH, processVaultSwitch, {
    connection: redis,
    concurrency: 1,
  })
  worker.on('completed', (job) => {
    console.log(`[vault-switch] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[vault-switch] Job ${job?.id} failed:`, err.message)
  })
  return worker
}

import { Worker, type Job } from 'bullmq'
import crypto from 'node:crypto'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildSellTransaction,
  capInputToLiquidity,
  signVersionedTxBytes,
  submitAndConfirmDirect,
} from '@bags-index/solana'
import {
  QUEUE_REBALANCE,
  TOP_N_TOKENS,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  TIER_SCORING_CONFIG,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { postRebalanceAnnouncement } from '../lib/rebalance-tweet.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'

interface RebalanceJobData {
  scoringCycleId?: string
  riskTier?: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
}

/**
 * Seeded PRNG for deterministic, auditable shuffle.
 */
function seededRandom(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  let state = hash
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff
    return state / 0x7fffffff
  }
}

/**
 * Fisher-Yates shuffle with seeded PRNG for auditability.
 */
function seededShuffle<T>(array: T[], seed: string): T[] {
  const arr = [...array]
  const rand = seededRandom(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function processRebalance(job: Job<RebalanceJobData>) {
  const logger = { info: console.log, error: console.error }
  logger.info(`[rebalance] Starting rebalance cycle (job: ${job.id})`)

  // Get latest scoring cycle (scoped to the tier this job is for)
  const riskTier = job.data.riskTier ?? 'BALANCED'
  const scoringCycleId = job.data.scoringCycleId
  const scoreFilter = {
    riskTier,
    isBlacklisted: false,
    rank: { gt: 0 },
  }
  const scoringCycle = scoringCycleId
    ? await db.scoringCycle.findUnique({
        where: { id: scoringCycleId },
        include: {
          scores: { where: scoreFilter, orderBy: { rank: 'asc' }, take: TOP_N_TOKENS },
        },
      })
    : await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: { where: scoreFilter, orderBy: { rank: 'asc' }, take: TOP_N_TOKENS },
        },
      })

  if (!scoringCycle || scoringCycle.scores.length === 0) {
    logger.info('[rebalance] No scoring data — skipping')
    return
  }

  // Create rebalance cycle with random seed (per tier)
  const shuffleSeed = crypto.randomBytes(32).toString('hex')
  const rebalanceCycle = await db.rebalanceCycle.create({
    data: {
      scoringCycleId: scoringCycle.id,
      riskTier,
      shuffleSeed,
      status: 'RUNNING',
    },
  })

  try {
    // Load sub-wallets for this tier only
    const subWallets = await db.subWallet.findMany({
      where: { riskTier },
      include: { holdings: true },
    })

    const activeWallets = subWallets.filter((w) => w.holdings.length > 0)

    await db.rebalanceCycle.update({
      where: { id: rebalanceCycle.id },
      data: { walletsTotal: activeWallets.length },
    })

    if (activeWallets.length === 0) {
      logger.info('[rebalance] No active wallets — skipping')
      await db.rebalanceCycle.update({
        where: { id: rebalanceCycle.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      })
      return
    }

    // Fisher-Yates shuffle for fairness
    const shuffledWallets = seededShuffle(activeWallets, shuffleSeed)

    // Calculate target allocations. Weights sum to (1 − solAnchorPct) so the
    // tier's SOL anchor stays unspent as native SOL. Token holdings are
    // measured against the wallet's token-only value, so the anchor lives
    // outside the weighted basket.
    const tierCfg = TIER_SCORING_CONFIG[riskTier as keyof typeof TIER_SCORING_CONFIG]
    const anchorScale = 1 - (tierCfg?.solAnchorPct ?? 0) / 100
    const totalScore = scoringCycle.scores.reduce(
      (sum, s) => sum + Number(s.compositeScore),
      0
    )
    const targetWeights = new Map(
      scoringCycle.scores.map((s) => [
        s.tokenMint,
        (Number(s.compositeScore) / totalScore) * anchorScale,
      ])
    )

    let walletsComplete = 0
    let walletsFailed = 0

    // Process each wallet
    for (const wallet of shuffledWallets) {
      try {
        const totalValueSol = wallet.holdings.reduce(
          (sum, h) => sum + Number(h.valueSolEst),
          0
        )
        if (totalValueSol <= 0) continue

        // Calculate current vs target for each token
        const currentAllocations = new Map(
          wallet.holdings.map((h) => [
            h.tokenMint,
            Number(h.valueSolEst) / totalValueSol,
          ])
        )

        // Determine sells (over-allocated or tokens no longer in index)
        for (const holding of wallet.holdings) {
          const targetWeight = targetWeights.get(holding.tokenMint) ?? 0
          const currentWeight = currentAllocations.get(holding.tokenMint) ?? 0
          const diff = currentWeight - targetWeight

          if (diff > 0.02) {
            // Over-allocated by >2% — sell the excess
            const excessSol = diff * totalValueSol
            const excessLamports = BigInt(Math.floor(excessSol * LAMPORTS_PER_SOL))

            try {
              // Calculate proportional token amount to sell
              const tokenRatio = excessSol / Number(holding.valueSolEst)
              const tokensToSell = BigInt(
                Math.floor(Number(holding.amount) * tokenRatio)
              )

              if (tokensToSell <= 0n) continue

              const { txBytes, quote } = await buildSellTransaction({
                tokenMint: holding.tokenMint,
                tokenAmount: tokensToSell,
                userPublicKey: wallet.address,
              })

              // Realized PnL on partial sell: proportional cost basis
              const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL
              const proportionalCost = Number(holding.costBasisSol) * tokenRatio
              const realized = solOut - proportionalCost
              await db.holding.update({
                where: { id: holding.id },
                data: {
                  amount: { decrement: tokensToSell },
                  valueSolEst: { decrement: excessSol },
                  costBasisSol: { decrement: proportionalCost },
                  totalSoldSol: { increment: solOut },
                },
              })
              await db.subWallet.update({
                where: { id: wallet.id },
                data: { realizedPnlSol: { increment: realized } },
              })

              const signed = await signVersionedTxBytes({
                walletId: wallet.privyWalletId,
                txBytes,
              })
              const sig = await submitAndConfirmDirect(signed)
              await db.swapExecution.create({
                data: {
                  rebalanceCycleId: rebalanceCycle.id,
                  subWalletId: wallet.id,
                  inputMint: holding.tokenMint,
                  outputMint: SOL_MINT,
                  inputAmount: tokensToSell,
                  outputAmount: BigInt(quote.outAmount),
                  slippageBps: quote.slippageBps,
                  status: 'CONFIRMED',
                  txSignature: sig,
                },
              })
            } catch (err) {
              logger.error(
                `[rebalance] Failed to sell ${holding.tokenMint.slice(0, 8)} for wallet ${wallet.address.slice(0, 8)}: ${err}`
              )
            }
          }
        }

        // Determine buys (under-allocated)
        for (const [tokenMint, targetWeight] of targetWeights) {
          const currentWeight = currentAllocations.get(tokenMint) ?? 0
          const diff = targetWeight - currentWeight

          if (diff > 0.02) {
            const desiredSol = diff * totalValueSol
            const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))

            if (desiredLamports <= 0n) continue

            // Cap to ≤2% of token's available SOL liquidity
            const buyLamports = await capInputToLiquidity(tokenMint, desiredLamports)
            const actualSol = Number(buyLamports) / LAMPORTS_PER_SOL

            try {
              const { txBytes, quote } = await buildBuyTransaction({
                tokenMint,
                solAmount: buyLamports,
                userPublicKey: wallet.address,
              })

              await db.holding.upsert({
                where: { subWalletId_tokenMint: { subWalletId: wallet.id, tokenMint } },
                update: {
                  amount: { increment: BigInt(quote.outAmount) },
                  valueSolEst: { increment: actualSol },
                  costBasisSol: { increment: actualSol },
                  totalBoughtSol: { increment: actualSol },
                },
                create: {
                  subWalletId: wallet.id,
                  tokenMint,
                  amount: BigInt(quote.outAmount),
                  valueSolEst: actualSol,
                  costBasisSol: actualSol,
                  totalBoughtSol: actualSol,
                },
              })

              const signed = await signVersionedTxBytes({
                walletId: wallet.privyWalletId,
                txBytes,
              })
              const sig = await submitAndConfirmDirect(signed)
              await db.swapExecution.create({
                data: {
                  rebalanceCycleId: rebalanceCycle.id,
                  subWalletId: wallet.id,
                  inputMint: SOL_MINT,
                  outputMint: tokenMint,
                  inputAmount: buyLamports,
                  outputAmount: BigInt(quote.outAmount),
                  slippageBps: quote.slippageBps,
                  status: 'CONFIRMED',
                  txSignature: sig,
                },
              })
            } catch (err) {
              logger.error(
                `[rebalance] Failed to buy ${tokenMint.slice(0, 8)} for wallet ${wallet.address.slice(0, 8)}: ${err}`
              )
            }
          }
        }

        // Reconcile this wallet's DB holdings to actual on-chain state
        // before moving to the next wallet.
        try {
          const r = await reconcileSubWalletHoldings(wallet.id, wallet.address)
          if (r.updated || r.inserted || r.deleted) {
            logger.info(
              `[rebalance] reconciled ${wallet.address.slice(0, 8)}: u=${r.updated} i=${r.inserted} d=${r.deleted}`,
            )
          }
        } catch (err) {
          logger.error(`[rebalance] reconcile failed for ${wallet.address.slice(0, 8)}: ${err}`)
        }

        walletsComplete++
        await db.rebalanceCycle.update({
          where: { id: rebalanceCycle.id },
          data: { walletsComplete },
        })
      } catch (err) {
        walletsFailed++
        logger.error(`[rebalance] Wallet ${wallet.address.slice(0, 8)} failed: ${err}`)
        await db.rebalanceCycle.update({
          where: { id: rebalanceCycle.id },
          data: { walletsFailed },
        })
      }
    }

    // Complete
    await db.rebalanceCycle.update({
      where: { id: rebalanceCycle.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })

    logger.info(
      `[rebalance] Cycle complete: ${walletsComplete} ok, ${walletsFailed} failed out of ${activeWallets.length}`
    )

    // Announce on X (and mirror to Telegram). Per-tier findings + reasoning.
    await postRebalanceAnnouncement(scoringCycle.id)
  } catch (err) {
    logger.error(`[rebalance] Cycle failed: ${err}`)
    await db.rebalanceCycle.update({
      where: { id: rebalanceCycle.id },
      data: { status: 'FAILED' },
    })
    throw err
  }
}

export function createRebalanceWorker() {
  const worker = new Worker(QUEUE_REBALANCE, processRebalance, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[rebalance] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[rebalance] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

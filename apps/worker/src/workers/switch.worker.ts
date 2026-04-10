import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildSellTransaction,
  capInputToLiquidity,
  signVersionedTxBytes,
  submitAndConfirm,
  transferSolFromServerWallet,
} from '@bags-index/solana'
import {
  QUEUE_SWITCH,
  TOP_N_TOKENS,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
  TIER_SCORING_CONFIG,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'

interface SwitchJobData {
  switchJobId: string
  userId: string
}

/**
 * Tier-switch worker.
 *
 * Moves a user's entire position from one tier sub-wallet to another in
 * a single atomic operation, charging one flat switch fee instead of the
 * deposit+withdrawal combo. Uses a smart-delta strategy:
 *
 *  1. Compute source value (sum of current valueSolEst) and dest targets
 *     (net-of-fee SOL × each destination token's weight).
 *  2. For mints in BOTH source and dest:
 *       - if target ≥ source value → keep 100% of the source amount,
 *         later buy the shortfall (target − source) from the SOL pool.
 *       - else → sell only the excess fraction, keep the rest.
 *  3. For mints in source but NOT in dest → sell 100% → SOL pool.
 *  4. (No switch fee.)
 *  5. For mints in dest but NOT in source → buy from SOL pool.
 *  6. For kept-overlap mints, move their Holding row from source to dest
 *     sub-wallet (with proportional cost-basis transfer).
 *
 * The SOL pool is balanced by construction:
 *     inflow  = totalSrc − Σ min(srcVal, target)
 *     outflow = fee + Σ(target − srcVal, dest-only or overlap-short)
 *             = totalSrc − Σ min(srcVal, target)
 *
 * Swap execution matches deposit/withdrawal workers: builds the tx via
 * Bags /trade/swap and records a SwapExecution row. Actual Privy signing
 * is a TODO across deposit/withdrawal/switch and will land together.
 */
async function processSwitch(job: Job<SwitchJobData>) {
  const { switchJobId, userId } = job.data
  const logger = { info: console.log, error: console.error }
  logger.info(`[switch] Starting switch ${switchJobId}`)

  const switchJob = await db.switchJob.findFirst({
    where: { id: switchJobId, userId },
  })
  if (!switchJob) throw new Error(`SwitchJob ${switchJobId} not found`)
  if (switchJob.status !== 'PENDING') {
    logger.info(`[switch] ${switchJobId} already ${switchJob.status} — skipping`)
    return
  }

  try {
    const [srcWallet, dstWallet] = await Promise.all([
      db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: switchJob.fromTier } },
        include: { holdings: true },
      }),
      db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: switchJob.toTier } },
        include: { holdings: true },
      }),
    ])
    if (!srcWallet) throw new Error(`Source sub-wallet not found (${switchJob.fromTier})`)
    if (!dstWallet) throw new Error(`Dest sub-wallet not found (${switchJob.toTier})`)

    if (srcWallet.holdings.length === 0) {
      throw new Error('Source tier has no holdings to switch')
    }

    // 1. Compute source value & fee & net SOL available for targets.
    const sourceValueSol = srcWallet.holdings.reduce(
      (s, h) => s + Number(h.valueSolEst),
      0,
    )
    if (sourceValueSol <= 0) throw new Error('Source value is zero')

    // No switch fee. Destination tier may hold a SOL anchor (e.g. 12% for
    // CONSERVATIVE) and every vault holds a fixed BAGSX_WEIGHT_PCT slice in
    // $BAGSX. Remaining capital is scored-token composition.
    const feeSol = 0
    const dstTierCfg = TIER_SCORING_CONFIG[switchJob.toTier as keyof typeof TIER_SCORING_CONFIG]
    const anchorPct = dstTierCfg?.solAnchorPct ?? 0
    const scoredScale = 1 - anchorPct / 100 - BAGSX_WEIGHT_PCT / 100
    const netSol = sourceValueSol * scoredScale
    const bagsxSol = sourceValueSol * (BAGSX_WEIGHT_PCT / 100)

    // 2. Load destination top-10 weights (latest completed scoring cycle).
    const latestCycle = await db.scoringCycle.findFirst({
      where: { status: 'COMPLETED', tier: switchJob.toTier },
      orderBy: { completedAt: 'desc' },
      include: {
        scores: {
          where: {
            isBlacklisted: false,
            riskTier: switchJob.toTier,
            rank: { gt: 0 },
          },
          orderBy: { rank: 'asc' },
          take: TOP_N_TOKENS,
        },
      },
    })
    if (!latestCycle || latestCycle.scores.length === 0) {
      throw new Error('No destination scoring cycle available')
    }

    const totalScore = latestCycle.scores.reduce(
      (s, x) => s + Number(x.compositeScore),
      0,
    )
    if (totalScore <= 0) throw new Error('Destination weights sum to zero')

    // targets: mint → target SOL value in the dest wallet after switch
    const targets = new Map<string, number>()
    for (const score of latestCycle.scores) {
      const w = Number(score.compositeScore) / totalScore
      targets.set(score.tokenMint, netSol * w)
    }
    // Fixed BAGSX exposure slice — treated as any other target mint by the
    // sell/buy planner below.
    if (bagsxSol > 0) targets.set(BAGSX_MINT, bagsxSol)

    // Quick lookup: source holding by mint
    const srcByMint = new Map(srcWallet.holdings.map((h) => [h.tokenMint, h]))

    // 3. Plan sells (source → SOL). Overlap mints with excess sell a fraction;
    //    source-only mints sell 100%.
    interface SellPlan {
      mint: string
      sellAmount: bigint
      keepAmount: bigint
      sellFraction: number
      holdingId: string
      originalAmount: bigint
      originalCostBasis: number
    }
    const sellPlans: SellPlan[] = []
    // "kept" maps: mint → amount kept on source, to be migrated to dest later.
    //              mint → cost basis transferred with those kept tokens.
    const keptAmounts = new Map<string, bigint>()
    const keptCostBasis = new Map<string, number>()

    for (const h of srcWallet.holdings) {
      const target = targets.get(h.tokenMint) ?? 0
      const srcVal = Number(h.valueSolEst)
      if (target <= 0) {
        // Not in destination → sell everything
        sellPlans.push({
          mint: h.tokenMint,
          sellAmount: h.amount,
          keepAmount: 0n,
          sellFraction: 1,
          holdingId: h.id,
          originalAmount: h.amount,
          originalCostBasis: Number(h.costBasisSol),
        })
      } else if (srcVal <= target) {
        // Keep everything — short on dest side, will buy the shortfall later
        keptAmounts.set(h.tokenMint, h.amount)
        keptCostBasis.set(h.tokenMint, Number(h.costBasisSol))
      } else {
        // Sell the excess fraction only
        const sellFraction = 1 - target / srcVal
        // amount * sellFraction (integer floor)
        const sellAmount = BigInt(
          Math.floor(Number(h.amount) * sellFraction),
        )
        const keepAmount = h.amount - sellAmount
        sellPlans.push({
          mint: h.tokenMint,
          sellAmount,
          keepAmount,
          sellFraction,
          holdingId: h.id,
          originalAmount: h.amount,
          originalCostBasis: Number(h.costBasisSol),
        })
        if (keepAmount > 0n) {
          keptAmounts.set(h.tokenMint, keepAmount)
          keptCostBasis.set(
            h.tokenMint,
            Number(h.costBasisSol) * (1 - sellFraction),
          )
        }
      }
    }

    // 4. Execute sells. Track recovered SOL.
    let poolLamports = 0n
    let sellsExecuted = 0
    for (const plan of sellPlans) {
      if (plan.sellAmount <= 0n) continue
      try {
        const { txBytes, quote, route } = await buildSellTransaction({
          tokenMint: plan.mint,
          tokenAmount: plan.sellAmount,
          userPublicKey: srcWallet.address,
        })

        const signed = await signVersionedTxBytes({
          walletId: srcWallet.privyWalletId,
          txBytes,
        })
        const sig = await submitAndConfirm(signed)

        const solOutLamports = BigInt(quote.outAmount)
        poolLamports += solOutLamports

        await db.swapExecution.create({
          data: {
            subWalletId: srcWallet.id,
            inputMint: plan.mint,
            outputMint: SOL_MINT,
            inputAmount: plan.sellAmount,
            outputAmount: soloutGuard(solOutLamports),
            slippageBps: quote.slippageBps,
            route,
            status: 'CONFIRMED',
            txSignature: sig,
          },
        })

        // Realized PnL on the sold fraction accrues to the SOURCE sub-wallet
        const solOut = Number(solOutLamports) / LAMPORTS_PER_SOL
        const soldCostBasis = plan.originalCostBasis * plan.sellFraction
        const realized = solOut - soldCostBasis
        await db.subWallet.update({
          where: { id: srcWallet.id },
          data: { realizedPnlSol: { increment: realized } },
        })

        if (plan.keepAmount <= 0n) {
          await db.holding.delete({ where: { id: plan.holdingId } })
        } else {
          // Trim the source holding down to what we kept (pre-migration)
          await db.holding.update({
            where: { id: plan.holdingId },
            data: {
              amount: plan.keepAmount,
              valueSolEst: targets.get(plan.mint) ?? 0,
              costBasisSol: plan.originalCostBasis * (1 - plan.sellFraction),
              totalSoldSol: { increment: solOut },
              realizedPnlSol: { increment: realized },
            },
          })
        }
        sellsExecuted++
      } catch (err) {
        logger.error(`[switch] Sell failed for ${plan.mint.slice(0, 8)}…: ${err}`)
      }
    }

    // No fee to charge — full pool is available for dest buys.
    const feeChargedSol = 0

    // 6. Migrate kept holdings to the destination sub-wallet.
    //    Cost basis is transferred proportionally alongside the tokens.
    let overlapKept = 0
    for (const [mint, amount] of keptAmounts) {
      const basis = keptCostBasis.get(mint) ?? 0
      // valueSolEst for the kept slice ≈ min(original target, current src value)
      const target = targets.get(mint) ?? 0
      const h = srcByMint.get(mint)!
      const keptValueSol =
        target > 0 && h
          ? Math.min(target, Number(h.valueSolEst))
          : 0

      // Remove from source
      await db.holding
        .delete({
          where: {
            subWalletId_tokenMint: { subWalletId: srcWallet.id, tokenMint: mint },
          },
        })
        .catch(() => {})

      // Upsert on destination
      await db.holding.upsert({
        where: {
          subWalletId_tokenMint: { subWalletId: dstWallet.id, tokenMint: mint },
        },
        update: {
          amount: { increment: amount },
          valueSolEst: { increment: keptValueSol },
          costBasisSol: { increment: basis },
          totalBoughtSol: { increment: basis },
        },
        create: {
          subWalletId: dstWallet.id,
          tokenMint: mint,
          amount,
          valueSolEst: keptValueSol,
          costBasisSol: basis,
          totalBoughtSol: basis,
        },
      })
      overlapKept++
    }

    // 7. Buy dest tokens we don't already have enough of, from the SOL pool.
    //    Iterates over every target mint (scored top-10 + fixed BAGSX slice).
    interface BuyPlan {
      mint: string
      solLamports: bigint
    }
    const buyPlans: BuyPlan[] = []
    for (const [mint, target] of targets) {
      if (target <= 0) continue
      const srcHolding = srcByMint.get(mint)
      const srcVal = srcHolding ? Number(srcHolding.valueSolEst) : 0
      const shortSol = Math.max(0, target - srcVal)
      if (shortSol <= 0) continue
      const lamports = BigInt(Math.floor(shortSol * LAMPORTS_PER_SOL))
      if (lamports > 0n) buyPlans.push({ mint, solLamports: lamports })
    }

    // Bridge: physically move the recovered SOL pool from src → dst sub-wallet
    // so the dst wallet can pay for the buys. Leave a small reserve for gas.
    if (poolLamports > 0n) {
      try {
        const bridgeSig = await transferSolFromServerWallet({
          fromPrivyWalletId: srcWallet.privyWalletId,
          fromAddress: srcWallet.address,
          toAddress: dstWallet.address,
          lamports: poolLamports,
        })
        logger.info(`[switch] Bridged ${poolLamports} lamports src→dst: ${bridgeSig}`)
      } catch (err) {
        logger.error(`[switch] SOL bridge failed: ${err}`)
        throw err
      }
    }

    // Scale buy plans to the actual recovered pool (sells may have slipped).
    const desiredBuySum = buyPlans.reduce((s, b) => s + b.solLamports, 0n)
    let scaleNum = 1
    if (desiredBuySum > poolLamports && desiredBuySum > 0n) {
      scaleNum = Number(poolLamports) / Number(desiredBuySum)
      logger.info(
        `[switch] Scaling buys by ${scaleNum.toFixed(4)} (pool=${poolLamports}, desired=${desiredBuySum})`,
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
          userPublicKey: dstWallet.address,
        })

        const signed = await signVersionedTxBytes({
          walletId: dstWallet.privyWalletId,
          txBytes,
        })
        const sig = await submitAndConfirm(signed)

        await db.swapExecution.create({
          data: {
            subWalletId: dstWallet.id,
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
              subWalletId: dstWallet.id,
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
            subWalletId: dstWallet.id,
            tokenMint: plan.mint,
            amount: BigInt(quote.outAmount),
            valueSolEst: solForToken,
            costBasisSol: solForToken,
            totalBoughtSol: solForToken,
          },
        })
        buysExecuted++
      } catch (err) {
        logger.error(`[switch] Buy failed for ${plan.mint.slice(0, 8)}…: ${err}`)
      }
    }

    // No fee comparison — switch is free. solSaved preserved as 0 for the
    // existing DB column.
    const solSaved = 0

    // Reconcile both wallets to actual on-chain balances. The src side
    // should be empty (or hold only kept-overlap dust); the dst side
    // should hold the new tier basket.
    for (const w of [srcWallet, dstWallet]) {
      try {
        const r = await reconcileSubWalletHoldings(w.id, w.address)
        logger.info(
          `[switch] reconciled ${w.address.slice(0, 8)}: u=${r.updated} i=${r.inserted} d=${r.deleted}`,
        )
      } catch (err) {
        logger.error(`[switch] reconcile failed for ${w.address.slice(0, 8)}: ${err}`)
      }
    }

    await db.switchJob.update({
      where: { id: switchJobId },
      data: {
        status: 'CONFIRMED',
        completedAt: new Date(),
        sourceValueSol,
        feeSol: feeChargedSol,
        overlapKept,
        sellsExecuted,
        buysExecuted,
        solSavedEstimate: solSaved,
      },
    })

    logger.info(
      `[switch] ${switchJobId} done: kept=${overlapKept} sells=${sellsExecuted} buys=${buysExecuted}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[switch] ${switchJobId} failed: ${msg}`)
    await db.switchJob.update({
      where: { id: switchJobId },
      data: { status: 'FAILED', errorMessage: msg, completedAt: new Date() },
    })
    throw err
  }
}

// Sanity: never record a negative outputAmount (BigInt guard for the DB field)
function soloutGuard(n: bigint): bigint {
  return n < 0n ? 0n : n
}

export function createSwitchWorker() {
  const worker = new Worker(QUEUE_SWITCH, processSwitch, {
    connection: redis,
    concurrency: 1,
  })
  worker.on('completed', (job) => {
    console.log(`[switch] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[switch] Job ${job?.id} failed:`, err.message)
  })
  return worker
}

import { Worker, Queue, type Job } from 'bullmq'
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
  /**
   * Per-wallet sub-job. When set, only this wallet is rebalanced (no
   * tier-wide dispatching). The dispatcher job (no walletId) splits all
   * wallets in the tier into batches of REBALANCE_BATCH_SIZE per
   * REBALANCE_BATCH_INTERVAL_MS and enqueues these sub-jobs with
   * staggered `delay` values.
   */
  walletId?: string
  rebalanceCycleId?: string
}

// Wallets-per-batch and inter-batch interval for the dispatcher. With
// 25 wallets / hour the per-tier ceilings become ~100 (DEGEN, 4h),
// ~300 (BALANCED, 12h), ~600 (CONSERVATIVE, 24h). Surfaced as exports
// so the admin dashboard reads the same numbers the worker uses.
export const REBALANCE_BATCH_SIZE = 25
export const REBALANCE_BATCH_INTERVAL_MS = 60 * 60 * 1000

const rebalanceSelfQueue = new Queue(QUEUE_REBALANCE, { connection: redis })

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

  // Per-wallet sub-job path
  if (job.data.walletId && job.data.rebalanceCycleId) {
    return processSingleWallet(job.data, logger)
  }

  // Tier-wide dispatcher path
  logger.info(`[rebalance] Starting dispatch (job: ${job.id})`)
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
        where: { status: 'COMPLETED', tier: riskTier },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: { where: scoreFilter, orderBy: { rank: 'asc' }, take: TOP_N_TOKENS },
        },
      })

  if (!scoringCycle || scoringCycle.scores.length === 0) {
    logger.info('[rebalance] No scoring data — skipping')
    return
  }

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
      logger.info('[rebalance] No active wallets — completing immediately')
      await db.rebalanceCycle.update({
        where: { id: rebalanceCycle.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      })
      // Still tweet — composition changed even if no wallets to rebalance
      await postRebalanceAnnouncement(scoringCycle.id)
      return
    }

    const shuffledWallets = seededShuffle(activeWallets, shuffleSeed)
    for (let i = 0; i < shuffledWallets.length; i++) {
      const wallet = shuffledWallets[i]
      const batchIdx = Math.floor(i / REBALANCE_BATCH_SIZE)
      await rebalanceSelfQueue.add(
        `rebalance-wallet-${wallet.id}`,
        {
          walletId: wallet.id,
          rebalanceCycleId: rebalanceCycle.id,
          riskTier,
          scoringCycleId: scoringCycle.id,
        } satisfies RebalanceJobData,
        { delay: batchIdx * REBALANCE_BATCH_INTERVAL_MS },
      )
    }
    logger.info(
      `[rebalance/${riskTier}] dispatched ${shuffledWallets.length} wallets in ${Math.ceil(
        shuffledWallets.length / REBALANCE_BATCH_SIZE,
      )} batches of ${REBALANCE_BATCH_SIZE}`,
    )
  } catch (err) {
    logger.error(`[rebalance] Dispatch failed: ${err}`)
    await db.rebalanceCycle.update({
      where: { id: rebalanceCycle.id },
      data: { status: 'FAILED' },
    })
    throw err
  }
}

/**
 * Per-wallet sub-job: rebalance a single wallet against the target weights
 * implied by its rebalance cycle's scoring cycle. On the last wallet of the
 * cycle (walletsComplete + walletsFailed === walletsTotal) the rebalance
 * cycle is marked COMPLETED and the per-tier tweet/Telegram fires.
 */
async function processSingleWallet(
  data: RebalanceJobData,
  logger: { info: (m: string) => void; error: (m: string) => void },
) {
  const { walletId, rebalanceCycleId } = data
  if (!walletId || !rebalanceCycleId) return

  const cycle = await db.rebalanceCycle.findUnique({
    where: { id: rebalanceCycleId },
    include: {
      scoringCycle: {
        include: {
          scores: {
            where: { isBlacklisted: false, rank: { gt: 0 } },
            orderBy: { rank: 'asc' },
            take: TOP_N_TOKENS,
          },
        },
      },
    },
  })
  if (!cycle) {
    logger.error(`[rebalance/wallet] missing rebalance cycle ${rebalanceCycleId}`)
    return
  }
  const wallet = await db.subWallet.findUnique({
    where: { id: walletId },
    include: { holdings: true },
  })
  if (!wallet) {
    logger.error(`[rebalance/wallet] missing wallet ${walletId}`)
    return
  }

  const riskTier = cycle.riskTier
  const tierCfg = TIER_SCORING_CONFIG[riskTier as keyof typeof TIER_SCORING_CONFIG]
  const anchorScale = 1 - (tierCfg?.solAnchorPct ?? 0) / 100
  const scoresForTier = cycle.scoringCycle.scores.filter((s) => s.riskTier === riskTier)
  const totalScore = scoresForTier.reduce((sum, s) => sum + Number(s.compositeScore), 0)
  if (totalScore <= 0) {
    logger.info(`[rebalance/wallet] tier ${riskTier} has zero score — skipping`)
    await bumpAndMaybeFinish(cycle.id, true, logger, cycle.scoringCycleId)
    return
  }
  const targetWeights = new Map(
    scoresForTier.map((s) => [
      s.tokenMint,
      (Number(s.compositeScore) / totalScore) * anchorScale,
    ]),
  )

  let success = true
  try {
    const totalValueSol = wallet.holdings.reduce(
      (sum, h) => sum + Number(h.valueSolEst),
      0,
    )
    if (totalValueSol <= 0) {
      logger.info(`[rebalance/wallet] ${wallet.address.slice(0, 8)} empty — skipping`)
      await bumpAndMaybeFinish(cycle.id, true, logger, cycle.scoringCycleId)
      return
    }

    const currentAllocations = new Map(
      wallet.holdings.map((h) => [
        h.tokenMint,
        Number(h.valueSolEst) / totalValueSol,
      ]),
    )

    // Sells
    for (const holding of wallet.holdings) {
      const targetWeight = targetWeights.get(holding.tokenMint) ?? 0
      const currentWeight = currentAllocations.get(holding.tokenMint) ?? 0
      const diff = currentWeight - targetWeight
      if (diff <= 0.02) continue
      const excessSol = diff * totalValueSol
      try {
        const tokenRatio = excessSol / Number(holding.valueSolEst)
        const tokensToSell = BigInt(Math.floor(Number(holding.amount) * tokenRatio))
        if (tokensToSell <= 0n) continue
        const { txBytes, quote } = await buildSellTransaction({
          tokenMint: holding.tokenMint,
          tokenAmount: tokensToSell,
          userPublicKey: wallet.address,
        })
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
            rebalanceCycleId: cycle.id,
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
          `[rebalance/wallet] sell failed ${holding.tokenMint.slice(0, 8)} for ${wallet.address.slice(0, 8)}: ${err}`,
        )
      }
    }

    // Buys
    for (const [tokenMint, targetWeight] of targetWeights) {
      const currentWeight = currentAllocations.get(tokenMint) ?? 0
      const diff = targetWeight - currentWeight
      if (diff <= 0.02) continue
      const desiredSol = diff * totalValueSol
      const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))
      if (desiredLamports <= 0n) continue
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
            rebalanceCycleId: cycle.id,
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
          `[rebalance/wallet] buy failed ${tokenMint.slice(0, 8)} for ${wallet.address.slice(0, 8)}: ${err}`,
        )
      }
    }

    try {
      const r = await reconcileSubWalletHoldings(wallet.id, wallet.address)
      if (r.updated || r.inserted || r.deleted) {
        logger.info(
          `[rebalance/wallet] reconciled ${wallet.address.slice(0, 8)}: u=${r.updated} i=${r.inserted} d=${r.deleted}`,
        )
      }
    } catch (err) {
      logger.error(`[rebalance/wallet] reconcile failed ${wallet.address.slice(0, 8)}: ${err}`)
    }
  } catch (err) {
    success = false
    logger.error(`[rebalance/wallet] ${wallet.address.slice(0, 8)} failed: ${err}`)
  }

  await bumpAndMaybeFinish(cycle.id, success, logger, cycle.scoringCycleId)
}

/**
 * Atomically increment walletsComplete or walletsFailed on the rebalance
 * cycle, then check if it's the final wallet — if so, mark the cycle
 * COMPLETED and fire the per-tier tweet/Telegram announcement.
 */
async function bumpAndMaybeFinish(
  rebalanceCycleId: string,
  success: boolean,
  logger: { info: (m: string) => void; error: (m: string) => void },
  scoringCycleId: string,
) {
  const updated = await db.rebalanceCycle.update({
    where: { id: rebalanceCycleId },
    data: success
      ? { walletsComplete: { increment: 1 } }
      : { walletsFailed: { increment: 1 } },
    select: {
      id: true,
      walletsTotal: true,
      walletsComplete: true,
      walletsFailed: true,
      status: true,
      riskTier: true,
    },
  })
  if (updated.status === 'COMPLETED') return
  if (updated.walletsComplete + updated.walletsFailed >= updated.walletsTotal) {
    await db.rebalanceCycle.update({
      where: { id: rebalanceCycleId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    logger.info(
      `[rebalance/${updated.riskTier}] cycle complete: ${updated.walletsComplete} ok, ${updated.walletsFailed} failed`,
    )
    try {
      await postRebalanceAnnouncement(scoringCycleId)
    } catch (err) {
      logger.error(`[rebalance] tweet failed: ${err}`)
    }
  }
}

export function createRebalanceWorker() {
  const worker = new Worker(QUEUE_REBALANCE, processRebalance, {
    connection: redis,
    concurrency: 4,
  })

  worker.on('completed', (job) => {
    console.log(`[rebalance] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[rebalance] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

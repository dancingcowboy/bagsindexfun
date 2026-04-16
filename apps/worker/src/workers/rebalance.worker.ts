import { Worker, Queue, type Job } from 'bullmq'
import crypto from 'node:crypto'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildSellTransaction,
  capInputToLiquidity,
  getNativeSolBalanceLamports,
  signVersionedTxBytes,
  submitAndConfirm,
  transferSolFromServerWallet,
} from '@bags-index/solana'
import {
  QUEUE_REBALANCE,
  TOP_N_TOKENS,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  TIER_SCORING_CONFIG,
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { postRebalanceAnnouncement } from '../lib/rebalance-tweet.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'
import { notifyRebalance } from '../lib/notify-user.js'

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
        where: { status: 'COMPLETED', tier: riskTier, source: 'BAGS' },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: {
            where: { ...scoreFilter, source: 'BAGS' },
            orderBy: { rank: 'asc' },
            take: TOP_N_TOKENS,
          },
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
  // Every vault holds a fixed BAGSX slice. Scored tokens share the rest,
  // minus the tier's SOL anchor.
  const bagsxWeight = BAGSX_WEIGHT_PCT / 100
  const anchorScale = 1 - (tierCfg?.solAnchorPct ?? 0) / 100 - bagsxWeight
  const scoresForTier = cycle.scoringCycle.scores.filter((s) => s.riskTier === riskTier)
  // Square-root weighting: w_i = √score_i / Σ √score_j. Dampens concentration
  // on the top-scored picks, which back-tests significantly better than the
  // prior linear compositeScore / Σ compositeScore scheme.
  const totalScore = scoresForTier.reduce(
    (sum, s) => sum + Math.sqrt(Number(s.compositeScore)),
    0,
  )
  if (totalScore <= 0) {
    logger.info(`[rebalance/wallet] tier ${riskTier} has zero score — skipping`)
    await bumpAndMaybeFinish(cycle.id, true, logger, cycle.scoringCycleId)
    return
  }
  const targetWeights = new Map<string, number>(
    scoresForTier.map((s) => [
      s.tokenMint,
      (Math.sqrt(Number(s.compositeScore)) / totalScore) * anchorScale,
    ]),
  )
  // Fixed platform-token exposure — identical for user and system vaults.
  targetWeights.set(BAGSX_MINT, bagsxWeight)

  // Auto take-profit — Pool PnL model. Compute gain = currentValue −
  // costBasis where costBasis excludes AUTO_TP withdrawals (otherwise
  // every payout would reduce basis and trigger another payout next
  // cycle — a compounding drain). Shrink the rebalance target pool by
  // tpAmount so sells exceed buys by exactly that much, freeing the
  // SOL natively for payout after the rebalance settles.
  const isAutoCycle = cycle.trigger === 'AUTO'
  const tpPct = wallet.autoTakeProfitPct ?? 0
  const tpEligible = isAutoCycle && tpPct > 0
  const tpUser = tpEligible
    ? await db.user.findUnique({ where: { id: wallet.userId } })
    : null
  const tpActive = tpEligible && !!tpUser?.walletAddress

  let tpAmount = 0
  if (tpActive) {
    try {
      const tokenValueAtStart = wallet.holdings.reduce(
        (sum, h) => sum + Number(h.valueSolEst),
        0,
      )
      const nativeLamportsBefore = await getNativeSolBalanceLamports(wallet.address)
      const nativeSolBefore = Number(nativeLamportsBefore) / LAMPORTS_PER_SOL
      const currentValueSol = tokenValueAtStart + nativeSolBefore

      const [depAgg, wdAgg] = await Promise.all([
        db.deposit.aggregate({
          where: {
            userId: wallet.userId,
            riskTier: wallet.riskTier,
            status: { in: ['CONFIRMED', 'PARTIAL' as any] },
          },
          _sum: { amountSol: true, feeSol: true },
        }),
        db.withdrawal.aggregate({
          where: {
            userId: wallet.userId,
            riskTier: wallet.riskTier,
            source: 'USER',
            status: { in: ['CONFIRMED', 'PARTIAL' as any] },
          },
          _sum: { amountSol: true },
        }),
      ])
      const depositsNet =
        Number(depAgg._sum.amountSol ?? 0) - Number(depAgg._sum.feeSol ?? 0)
      const withdrawalsGross = Number(wdAgg._sum.amountSol ?? 0)
      const costBasisSol = depositsNet - withdrawalsGross
      const gain = currentValueSol - costBasisSol
      if (gain > 0) {
        tpAmount = (gain * tpPct) / 100
        if (tpAmount > tokenValueAtStart) tpAmount = tokenValueAtStart
      }
      logger.info(
        `[rebalance/tp] ${wallet.address.slice(0, 8)} curr=${currentValueSol.toFixed(4)} cost=${costBasisSol.toFixed(4)} gain=${gain.toFixed(4)} tp=${tpAmount.toFixed(4)} (${tpPct}%)`,
      )
    } catch (err: any) {
      logger.error(
        `[rebalance/tp] calc failed ${wallet.address.slice(0, 8)}: ${err?.message ?? err}`,
      )
      tpAmount = 0
    }
  }

  let success = true
  try {
    const tokenValueSol = wallet.holdings.reduce(
      (sum, h) => sum + Number(h.valueSolEst),
      0,
    )
    if (tokenValueSol <= 0) {
      logger.info(`[rebalance/wallet] ${wallet.address.slice(0, 8)} empty — skipping`)
      await bumpAndMaybeFinish(cycle.id, true, logger, cycle.scoringCycleId)
      return
    }
    // Include deployable native SOL in the rebalance base. Without this,
    // surplus from prior cycles (sells that outpaced buys) sits idle
    // forever because target weights only distribute the currently-held
    // token value. Reserve WALLET_RESERVE_SOL for tx fees; subtract
    // tpAmount so that much SOL survives the rebalance for payout.
    const nativeLamportsNow = await getNativeSolBalanceLamports(wallet.address)
    const nativeSolNow = Number(nativeLamportsNow) / LAMPORTS_PER_SOL
    const deployableNativeSol = Math.max(0, nativeSolNow - WALLET_RESERVE_SOL)
    const totalValueSol = Math.max(
      0.000001,
      tokenValueSol + deployableNativeSol - tpAmount,
    )
    if (deployableNativeSol > 0.01) {
      logger.info(
        `[rebalance/wallet] ${wallet.address.slice(0, 8)} deploying ${deployableNativeSol.toFixed(4)} idle SOL into basket`,
      )
    }

    const currentAllocations = new Map(
      wallet.holdings.map((h) => [
        h.tokenMint,
        Number(h.valueSolEst) / totalValueSol,
      ]),
    )

    // Sells — trim overweight positions
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
        const { txBytes, quote, route } = await buildSellTransaction({
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
        const sig = await submitAndConfirm(signed)
        await db.swapExecution.create({
          data: {
            rebalanceCycleId: cycle.id,
            subWalletId: wallet.id,
            inputMint: holding.tokenMint,
            outputMint: SOL_MINT,
            inputAmount: tokensToSell,
            outputAmount: BigInt(quote.outAmount),
            slippageBps: quote.slippageBps,
            route,
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

    // Dust sweep — fully sell any holding not in the current target set
    // (top-10 scored tokens + BAGSX). Skips the 2% threshold so stale
    // positions from previous cycles don't accumulate forever.
    const freshHoldings = await db.holding.findMany({
      where: { subWalletId: wallet.id },
    })
    for (const holding of freshHoldings) {
      if (targetWeights.has(holding.tokenMint)) continue
      if (Number(holding.amount) <= 0) continue
      const tokensToSell = BigInt(holding.amount)
      try {
        const { txBytes, quote, route } = await buildSellTransaction({
          tokenMint: holding.tokenMint,
          tokenAmount: tokensToSell,
          userPublicKey: wallet.address,
        })
        const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL
        const realized = solOut - Number(holding.costBasisSol)
        await db.holding.delete({ where: { id: holding.id } })
        await db.subWallet.update({
          where: { id: wallet.id },
          data: { realizedPnlSol: { increment: realized } },
        })
        const signed = await signVersionedTxBytes({
          walletId: wallet.privyWalletId,
          txBytes,
        })
        const sig = await submitAndConfirm(signed)
        await db.swapExecution.create({
          data: {
            rebalanceCycleId: cycle.id,
            subWalletId: wallet.id,
            inputMint: holding.tokenMint,
            outputMint: SOL_MINT,
            inputAmount: tokensToSell,
            outputAmount: BigInt(quote.outAmount),
            slippageBps: quote.slippageBps,
            route,
            status: 'CONFIRMED',
            txSignature: sig,
          },
        })
        logger.info(
          `[rebalance/wallet] dust swept ${holding.tokenMint.slice(0, 8)} from ${wallet.address.slice(0, 8)}: ${solOut.toFixed(6)} SOL`,
        )
      } catch (err) {
        logger.error(
          `[rebalance/wallet] dust sweep failed ${holding.tokenMint.slice(0, 8)} for ${wallet.address.slice(0, 8)}: ${err}`,
        )
      }
    }

    // Buys — no deadband on positive diffs. When the desired amount
    // exceeds what the rule (liquidity cap) or available native SOL
    // permits, buy the max the rule allows instead of skipping
    // entirely. Small drifts still close toward target each cycle;
    // large drifts partial-fill and finish over the next few cycles.
    for (const [tokenMint, targetWeight] of targetWeights) {
      const currentWeight = currentAllocations.get(tokenMint) ?? 0
      const diff = targetWeight - currentWeight
      if (diff <= 0) continue
      const desiredSol = diff * totalValueSol
      const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))
      if (desiredLamports <= 0n) continue
      const liqCapped = await capInputToLiquidity(tokenMint, desiredLamports)
      // Also cap by remaining deployable native SOL so we never try to
      // swap more than the wallet holds — avoids insufficient-funds
      // failures that would otherwise silently skip this mint.
      const currentNativeLamports = await getNativeSolBalanceLamports(wallet.address)
      const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
      const deployable = currentNativeLamports > reserveLamports
        ? currentNativeLamports - reserveLamports
        : 0n
      const buyLamports = liqCapped > deployable ? deployable : liqCapped
      if (buyLamports <= 0n) continue
      const actualSol = Number(buyLamports) / LAMPORTS_PER_SOL
      try {
        const { txBytes, quote, route } = await buildBuyTransaction({
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
        const sig = await submitAndConfirm(signed)
        await db.swapExecution.create({
          data: {
            rebalanceCycleId: cycle.id,
            subWalletId: wallet.id,
            inputMint: SOL_MINT,
            outputMint: tokenMint,
            inputAmount: buyLamports,
            outputAmount: BigInt(quote.outAmount),
            slippageBps: quote.slippageBps,
            route,
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

  // Auto take-profit payout — transfer the pre-computed tpAmount from
  // the vault's native-SOL balance to the user's external wallet. The
  // rebalance above already freed this SOL by shrinking target weights.
  if (tpActive && tpAmount > 0 && success) {
    try {
      const finalLamports = await getNativeSolBalanceLamports(wallet.address)
      const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
      const headroom =
        finalLamports > reserveLamports ? finalLamports - reserveLamports : 0n
      const desiredLamports = BigInt(Math.floor(tpAmount * LAMPORTS_PER_SOL))
      const payout = desiredLamports > headroom ? headroom : desiredLamports
      const MIN_PAYOUT = 1_000_000n // 0.001 SOL floor — tx fee would eat dust
      if (payout >= MIN_PAYOUT) {
        const w = await db.withdrawal.create({
          data: {
            userId: wallet.userId,
            riskTier: wallet.riskTier,
            amountSol: (Number(payout) / LAMPORTS_PER_SOL).toFixed(9),
            feeSol: '0',
            status: 'PENDING',
            source: 'AUTO_TP',
          },
        })
        try {
          const sig = await transferSolFromServerWallet({
            fromPrivyWalletId: wallet.privyWalletId,
            fromAddress: wallet.address,
            toAddress: tpUser!.walletAddress,
            lamports: payout,
          })
          await db.withdrawal.update({
            where: { id: w.id },
            data: {
              status: 'CONFIRMED',
              txSignature: sig,
              confirmedAt: new Date(),
            },
          })
          logger.info(
            `[rebalance/tp] ${wallet.address.slice(0, 8)} paid ${payout} lamports (${tpPct}%) -> ${sig}`,
          )
        } catch (err: any) {
          await db.withdrawal.update({
            where: { id: w.id },
            data: { status: 'FAILED' },
          })
          logger.error(
            `[rebalance/tp] transfer failed ${wallet.address.slice(0, 8)}: ${err?.message ?? err}`,
          )
          // Swallowed on purpose — swaps already landed, surplus compounds.
        }
      }
    } catch (err: any) {
      logger.error(
        `[rebalance/tp] payout step threw ${wallet.address.slice(0, 8)}: ${err?.message ?? err}`,
      )
    }
  }

  // Fire opt-in user DM before bumping the cycle counter. Reads
  // CONFIRMED swaps for this wallet in this cycle; no-op when user hasn't
  // linked Telegram or has notifications disabled.
  if (success) {
    await notifyRebalance({
      userId: wallet.userId,
      walletId: wallet.id,
      riskTier: wallet.riskTier,
      rebalanceCycleId: cycle.id,
      trigger: cycle.trigger,
    })
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
      trigger: true,
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
    // Only announce AUTO cycles. USER_FORCE reshuffles are single-wallet
    // personal actions — no global composition change, don't spam the group.
    if (updated.trigger === 'AUTO') {
      try {
        await postRebalanceAnnouncement(scoringCycleId)
      } catch (err) {
        logger.error(`[rebalance] tweet failed: ${err}`)
      }
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

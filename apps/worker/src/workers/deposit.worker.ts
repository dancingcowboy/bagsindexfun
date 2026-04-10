import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { buildBuyTransaction, submitAndConfirmDirect, capInputToLiquidity, signVersionedTxBytes, getNativeSolBalanceLamports } from '@bags-index/solana'
import {
  QUEUE_DEPOSIT,
  TOP_N_TOKENS,
  WALLET_RESERVE_SOL,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  TIER_SCORING_CONFIG,
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'

interface DepositJobData {
  depositId: string
  userId: string
}

/**
 * Deposit allocation worker.
 * After a deposit is confirmed, allocate SOL across the current top N tokens.
 */
async function processDeposit(job: Job<DepositJobData>) {
  const { depositId, userId } = job.data
  const logger = { info: console.log, error: console.error }
  logger.info(`[deposit] Allocating deposit ${depositId}`)

  const deposit = await db.deposit.findFirst({
    where: { id: depositId, userId },
  })
  if (!deposit) {
    throw new Error(`Deposit ${depositId} not found`)
  }

  // Route to the user's sub-wallet for this tier
  const subWallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId, riskTier: deposit.riskTier } },
  })
  if (!subWallet) {
    throw new Error(`No ${deposit.riskTier} sub-wallet for user ${userId}`)
  }

  // Check which tokens were already bought in a previous run of this deposit.
  // This makes re-enqueues idempotent — we only buy what's still missing.
  const confirmedSwaps = await db.swapExecution.findMany({
    where: {
      subWalletId: subWallet.id,
      status: 'CONFIRMED',
      inputMint: SOL_MINT,
      // Scoped to swaps created after the deposit, so unrelated older swaps
      // (e.g. from a rebalance) don't false-positive.
      executedAt: { gte: deposit.createdAt },
    },
    select: { outputMint: true },
  })
  const alreadyBoughtMints = new Set(confirmedSwaps.map((s) => s.outputMint))
  if (alreadyBoughtMints.size > 0) {
    logger.info(
      `[deposit] Resuming — ${alreadyBoughtMints.size} token(s) already bought, skipping those`,
    )
  }

  // Use actual on-chain balance instead of the deposit amount so partial
  // re-runs allocate only what SOL remains in the wallet.
  const actualLamports = await getNativeSolBalanceLamports(subWallet.address)
  const actualSol = Number(actualLamports) / LAMPORTS_PER_SOL

  const netSol = Number(deposit.amountSol) - Number(deposit.feeSol)
  // Reserve gas, then split the remainder: tier SOL anchor stays native,
  // BAGSX_WEIGHT_PCT buys $BAGSX, the rest is allocated across scored tokens.
  const tierCfg = TIER_SCORING_CONFIG[deposit.riskTier as keyof typeof TIER_SCORING_CONFIG]
  const anchorPct = tierCfg?.solAnchorPct ?? 0

  // On a fresh run, use the deposit amount; on a re-run, use actual balance.
  const baseSol = alreadyBoughtMints.size > 0 ? actualSol : netSol
  const postReserve = baseSol - WALLET_RESERVE_SOL
  const bagsxSol =
    !alreadyBoughtMints.has(BAGSX_MINT) && postReserve > 0
      ? postReserve * (BAGSX_WEIGHT_PCT / 100)
      : 0
  // For a re-run, the entire postReserve (minus BAGSX if needed) goes to
  // remaining tokens — the original anchor/weight split already happened.
  const allocatableSol = alreadyBoughtMints.size > 0
    ? postReserve - bagsxSol
    : postReserve > 0
      ? postReserve * (1 - anchorPct / 100 - BAGSX_WEIGHT_PCT / 100)
      : 0
  if (allocatableSol <= 0) {
    logger.info(`[deposit] Net amount too small to allocate after reserve (${baseSol.toFixed(4)} SOL available)`)
    return
  }

  // Get current index weights for this tier. Per-tier scoring runs on
  // staggered cron schedules and each run creates its own scoring_cycle,
  // so the most-recent completed cycle usually has scores for only one
  // tier. Pick the latest COMPLETED cycle that actually contains scores
  // for the tier we're allocating into, not just the most-recent cycle
  // overall.
  const latestCycle = await db.scoringCycle.findFirst({
    where: { status: 'COMPLETED', tier: deposit.riskTier },
    orderBy: { completedAt: 'desc' },
    include: {
      scores: {
        where: { isBlacklisted: false, riskTier: deposit.riskTier, rank: { gt: 0 } },
        orderBy: { rank: 'asc' },
        take: TOP_N_TOKENS,
      },
    },
  })

  if (!latestCycle || latestCycle.scores.length === 0) {
    logger.error('[deposit] No scoring cycle available — cannot allocate')
    return
  }

  // Filter out tokens already bought in a previous run
  const remainingScores = latestCycle.scores.filter(
    (s) => !alreadyBoughtMints.has(s.tokenMint),
  )
  if (remainingScores.length === 0 && alreadyBoughtMints.has(BAGSX_MINT)) {
    logger.info(`[deposit] All tokens already bought — nothing to do`)
    return
  }

  // Calculate weights from remaining tokens only
  const totalScore = remainingScores.reduce(
    (sum, s) => sum + Number(s.compositeScore),
    0
  )

  // Pre-create PENDING swap rows so the allocation modal can show all
  // expected swaps immediately, not only the ones already confirmed.
  const pendingSwaps: { id: string; mint: string; lamports: bigint }[] = []
  if (bagsxSol > 0) {
    const bagsxLamports = BigInt(Math.floor(bagsxSol * LAMPORTS_PER_SOL))
    const row = await db.swapExecution.create({
      data: {
        subWalletId: subWallet.id,
        inputMint: SOL_MINT,
        outputMint: BAGSX_MINT,
        inputAmount: bagsxLamports,
        outputAmount: null,
        slippageBps: 0,
        route: 'pending',
        status: 'PENDING',
      },
    })
    pendingSwaps.push({ id: row.id, mint: BAGSX_MINT, lamports: bagsxLamports })
  }
  for (const score of remainingScores) {
    const weightPct = Number(score.compositeScore) / totalScore
    const desiredSol = allocatableSol * weightPct
    const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))
    if (desiredLamports <= 0n) continue
    const row = await db.swapExecution.create({
      data: {
        subWalletId: subWallet.id,
        inputMint: SOL_MINT,
        outputMint: score.tokenMint,
        inputAmount: desiredLamports,
        outputAmount: null,
        slippageBps: 0,
        route: 'pending',
        status: 'PENDING',
      },
    })
    pendingSwaps.push({ id: row.id, mint: score.tokenMint, lamports: desiredLamports })
  }

  // Buy the fixed BAGSX slice first (same pipeline — recorded as a holding
  // and rebalanced identically to any other position).
  const bagsxPending = pendingSwaps.find((p) => p.mint === BAGSX_MINT)
  if (bagsxSol > 0 && bagsxPending) {
    const bagsxLamports = BigInt(Math.floor(bagsxSol * LAMPORTS_PER_SOL))
    try {
      const capped = await capInputToLiquidity(BAGSX_MINT, bagsxLamports)
      const solForBagsx = Number(capped) / LAMPORTS_PER_SOL
      const { txBytes, quote, route } = await buildBuyTransaction({
        tokenMint: BAGSX_MINT,
        solAmount: capped,
        userPublicKey: subWallet.address,
      })
      const signed = await signVersionedTxBytes({
        walletId: subWallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirmDirect(signed)
      await db.swapExecution.update({
        where: { id: bagsxPending.id },
        data: {
          inputAmount: capped,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
          confirmedAt: new Date(),
        },
      })
      await db.holding.upsert({
        where: {
          subWalletId_tokenMint: { subWalletId: subWallet.id, tokenMint: BAGSX_MINT },
        },
        update: {
          amount: { increment: BigInt(quote.outAmount) },
          valueSolEst: { increment: solForBagsx },
          costBasisSol: { increment: solForBagsx },
          totalBoughtSol: { increment: solForBagsx },
        },
        create: {
          subWalletId: subWallet.id,
          tokenMint: BAGSX_MINT,
          amount: BigInt(quote.outAmount),
          valueSolEst: solForBagsx,
          costBasisSol: solForBagsx,
          totalBoughtSol: solForBagsx,
        },
      })
      logger.info(`[deposit] Bought BAGSX slice: ${solForBagsx.toFixed(4)} SOL`)
    } catch (err) {
      logger.error(`[deposit] Failed to buy BAGSX slice: ${err}`)
      await db.swapExecution.update({
        where: { id: bagsxPending.id },
        data: { status: 'FAILED', errorMessage: String(err).slice(0, 500) },
      }).catch(() => {})
    }
  }

  // Execute swaps sequentially (avoid nonce conflicts). A small inter-swap
  // gap keeps us under the Bags trade API rate limit when a tier deposit
  // fans out into 11 back-to-back quote+swap pairs.
  let swapIdx = 0
  for (const score of remainingScores) {
    if (swapIdx++ > 0) await new Promise((r) => setTimeout(r, 2000))
    const pending = pendingSwaps.find((p) => p.mint === score.tokenMint)
    if (!pending) continue

    // Cap to ≤2% of token's available SOL liquidity to limit slippage impact
    const lamports = await capInputToLiquidity(score.tokenMint, pending.lamports)
    const solForToken = Number(lamports) / LAMPORTS_PER_SOL

    try {
      const { txBytes, quote, route } = await buildBuyTransaction({
        tokenMint: score.tokenMint,
        solAmount: lamports,
        userPublicKey: subWallet.address,
      })

      // Sign with the sub-wallet's Privy server wallet and submit on-chain.
      const signed = await signVersionedTxBytes({
        walletId: subWallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirmDirect(signed)

      await db.swapExecution.update({
        where: { id: pending.id },
        data: {
          inputAmount: lamports,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
          confirmedAt: new Date(),
        },
      })

      // Update holdings + cost basis (running totals)
      await db.holding.upsert({
        where: {
          subWalletId_tokenMint: {
            subWalletId: subWallet.id,
            tokenMint: score.tokenMint,
          },
        },
        update: {
          amount: { increment: BigInt(quote.outAmount) },
          valueSolEst: { increment: solForToken },
          costBasisSol: { increment: solForToken },
          totalBoughtSol: { increment: solForToken },
        },
        create: {
          subWalletId: subWallet.id,
          tokenMint: score.tokenMint,
          amount: BigInt(quote.outAmount),
          valueSolEst: solForToken,
          costBasisSol: solForToken,
          totalBoughtSol: solForToken,
        },
      })

      logger.info(
        `[deposit] Bought ${score.tokenSymbol}: ${solForToken.toFixed(4)} SOL → ${quote.outAmount} tokens`
      )
    } catch (err) {
      logger.error(`[deposit] Failed to buy ${score.tokenSymbol}: ${err}`)
      if (pending) {
        await db.swapExecution.update({
          where: { id: pending.id },
          data: { status: 'FAILED', errorMessage: String(err).slice(0, 500) },
        }).catch(() => {})
      }
      // Continue with other tokens — don't fail entire allocation
    }
  }

  // Reconcile DB holdings to actual on-chain SPL balances. Cost basis
  // and realized PnL are preserved; only `amount` is rewritten.
  try {
    const r = await reconcileSubWalletHoldings(subWallet.id, subWallet.address)
    logger.info(
      `[deposit] reconciled holdings: updated=${r.updated} inserted=${r.inserted} deleted=${r.deleted}`,
    )
  } catch (err) {
    logger.error(`[deposit] reconcile failed: ${err}`)
  }

  logger.info(`[deposit] Allocation complete for deposit ${depositId}`)
}

export function createDepositWorker() {
  const worker = new Worker(QUEUE_DEPOSIT, processDeposit, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[deposit] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[deposit] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { buildBuyTransaction, submitAndConfirmDirect, capInputToLiquidity, signVersionedTxBytes } from '@bags-index/solana'
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

  const netSol = Number(deposit.amountSol) - Number(deposit.feeSol)
  // Reserve gas, then split the remainder: tier SOL anchor stays native,
  // BAGSX_WEIGHT_PCT buys $BAGSX, the rest is allocated across scored tokens.
  const tierCfg = TIER_SCORING_CONFIG[deposit.riskTier as keyof typeof TIER_SCORING_CONFIG]
  const anchorPct = tierCfg?.solAnchorPct ?? 0
  const postReserve = netSol - WALLET_RESERVE_SOL
  const bagsxSol = postReserve > 0 ? postReserve * (BAGSX_WEIGHT_PCT / 100) : 0
  const allocatableSol =
    postReserve > 0 ? postReserve * (1 - anchorPct / 100 - BAGSX_WEIGHT_PCT / 100) : 0
  if (allocatableSol <= 0) {
    logger.info(`[deposit] Net amount too small to allocate after reserve`)
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

  // Calculate weights
  const totalScore = latestCycle.scores.reduce(
    (sum, s) => sum + Number(s.compositeScore),
    0
  )

  // Buy the fixed BAGSX slice first (same pipeline — recorded as a holding
  // and rebalanced identically to any other position).
  if (bagsxSol > 0) {
    const bagsxLamports = BigInt(Math.floor(bagsxSol * LAMPORTS_PER_SOL))
    try {
      const capped = await capInputToLiquidity(BAGSX_MINT, bagsxLamports)
      const solForBagsx = Number(capped) / LAMPORTS_PER_SOL
      const { txBytes, quote } = await buildBuyTransaction({
        tokenMint: BAGSX_MINT,
        solAmount: capped,
        userPublicKey: subWallet.address,
      })
      const signed = await signVersionedTxBytes({
        walletId: subWallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirmDirect(signed)
      await db.swapExecution.create({
        data: {
          subWalletId: subWallet.id,
          inputMint: SOL_MINT,
          outputMint: BAGSX_MINT,
          inputAmount: capped,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          status: 'CONFIRMED',
          txSignature: sig,
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
    }
  }

  // Execute swaps sequentially (avoid nonce conflicts). A small inter-swap
  // gap keeps us under the Bags trade API rate limit when a tier deposit
  // fans out into 11 back-to-back quote+swap pairs.
  let swapIdx = 0
  for (const score of latestCycle.scores) {
    if (swapIdx++ > 0) await new Promise((r) => setTimeout(r, 600))
    const weightPct = Number(score.compositeScore) / totalScore
    const desiredSol = allocatableSol * weightPct
    const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))

    if (desiredLamports <= 0n) continue

    // Cap to ≤2% of token's available SOL liquidity to limit slippage impact
    const lamports = await capInputToLiquidity(score.tokenMint, desiredLamports)
    const solForToken = Number(lamports) / LAMPORTS_PER_SOL

    try {
      const { txBytes, quote } = await buildBuyTransaction({
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

      await db.swapExecution.create({
        data: {
          subWalletId: subWallet.id,
          inputMint: SOL_MINT,
          outputMint: score.tokenMint,
          inputAmount: lamports,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          status: 'CONFIRMED',
          txSignature: sig,
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

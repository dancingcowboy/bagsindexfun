import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { buildBuyTransaction, submitAndConfirm, capInputToLiquidity } from '@bags-index/solana'
import {
  QUEUE_DEPOSIT,
  TOP_N_TOKENS,
  WALLET_RESERVE_SOL,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  TIER_SCORING_CONFIG,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'

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
  // Keep the hard gas reserve out of everything, THEN apply the tier's SOL
  // anchor (e.g. CONSERVATIVE keeps an extra 20% as native SOL for stability).
  const tierCfg = TIER_SCORING_CONFIG[deposit.riskTier as keyof typeof TIER_SCORING_CONFIG]
  const anchorPct = tierCfg?.solAnchorPct ?? 0
  const postReserve = netSol - WALLET_RESERVE_SOL
  const allocatableSol = postReserve > 0 ? postReserve * (1 - anchorPct / 100) : 0
  if (allocatableSol <= 0) {
    logger.info(`[deposit] Net amount too small to allocate after reserve`)
    return
  }

  // Get current index weights for this tier
  const latestCycle = await db.scoringCycle.findFirst({
    where: { status: 'COMPLETED' },
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

  // Execute swaps sequentially (avoid nonce conflicts)
  for (const score of latestCycle.scores) {
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

      // TODO: Sign via Privy Server Wallet API
      // const signedTx = await privySign(subWallet.privyWalletId, txBytes)
      // const sig = await submitAndConfirm(signedTx)

      // Record execution (pending actual signing)
      await db.swapExecution.create({
        data: {
          subWalletId: subWallet.id,
          inputMint: SOL_MINT,
          outputMint: score.tokenMint,
          inputAmount: lamports,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          status: 'PENDING', // Will be CONFIRMED after Privy signing is integrated
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

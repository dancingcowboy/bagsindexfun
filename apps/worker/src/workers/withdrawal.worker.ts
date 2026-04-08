import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildSellTransaction,
  submitAndConfirmDirect,
  signVersionedTxBytes,
  transferSolFromServerWallet,
} from '@bags-index/solana'
import {
  QUEUE_WITHDRAWAL,
  QUEUE_BURN,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { Queue } from 'bullmq'
import { redis } from '../queue/redis.js'

const burnQueue = new Queue(QUEUE_BURN, { connection: redis })

interface WithdrawalJobData {
  withdrawalId: string
  userId: string
  subWalletId: string
}

/**
 * Withdrawal liquidation worker.
 * Sells all holdings back to SOL, transfers to user wallet.
 */
async function processWithdrawal(job: Job<WithdrawalJobData>) {
  const { withdrawalId, userId, subWalletId } = job.data
  const logger = { info: console.log, error: console.error }
  logger.info(`[withdrawal] Liquidating for withdrawal ${withdrawalId}`)

  const withdrawal = await db.withdrawal.findFirst({
    where: { id: withdrawalId, userId },
  })
  if (!withdrawal) throw new Error(`Withdrawal ${withdrawalId} not found`)

  const subWallet = await db.subWallet.findUnique({
    where: { id: subWalletId },
    include: { holdings: true },
  })
  if (!subWallet) throw new Error(`Sub-wallet ${subWalletId} not found`)

  let totalRecoveredLamports = 0n
  let failedTokens = 0

  // Sell each holding sequentially
  for (const holding of subWallet.holdings) {
    if (holding.amount <= 0n) continue

    try {
      const { txBytes, quote } = await buildSellTransaction({
        tokenMint: holding.tokenMint,
        tokenAmount: holding.amount,
        userPublicKey: subWallet.address,
      })

      const signed = await signVersionedTxBytes({
        walletId: subWallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirmDirect(signed)

      totalRecoveredLamports += BigInt(quote.outAmount)

      // Realized PnL: SOL out vs cost basis on full liquidation
      const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL
      const costBasis = Number(holding.costBasisSol)
      const realized = solOut - costBasis
      await db.subWallet.update({
        where: { id: subWallet.id },
        data: { realizedPnlSol: { increment: realized } },
      })

      // Record execution
      await db.swapExecution.create({
        data: {
          subWalletId: subWallet.id,
          inputMint: holding.tokenMint,
          outputMint: SOL_MINT,
          inputAmount: holding.amount,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })

      // Clear holding
      await db.holding.delete({
        where: {
          subWalletId_tokenMint: {
            subWalletId: subWallet.id,
            tokenMint: holding.tokenMint,
          },
        },
      })

      logger.info(`[withdrawal] Sold ${holding.tokenMint.slice(0, 8)}... → ${quote.outAmount} lamports`)
    } catch (err) {
      logger.error(`[withdrawal] Failed to sell ${holding.tokenMint.slice(0, 8)}...: ${err}`)
      failedTokens++
    }
  }

  // Update withdrawal status
  const status = failedTokens > 0 ? 'PARTIAL' : 'CONFIRMED'
  await db.withdrawal.update({
    where: { id: withdrawalId },
    data: {
      status: status as any,
      confirmedAt: new Date(),
    },
  })

  // Transfer recovered SOL (minus protocol fee and gas reserve) to the user's
  // connected wallet. The fee stays on the sub-wallet for the burn worker to
  // pick up; gas reserve stays so the wallet can pay future tx fees.
  let transferSig: string | null = null
  try {
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) throw new Error(`User ${userId} not found`)
    const feeLamports = BigInt(Math.floor(Number(withdrawal.feeSol) * LAMPORTS_PER_SOL))
    const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
    const sendable = totalRecoveredLamports - feeLamports - reserveLamports
    if (sendable > 0n) {
      transferSig = await transferSolFromServerWallet({
        fromPrivyWalletId: subWallet.privyWalletId,
        fromAddress: subWallet.address,
        toAddress: user.walletAddress,
        lamports: sendable,
      })
      logger.info(`[withdrawal] Sent ${sendable} lamports to ${user.walletAddress}: ${transferSig}`)
      await db.withdrawal.update({
        where: { id: withdrawalId },
        data: { txSignature: transferSig },
      })
    }
  } catch (err) {
    logger.error(`[withdrawal] SOL transfer to user failed: ${err}`)
    failedTokens++
  }

  // Enqueue burn for the fee
  await burnQueue.add('burn-withdrawal-fee', {
    withdrawalId,
    feeSol: withdrawal.feeSol.toString(),
  })

  logger.info(
    `[withdrawal] Liquidation ${status} for ${withdrawalId}: recovered ${totalRecoveredLamports} lamports, ${failedTokens} failures`
  )
}

export function createWithdrawalWorker() {
  const worker = new Worker(QUEUE_WITHDRAWAL, processWithdrawal, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[withdrawal] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[withdrawal] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

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
  SOL_MINT,
  LAMPORTS_PER_SOL,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'

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

  // Transfer recovered SOL (minus gas reserve) to the user's connected wallet.
  // No protocol fee — vault value is 100% the user's. Gas reserve stays so
  // the wallet can pay future tx fees.
  let transferSig: string | null = null
  try {
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) throw new Error(`User ${userId} not found`)
    const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
    const sendable = totalRecoveredLamports - reserveLamports
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

  // Reconcile DB holdings to actual on-chain SPL balances. After a
  // withdrawal some sells may have failed (PARTIAL state) — this catches
  // any token rows that should have been deleted but weren't, and any
  // dust amounts left from rounding.
  try {
    const r = await reconcileSubWalletHoldings(subWallet.id, subWallet.address)
    logger.info(
      `[withdrawal] reconciled holdings: updated=${r.updated} inserted=${r.inserted} deleted=${r.deleted}`,
    )
  } catch (err) {
    logger.error(`[withdrawal] reconcile failed: ${err}`)
  }

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

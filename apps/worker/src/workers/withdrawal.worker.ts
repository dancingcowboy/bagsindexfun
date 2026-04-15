import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildSellTransaction,
  submitAndConfirm,
  signVersionedTxBytes,
  transferSolFromServerWallet,
  getNativeSolBalanceLamports,
} from '@bags-index/solana'
import {
  QUEUE_WITHDRAWAL,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'
import { notifyWithdrawal } from '../lib/notify-user.js'

interface WithdrawalJobData {
  withdrawalId: string
  userId: string
  subWalletId: string
  /** 1–100 — percentage of each holding to sell. Defaults to 100 (full). */
  pct?: number
  /** Single-token liquidation — sell only this mint, leave other holdings untouched. */
  tokenMint?: string
}

/**
 * Withdrawal liquidation worker.
 * Sells holdings (all or a percentage) back to SOL, transfers to user wallet.
 */
async function processWithdrawal(job: Job<WithdrawalJobData>) {
  const { withdrawalId, userId, subWalletId, pct = 100, tokenMint } = job.data
  // Single-token liquidation behaves like a partial withdrawal: transfer only
  // the recovered SOL (not a full wallet sweep), keep the other holdings.
  const isPartial = pct < 100 || !!tokenMint
  const logger = { info: console.log, error: console.error }
  logger.info(
    `[withdrawal] ${tokenMint ? `liquidating ${tokenMint.slice(0, 8)}… ` : `liquidating ${pct}% `}for withdrawal ${withdrawalId}`,
  )

  const withdrawal = await db.withdrawal.findFirst({
    where: { id: withdrawalId, userId },
  })
  if (!withdrawal) throw new Error(`Withdrawal ${withdrawalId} not found`)

  const subWallet = await db.subWallet.findUnique({
    where: { id: subWalletId },
    include: { holdings: true },
  })
  if (!subWallet) throw new Error(`Sub-wallet ${subWalletId} not found`)
  if (subWallet.userId !== userId) {
    throw new Error(`Sub-wallet ${subWalletId} does not belong to user ${userId}`)
  }
  if (subWallet.riskTier !== withdrawal.riskTier) {
    throw new Error(`Sub-wallet tier ${subWallet.riskTier} does not match withdrawal tier ${withdrawal.riskTier}`)
  }

  // Idempotent re-run: skip tokens that were already sold in a prior attempt.
  const priorSells = await db.swapExecution.findMany({
    where: {
      subWalletId: subWallet.id,
      outputMint: SOL_MINT,
      status: 'CONFIRMED',
      executedAt: { gte: withdrawal.createdAt },
    },
    select: { inputMint: true },
  })
  const alreadySoldMints = new Set(priorSells.map((s) => s.inputMint))
  if (alreadySoldMints.size > 0) {
    logger.info(`[withdrawal] Resuming — ${alreadySoldMints.size} tokens already sold, skipping`)
  }

  let totalRecoveredLamports = 0n
  let failedTokens = 0
  let transferredLamports = 0n

  // Sell each holding sequentially (full or pct%)
  const holdingsToSell = tokenMint
    ? subWallet.holdings.filter((h) => h.tokenMint === tokenMint)
    : subWallet.holdings
  if (tokenMint && holdingsToSell.length === 0) {
    throw new Error(`Token ${tokenMint} not held in sub-wallet ${subWalletId}`)
  }
  for (const holding of holdingsToSell) {
    if (holding.amount <= 0n) continue
    if (alreadySoldMints.has(holding.tokenMint)) continue
    // Skip zero-value dust — there's no Jupiter/Bags route for tokens
    // that have gone to zero, so attempts fail, count as failedTokens,
    // and force the withdrawal into PARTIAL forever. Reconciliation at
    // the end cleans these rows up from the DB.
    if (Number(holding.valueSolEst) <= 0) continue

    // For partial withdrawals, compute the fraction to sell
    const sellAmount = isPartial
      ? BigInt(Math.floor(Number(holding.amount) * pct / 100))
      : holding.amount
    if (sellAmount <= 0n) continue

    const sellFraction = isPartial ? pct / 100 : 1

    // Retry the build+sign+submit path up to 3 times for transient
    // errors (Bags/Jupiter 429s, quote stalls, confirmation timeouts).
    // Each attempt rebuilds the tx so it gets a fresh blockhash —
    // submitAndConfirm itself never re-submits.
    const MAX_ATTEMPTS = 3
    let sellResult: { sig: string; outAmount: string | number; slippageBps: number; route: any } | null = null
    let lastErr: any = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sellResult; attempt++) {
      try {
        const { txBytes, quote, route } = await buildSellTransaction({
          tokenMint: holding.tokenMint,
          tokenAmount: sellAmount,
          userPublicKey: subWallet.address,
        })
        const signed = await signVersionedTxBytes({
          walletId: subWallet.privyWalletId,
          txBytes,
        })
        const sig = await submitAndConfirm(signed)
        sellResult = { sig, outAmount: quote.outAmount, slippageBps: quote.slippageBps, route }
      } catch (err: any) {
        lastErr = err
        const detail = err?.response?.status
          ? `HTTP ${err.response.status}`
          : err?.message ?? String(err)
        logger.error(
          `[withdrawal] sell attempt ${attempt}/${MAX_ATTEMPTS} failed for ${holding.tokenMint.slice(0, 8)}…: ${detail}`,
        )
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 5_000 * attempt))
        }
      }
    }

    try {
      if (!sellResult) throw lastErr ?? new Error('sell failed')
      const { sig, outAmount, slippageBps, route } = sellResult
      const quote = { outAmount, slippageBps }

      totalRecoveredLamports += BigInt(quote.outAmount)

      const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL
      const soldCostBasis = Number(holding.costBasisSol) * sellFraction
      const realized = solOut - soldCostBasis
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
          inputAmount: sellAmount,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })

      // Delete when the entire holding is gone (full withdrawal OR single-token
      // liquidate, both of which sell 100% of this row). Otherwise trim.
      const deleteFullHolding = !!tokenMint || !isPartial
      if (!deleteFullHolding) {
        await db.holding.update({
          where: {
            subWalletId_tokenMint: {
              subWalletId: subWallet.id,
              tokenMint: holding.tokenMint,
            },
          },
          data: {
            amount: { decrement: sellAmount },
            valueSolEst: { decrement: Number(holding.valueSolEst) * sellFraction },
            costBasisSol: { decrement: soldCostBasis },
            totalSoldSol: { increment: solOut },
            realizedPnlSol: { increment: realized },
          },
        })
      } else {
        await db.holding.delete({
          where: {
            subWalletId_tokenMint: {
              subWalletId: subWallet.id,
              tokenMint: holding.tokenMint,
            },
          },
        })
      }

      logger.info(`[withdrawal] Sold ${pct}% of ${holding.tokenMint.slice(0, 8)}… → ${quote.outAmount} lamports`)
    } catch (err: any) {
      const detail = err?.response?.status
        ? `HTTP ${err.response.status} from ${err?.config?.url ?? 'unknown'}`
        : err?.message ?? String(err)
      logger.error(`[withdrawal] Failed to sell ${holding.tokenMint.slice(0, 8)}…: ${detail}`)
      failedTokens++
    }

    // Pause between sells to avoid bursting through Jupiter rate limits
    // when Bags is unavailable and all sells fall through to Jupiter.
    await new Promise((r) => setTimeout(r, 2_000))
  }

  // Transfer recovered SOL to the user's connected wallet.
  // For full liquidations with no failures the wallet is empty — send
  // the entire on-chain SOL balance (minus a minimal tx fee). For partial
  // withdrawals keep a gas reserve so the wallet can pay future tx fees.
  let transferSig: string | null = null
  let payoutFailed = false
  try {
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) throw new Error(`User ${userId} not found`)
    let sendable: bigint
    if (!isPartial) {
      // Full liquidation — sweep the entire on-chain balance, even if some
      // tokens failed to sell (dust/no-route). This ensures pre-existing
      // SOL from prior partial runs also goes back to the user. Status
      // will still be marked PARTIAL below if any sells failed, so retry
      // semantics remain intact — but the user gets their SOL now.
      const balanceLamports = await getNativeSolBalanceLamports(subWallet.address)
      // Rent-exempt minimum (890,880) + tx fee (5,000) leaves zero headroom.
      // If ANY sell later needs to be retried, Jupiter creates a transient
      // wSOL ATA (~2.04M lamports rent) which would revert pre-execution on
      // a barely-rent-exempt wallet. Reserve 10M (~0.01 SOL) so the wallet
      // can still liquidate stuck tokens on a follow-up attempt.
      const SWEEP_RESERVE = 10_000_000n
      sendable = balanceLamports > SWEEP_RESERVE ? balanceLamports - SWEEP_RESERVE : 0n
    } else {
      const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
      sendable = totalRecoveredLamports - reserveLamports
    }
    if (sendable > 0n) {
      transferSig = await transferSolFromServerWallet({
        fromPrivyWalletId: subWallet.privyWalletId,
        fromAddress: subWallet.address,
        toAddress: user.walletAddress,
        lamports: sendable,
      })
      transferredLamports = sendable
      logger.info(`[withdrawal] Sent ${sendable} lamports to ${user.walletAddress}: ${transferSig}`)
    }
  } catch (err) {
    logger.error(`[withdrawal] SOL transfer to user failed: ${err}`)
    payoutFailed = true
  }

  // Persist the final status only after the payout step, otherwise a failed
  // SOL transfer can incorrectly appear as a completed withdrawal.
  const status = failedTokens > 0 || payoutFailed ? 'PARTIAL' : 'CONFIRMED'
  await db.withdrawal.update({
    where: { id: withdrawalId },
    data: {
      status: status as any,
      confirmedAt: new Date(),
      txSignature: transferSig,
      amountSol: Number(transferredLamports) / LAMPORTS_PER_SOL,
    },
  })

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

  // Opt-in DM to the withdrawing user (post-reconcile so summary is fresh).
  try {
    await notifyWithdrawal({
      userId,
      withdrawalId,
      riskTier: withdrawal.riskTier,
    })
  } catch (err) {
    logger.error(`[withdrawal] user DM notify failed: ${err}`)
  }
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

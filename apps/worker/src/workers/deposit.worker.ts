import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { buildBuyTransaction, submitAndConfirm, capInputToLiquidity, signVersionedTxBytes, getNativeSolBalanceLamports } from '@bags-index/solana'
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
import { postToTelegram } from '../lib/telegram.js'
import { notifyDeposit } from '../lib/notify-user.js'

// Protocol-vault user's privy id — fee-claim auto-compounds run as this
// user. Skip Telegram notices for them so we don't spam the reshuffle
// channel every time accrued vault fees get redeployed.
const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

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

  // Clear the auto-rebalance pause (set by 100% withdrawal) so this tier
  // participates in AUTO cycles again after the deposit completes.
  if (subWallet.autoRebalancePaused) {
    await db.subWallet.update({
      where: { id: subWallet.id },
      data: { autoRebalancePaused: false },
    })
    logger.info(`[deposit] cleared auto-rebalance pause for wallet ${subWallet.id}`)
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
    where: { status: 'COMPLETED', tier: deposit.riskTier, source: 'BAGS' },
    orderBy: { completedAt: 'desc' },
    include: {
      scores: {
        where: { isBlacklisted: false, riskTier: deposit.riskTier, rank: { gt: 0 }, source: 'BAGS' },
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

  // Square-root weighting: w_i = √score_i / Σ √score_j.
  const totalScore = remainingScores.reduce(
    (sum, s) => sum + Math.sqrt(Number(s.compositeScore)),
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
    const weightPct = Math.sqrt(Number(score.compositeScore)) / totalScore
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
      const sig = await submitAndConfirm(signed)
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
      const sig = await submitAndConfirm(signed)

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
      logger.info(`[deposit] buy failed ${score.tokenSymbol} (default slippage), retrying at 15%: ${err}`)
      try {
        const { txBytes: txBytes2, quote: quote2, route: route2 } = await buildBuyTransaction({
          tokenMint: score.tokenMint,
          solAmount: lamports,
          userPublicKey: subWallet.address,
          slippageBps: 1500,
        })
        const signed2 = await signVersionedTxBytes({
          walletId: subWallet.privyWalletId,
          txBytes: txBytes2,
        })
        const sig2 = await submitAndConfirm(signed2)
        await db.swapExecution.update({
          where: { id: pending.id },
          data: {
            inputAmount: lamports,
            outputAmount: BigInt(quote2.outAmount),
            slippageBps: quote2.slippageBps,
            route: route2,
            status: 'CONFIRMED',
            txSignature: sig2,
            confirmedAt: new Date(),
          },
        })
        await db.holding.upsert({
          where: {
            subWalletId_tokenMint: {
              subWalletId: subWallet.id,
              tokenMint: score.tokenMint,
            },
          },
          update: {
            amount: { increment: BigInt(quote2.outAmount) },
            valueSolEst: { increment: solForToken },
            costBasisSol: { increment: solForToken },
            totalBoughtSol: { increment: solForToken },
          },
          create: {
            subWalletId: subWallet.id,
            tokenMint: score.tokenMint,
            amount: BigInt(quote2.outAmount),
            valueSolEst: solForToken,
            costBasisSol: solForToken,
            totalBoughtSol: solForToken,
          },
        })
        logger.info(`[deposit] buy succeeded on 15% retry: ${score.tokenSymbol}`)
      } catch (retryErr) {
        logger.error(`[deposit] buy failed ${score.tokenSymbol} even at 15%: ${retryErr}`)
        if (pending) {
          await db.swapExecution.update({
            where: { id: pending.id },
            data: { status: 'FAILED', errorMessage: String(retryErr).slice(0, 500) },
          }).catch(() => {})
        }
      }
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

  // Post a Telegram notice to the reshuffle channel summarising the
  // deposit + what was bought. Skip auto-compound deposits from the
  // protocol vault itself (fee-claim pipeline) so we don't spam the
  // channel on every internal redeployment.
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { privyUserId: true, walletAddress: true },
    })
    if (user && user.privyUserId !== SYSTEM_VAULT_PRIVY_ID) {
      const swaps = await db.swapExecution.findMany({
        where: {
          subWalletId: subWallet.id,
          status: 'CONFIRMED',
          inputMint: SOL_MINT,
          executedAt: { gte: deposit.createdAt },
        },
        select: { outputMint: true, inputAmount: true },
      })
      // Resolve symbols via latest TokenScore rows for each mint.
      const mints = Array.from(new Set(swaps.map((s) => s.outputMint)))
      const scoreRows = mints.length
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: mints }, source: 'BAGS' },
            select: { tokenMint: true, tokenSymbol: true },
            distinct: ['tokenMint'],
            orderBy: { scoredAt: 'desc' },
          })
        : []
      const symbolByMint = new Map(scoreRows.map((r) => [r.tokenMint, r.tokenSymbol]))
      const lines = swaps
        .map((s) => {
          const sym =
            symbolByMint.get(s.outputMint) ??
            `${s.outputMint.slice(0, 4)}…${s.outputMint.slice(-4)}`
          const sol = (Number(s.inputAmount) / LAMPORTS_PER_SOL).toFixed(4)
          return `• ${escapeHtml(sym)} — ${sol} SOL`
        })
        .join('\n')
      const wallet = `${user.walletAddress.slice(0, 4)}…${user.walletAddress.slice(-4)}`
      const amount = Number(deposit.amountSol).toFixed(4)
      const header = `💰 <b>New deposit — ${deposit.riskTier}</b>\n${amount} SOL from <code>${wallet}</code>`
      const body = lines ? `\n\n<b>Bought:</b>\n${lines}` : ''
      await postToTelegram(`${header}${body}`)
    }
  } catch (err) {
    logger.error(`[deposit] telegram notice failed: ${err}`)
  }

  // Opt-in DM to the depositing user.
  try {
    await notifyDeposit({ userId, depositId, riskTier: deposit.riskTier })
  } catch (err) {
    logger.error(`[deposit] user DM notify failed: ${err}`)
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

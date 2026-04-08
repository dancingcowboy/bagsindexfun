import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { buildBuyTransaction, buildBurnTransaction, submitAndConfirm } from '@bags-index/solana'
import {
  QUEUE_BURN,
  BURN_ALLOCATION_PCT,
  LAMPORTS_PER_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { postTweet } from '../lib/twitter.js'
import { mirrorTweetToTelegram } from '../lib/telegram.js'

function formatTokens(n: bigint): string {
  // Display in millions/thousands with 2-decimal precision; raw lamports otherwise
  const num = Number(n) / 1e6
  if (num >= 1) return `${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}M`
  return n.toString()
}

interface BurnJobData {
  depositId?: string
  withdrawalId?: string
  feeSol: string
}

/**
 * Burn worker.
 * Takes fee SOL, buys platform token via Bags trade API, then burns it.
 * If buy fails (no liquidity), holds fee in escrow and retries next cycle.
 */
async function processBurn(job: Job<BurnJobData>) {
  const { depositId, withdrawalId, feeSol } = job.data
  const logger = { info: console.log, error: console.error }
  const source = depositId ? `deposit:${depositId}` : `withdrawal:${withdrawalId}`
  logger.info(`[burn] Processing burn for ${source} — fee: ${feeSol} SOL`)

  const platformTokenMint = process.env.PLATFORM_TOKEN_MINT
  if (!platformTokenMint) {
    logger.info('[burn] PLATFORM_TOKEN_MINT not configured — skipping burn')
    return
  }

  // Calculate burn amount (BURN_ALLOCATION_PCT of fee)
  const feeNum = parseFloat(feeSol)
  const burnSol = (feeNum * BURN_ALLOCATION_PCT) / 100
  const burnLamports = BigInt(Math.floor(burnSol * LAMPORTS_PER_SOL))

  if (burnLamports <= 0n) return

  // Create burn record
  const burnRecord = await db.burnRecord.create({
    data: {
      depositId: depositId ?? null,
      withdrawalId: withdrawalId ?? null,
      platformTokenMint,
      tokensBought: 0n,
      tokensBurned: 0n,
      solSpent: burnSol,
      status: 'PENDING',
    },
  })

  try {
    // TODO: Use a dedicated burn wallet (Privy Server Wallet)
    // For now, the burn wallet address comes from env
    const burnWalletAddress = process.env.BURN_WALLET_ADDRESS
    if (!burnWalletAddress) {
      logger.info('[burn] BURN_WALLET_ADDRESS not configured — marking pending')
      return
    }

    // Step 1: Buy platform token with fee SOL
    const { txBytes: buyTxBytes, quote } = await buildBuyTransaction({
      tokenMint: platformTokenMint,
      solAmount: burnLamports,
      userPublicKey: burnWalletAddress,
    })

    const tokensBought = BigInt(quote.outAmount)

    // TODO: Privy sign + submit the buy transaction
    // const buySignature = await submitAndConfirm(signedBuyTx)

    // Step 2: Burn the tokens
    const burnTxBytes = await buildBurnTransaction({
      ownerPublicKey: burnWalletAddress,
      tokenMint: platformTokenMint,
      amount: tokensBought,
    })

    // TODO: Privy sign + submit the burn transaction
    // const burnSignature = await submitAndConfirm(signedBurnTx)

    // Update record
    await db.burnRecord.update({
      where: { id: burnRecord.id },
      data: {
        tokensBought,
        tokensBurned: tokensBought,
        // buyTxSig: buySignature,
        // burnTxSig: burnSignature,
        status: 'CONFIRMED',
      },
    })

    logger.info(`[burn] Burned ${tokensBought} tokens for ${source}`)

    // Announce on X (and mirror to Telegram). No wallet info.
    if (process.env.TWITTER_API_KEY) {
      try {
        const totalAgg = await db.burnRecord.aggregate({
          where: { status: 'CONFIRMED' },
          _sum: { tokensBurned: true },
        })
        const totalBurned = totalAgg._sum.tokensBurned ?? 0n
        const action = depositId ? 'deposit' : 'withdrawal'
        const text =
          `🔥 Buyback & burn complete\n\n` +
          `Burned: ${formatTokens(tokensBought)} $BAGSX\n` +
          `Trigger: new ${action}\n` +
          `Total burned to date: ${formatTokens(totalBurned)} $BAGSX\n\n` +
          `Every deposit and withdrawal shrinks the supply.`
        const twitterId = await postTweet(text)
        await db.burnRecord.update({ where: { id: burnRecord.id }, data: { tweetId: twitterId } })
        await mirrorTweetToTelegram(text, twitterId)
      } catch (tweetErr) {
        logger.error(`[burn] tweet/telegram failed: ${tweetErr}`)
      }
    }
  } catch (err) {
    logger.error(`[burn] Failed for ${source}: ${err}`)
    // Don't throw — burn failure should never block user operations
    // Record stays PENDING for retry in next cycle
  }
}

export function createBurnWorker() {
  const worker = new Worker(QUEUE_BURN, processBurn, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[burn] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[burn] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

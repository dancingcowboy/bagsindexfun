import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildBurnTransaction,
  submitAndConfirmDirect,
  signVersionedTxBase58,
  getAtaBalance,
  toBase58,
} from '@bags-index/solana'
import {
  QUEUE_BURN,
  BURN_ALLOCATION_PCT,
  LAMPORTS_PER_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { postTweet } from '../lib/twitter.js'
import { mirrorTweetToTelegram } from '../lib/telegram.js'

/** BAGSX has 9 decimals. Format raw base units as a human-readable token amount. */
const BAGSX_DECIMALS = 9
function formatTokens(n: bigint): string {
  const whole = Number(n) / 10 ** BAGSX_DECIMALS
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`
  if (whole >= 1_000) return `${(whole / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}K`
  return whole.toLocaleString(undefined, { maximumFractionDigits: 2 })
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

  // Idempotent: reuse any existing row for this deposit/withdrawal. If the
  // previous attempt already CONFIRMED, bail out — never double-burn.
  const existing = depositId
    ? await db.burnRecord.findUnique({ where: { depositId } })
    : withdrawalId
      ? await db.burnRecord.findUnique({ where: { withdrawalId } })
      : null
  if (existing?.status === 'CONFIRMED') {
    logger.info(`[burn] ${source} already CONFIRMED (burn ${existing.id}) — skipping`)
    return
  }
  const burnRecord = existing
    ? existing
    : await db.burnRecord.create({
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
    // The protocol vault is the buy-and-burn wallet — same Privy Server Wallet
    // that claims Bags fees. No separate "burn wallet" exists on Solana; burns
    // are SPL-token instructions signed by whoever holds the tokens.
    const vaultAddress = process.env.VAULT_WALLET_ADDRESS
    const vaultPrivyWalletId = process.env.VAULT_PRIVY_WALLET_ID
    if (!vaultAddress || !vaultPrivyWalletId) {
      logger.info('[burn] VAULT_WALLET_ADDRESS / VAULT_PRIVY_WALLET_ID not set — marking pending')
      return
    }

    // Snapshot ATA balance before buy — we burn only the delta we receive.
    const balanceBefore = await getAtaBalance({
      ownerPublicKey: vaultAddress,
      tokenMint: platformTokenMint,
    })

    // Step 1: Buy platform token with fee SOL via Bags trade API
    const { txBytes: buyTxBytes, quote } = await buildBuyTransaction({
      tokenMint: platformTokenMint,
      solAmount: burnLamports,
      userPublicKey: vaultAddress,
    })

    const buySigned = await signVersionedTxBase58({
      walletId: vaultPrivyWalletId,
      base58Tx: toBase58(buyTxBytes),
    })
    const buySig = await submitAndConfirmDirect(buySigned)
    logger.info(`[burn] Buy confirmed: ${buySig}`)

    // Step 2: Read the ATA balance after swap to find the exact delta to burn
    let balanceAfter = balanceBefore
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 2_000))
      balanceAfter = await getAtaBalance({
        ownerPublicKey: vaultAddress,
        tokenMint: platformTokenMint,
      })
      if (balanceAfter > balanceBefore) break
      logger.info(`[burn] Waiting for swap settlement (${attempt + 1}/6)…`)
    }

    const tokensBought = balanceAfter - balanceBefore
    if (tokensBought <= 0n) {
      logger.error(`[burn] Swap landed but no balance delta detected for ${source}`)
      return
    }
    logger.info(`[burn] Received ${tokensBought} ${platformTokenMint.slice(0, 8)} from buy`)

    // Step 3: Build + sign + submit the SPL burn instruction for the exact delta
    const burnTxBytes = await buildBurnTransaction({
      ownerPublicKey: vaultAddress,
      tokenMint: platformTokenMint,
      amount: tokensBought,
    })
    const burnSigned = await signVersionedTxBase58({
      walletId: vaultPrivyWalletId,
      base58Tx: toBase58(burnTxBytes),
    })
    const burnSig = await submitAndConfirmDirect(burnSigned)
    logger.info(`[burn] Burn confirmed: ${burnSig}`)

    // Update record
    await db.burnRecord.update({
      where: { id: burnRecord.id },
      data: {
        tokensBought,
        tokensBurned: tokensBought,
        buyTxSig: buySig,
        burnTxSig: burnSig,
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

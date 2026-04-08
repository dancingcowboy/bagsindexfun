import { Worker, type Job, Queue } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getClaimablePositions,
  buildClaimFeeTransactions,
  signVersionedTxBase58,
  submitAndConfirmDirect,
} from '@bags-index/solana'
import {
  QUEUE_FEE_CLAIM,
  QUEUE_BURN,
  QUEUE_DEPOSIT,
  LAMPORTS_PER_SOL,
  DEPOSIT_FEE_BPS,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'

const burnQueue = new Queue(QUEUE_BURN, { connection: redis })
const depositQueue = new Queue(QUEUE_DEPOSIT, { connection: redis })

// Stable identifier for the protocol's own "user" — owns the vault sub-wallet
// that auto-claimed Bags fees flow into. Treated identically to a real user by
// the deposit/rebalance pipeline.
const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

/**
 * Ensure the protocol vault is registered as a system user with a BALANCED
 * sub-wallet pointing at the on-chain vault wallet. Idempotent.
 */
async function ensureSystemVaultSubWallet(
  vaultAddress: string,
  vaultPrivyWalletId: string,
) {
  const user = await db.user.upsert({
    where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
    update: {},
    create: {
      privyUserId: SYSTEM_VAULT_PRIVY_ID,
      walletAddress: vaultAddress,
    },
  })
  const subWallet = await db.subWallet.upsert({
    where: { userId_riskTier: { userId: user.id, riskTier: 'BALANCED' } },
    update: {},
    create: {
      userId: user.id,
      privyWalletId: vaultPrivyWalletId,
      address: vaultAddress,
      riskTier: 'BALANCED',
    },
  })
  return { user, subWallet }
}

/**
 * Vault fee-claim worker.
 *
 * Bags trading fees on the platform token are split natively by Bags into two
 * recipient wallets: the team treasury (claimed manually) and the protocol
 * vault (this worker). The vault wallet's accrued fees are claimed every 4h
 * via the Bags API. The claimed SOL is treated as a deposit into the vault:
 * the standard deposit-fee burn rule (DEPOSIT_FEE_BPS = 3%) applies — 3% is
 * routed to the buyback+burn queue, the remaining 97% stays on the vault
 * wallet to be allocated by the rebalance/index pipeline. Same flat rule as
 * a user deposit, no exceptions.
 *
 * Signing path: vault is a Privy Server Wallet — we never hold the private
 * key. The privy.walletApi.signTransaction call is stubbed below until the
 * Privy server-wallet integration lands (same status as the user sub-wallet
 * signing in apps/api/src/routes/auth.ts).
 */
async function processFeeClaim(_job: Job) {
  const logger = { info: console.log, error: console.error }
  const vaultAddress = process.env.VAULT_WALLET_ADDRESS
  const vaultPrivyWalletId = process.env.VAULT_PRIVY_WALLET_ID
  const platformTokenMint = process.env.PLATFORM_TOKEN_MINT

  if (!vaultAddress || !vaultPrivyWalletId || !platformTokenMint) {
    logger.info('[fee-claim] VAULT_WALLET_ADDRESS, VAULT_PRIVY_WALLET_ID or PLATFORM_TOKEN_MINT not set — skipping')
    return
  }

  // 1. Discover what's claimable
  let positions
  try {
    positions = await getClaimablePositions(vaultAddress)
  } catch (err) {
    logger.error(`[fee-claim] Failed to fetch claimable positions: ${err}`)
    return
  }

  const withFees = positions.filter(
    (p) => BigInt(p.totalClaimableLamportsUserShare || '0') > 0n,
  )
  if (withFees.length === 0) {
    logger.info('[fee-claim] Nothing claimable — skipping')
    return
  }

  // 2. Claim each position. Track total SOL claimed for the burn enqueue.
  let totalLamportsClaimed = 0n
  for (const pos of withFees) {
    try {
      const txs = await buildClaimFeeTransactions({
        feeClaimer: vaultAddress,
        tokenMint: pos.baseMint,
      })

      for (const tx of txs) {
        const signedBytes = await signVersionedTxBase58({
          walletId: vaultPrivyWalletId,
          base58Tx: tx.tx,
        })
        const sig = await submitAndConfirmDirect(signedBytes)
        logger.info(
          `[fee-claim] Submitted claim tx for ${pos.baseMint.slice(0, 8)}: ${sig}`,
        )
      }

      const claimed = BigInt(pos.totalClaimableLamportsUserShare || '0')
      totalLamportsClaimed += claimed
      logger.info(
        `[fee-claim] Claimed ${(Number(claimed) / LAMPORTS_PER_SOL).toFixed(6)} SOL from ${pos.baseMint.slice(0, 8)}`,
      )
    } catch (err) {
      const anyErr = err as any
      const body = anyErr?.response?.data
      const status = anyErr?.response?.status
      logger.error(
        `[fee-claim] Claim failed for ${pos.baseMint.slice(0, 8)}: status=${status} body=${typeof body === 'string' ? body : JSON.stringify(body)} msg=${anyErr?.message}`,
      )
    }
  }

  if (totalLamportsClaimed <= 0n) return

  const totalSol = Number(totalLamportsClaimed) / LAMPORTS_PER_SOL
  // Standard 3% deposit-fee rule. 3% buys back+burns BAGSX, 97% is allocated
  // by the deposit-allocation pipeline (same code path as a user deposit).
  const burnSol = (totalSol * DEPOSIT_FEE_BPS) / 10_000

  // 3. Make sure the system vault sub-wallet exists, then create a Deposit
  // row for it and enqueue the same allocation + burn jobs that a real
  // user deposit would. Auto-claimed fees always go into the BALANCED tier.
  const { user: systemUser } = await ensureSystemVaultSubWallet(
    vaultAddress,
    vaultPrivyWalletId,
  )

  const deposit = await db.deposit.create({
    data: {
      userId: systemUser.id,
      riskTier: 'BALANCED',
      amountSol: totalSol,
      feeSol: burnSol,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
  })

  await db.auditLog.create({
    data: {
      action: 'VAULT_FEE_CLAIM',
      resource: `deposit:${deposit.id}`,
      metadata: {
        positions: withFees.length,
        lamportsClaimed: totalLamportsClaimed.toString(),
        sol: totalSol,
        burnSol,
        depositFeeBps: DEPOSIT_FEE_BPS,
        riskTier: 'BALANCED',
      },
    },
  })

  await depositQueue.add('allocate', {
    depositId: deposit.id,
    userId: systemUser.id,
  })
  await burnQueue.add('burn-deposit-fee', {
    depositId: deposit.id,
    feeSol: burnSol.toString(),
  })

  logger.info(
    `[fee-claim] Claimed ${totalSol.toFixed(6)} SOL across ${withFees.length} position(s); enqueued BALANCED allocation + ${burnSol.toFixed(6)} SOL burn (deposit ${deposit.id})`,
  )
}

export function createFeeClaimWorker() {
  const worker = new Worker(QUEUE_FEE_CLAIM, processFeeClaim, {
    connection: redis,
    concurrency: 1,
  })
  worker.on('completed', (job) => {
    console.log(`[fee-claim] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[fee-claim] Job ${job?.id} failed:`, err.message)
  })
  return worker
}

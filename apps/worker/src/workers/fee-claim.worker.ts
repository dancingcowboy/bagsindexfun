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
  QUEUE_DEPOSIT,
  LAMPORTS_PER_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'

const depositQueue = new Queue(QUEUE_DEPOSIT, { connection: redis })

// Stable identifier for the protocol's own "user" — owns the vault sub-wallet
// that auto-claimed Bags fees flow into. Treated identically to a real user by
// the deposit/rebalance pipeline.
const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

/**
 * Ensure the protocol vault is registered as a system user with a single
 * sub-wallet pointing at the on-chain vault wallet. The sub-wallet's
 * `riskTier` may have been mutated by an admin vault-switch — we look it
 * up by privyUserId rather than assuming BALANCED, so fee deposits keep
 * landing in whatever tier the vault is currently configured for. The
 * default tier on first creation is BALANCED. Idempotent.
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
  // Look up the vault sub-wallet by userId only — the protocol vault has
  // exactly one sub-wallet whose riskTier may change over time.
  let subWallet = await db.subWallet.findFirst({
    where: { userId: user.id },
  })
  if (!subWallet) {
    subWallet = await db.subWallet.create({
      data: {
        userId: user.id,
        privyWalletId: vaultPrivyWalletId,
        address: vaultAddress,
        riskTier: 'BALANCED',
      },
    })
  }
  return { user, subWallet }
}

/**
 * Vault fee-claim worker.
 *
 * Bags trading fees on the platform token are split natively by Bags into two
 * recipient wallets: the team treasury (claimed manually) and the protocol
 * vault (this worker). The vault wallet's accrued fees are claimed every 4h
 * via the Bags API. The claimed SOL is treated as a fee-free deposit into
 * the vault — allocated across the standard index composition (scored
 * tokens + 8% BAGSX slice + tier SOL anchor), identical to a user deposit.
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

  // 2. Claim each position. Track total SOL claimed for the deposit enqueue.
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

  // 3. Make sure the system vault sub-wallet exists, then create a Deposit
  // row for it and enqueue the same allocation jobs that a real
  // user deposit would. Auto-claimed fees flow into whichever tier the
  // protocol vault is currently configured for (default BALANCED, but an
  // admin vault-switch can move it to CONSERVATIVE or DEGEN).
  const { user: systemUser, subWallet: vaultSubWallet } =
    await ensureSystemVaultSubWallet(vaultAddress, vaultPrivyWalletId)
  const activeTier = vaultSubWallet.riskTier

  const deposit = await db.deposit.create({
    data: {
      userId: systemUser.id,
      riskTier: activeTier,
      amountSol: totalSol,
      feeSol: 0,
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
        riskTier: activeTier,
      },
    },
  })

  await depositQueue.add('allocate', {
    depositId: deposit.id,
    userId: systemUser.id,
  })

  logger.info(
    `[fee-claim] Claimed ${totalSol.toFixed(6)} SOL across ${withFees.length} position(s); enqueued ${activeTier} allocation (deposit ${deposit.id})`,
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

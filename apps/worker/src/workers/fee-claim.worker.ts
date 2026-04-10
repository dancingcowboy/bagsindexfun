import { Worker, type Job, Queue } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getClaimablePositions,
  buildClaimFeeTransactions,
  signVersionedTxBase58,
  submitAndConfirmDirect,
  transferSolFromServerWallet,
  getNativeSolBalance,
} from '@bags-index/solana'
import {
  QUEUE_FEE_CLAIM,
  QUEUE_DEPOSIT,
  LAMPORTS_PER_SOL,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'

const depositQueue = new Queue(QUEUE_DEPOSIT, { connection: redis })

// Stable identifier for the protocol's own "user" — owns the vault sub-wallets
// that auto-claimed Bags fees flow into. One sub-wallet per tier, all
// sharing a single on-chain fee-claim address.
const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

/**
 * Ensure the protocol vault user + all 3 tier sub-wallets exist.
 * The PRIMARY sub-wallet (the one registered with Bags as fee recipient)
 * is identified by `VAULT_WALLET_ADDRESS`. The other two are tier-specific
 * sub-wallets created via `/admin/vault-expand`. Returns all 3 (or however
 * many exist — gracefully handles the pre-expansion state where only 1 exists).
 */
async function getVaultSubWallets() {
  const user = await db.user.findUnique({
    where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
    include: { subWallets: true },
  })
  return user
}

/**
 * Vault fee-claim worker.
 *
 * 1. Claim accrued Bags trading fees to the primary vault wallet (the one
 *    registered with Bags as fee-share recipient).
 * 2. Split the claimed SOL equally across all tier sub-wallets. If there
 *    are 3 sub-wallets (CONSERVATIVE, BALANCED, DEGEN), each gets 1/3.
 * 3. For each tier, create a Deposit row and enqueue a deposit-allocation
 *    job so the normal allocation pipeline invests it into that tier's
 *    scored tokens + 10% BAGSX slice.
 *
 * The primary wallet may or may not be one of the tier sub-wallets. If
 * it IS (e.g. it's the BALANCED sub-wallet), no SOL transfer is needed
 * for that tier — only the other two get a transfer. If it ISN'T (edge
 * case), all three get a transfer.
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

  // 2. Claim each position
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

  // 3. Fetch all vault sub-wallets
  const vaultUser = await getVaultSubWallets()
  if (!vaultUser || vaultUser.subWallets.length === 0) {
    logger.error('[fee-claim] Protocol vault user or sub-wallets not found')
    return
  }

  const subWallets = vaultUser.subWallets
  const tierCount = subWallets.length

  // Read actual post-claim balance on the primary wallet. Fee claims
  // may have under-filled (partial claims) and we don't want to
  // over-promise. Reserve gas on the primary wallet.
  let availableLamports: bigint
  try {
    const balance = await getNativeSolBalance(vaultAddress)
    const balanceLamports = BigInt(Math.floor(balance * LAMPORTS_PER_SOL))
    const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
    availableLamports = balanceLamports > reserveLamports
      ? balanceLamports - reserveLamports
      : 0n
  } catch (err) {
    logger.error(`[fee-claim] Failed to read vault balance: ${err}`)
    return
  }

  if (availableLamports <= 0n) {
    logger.info('[fee-claim] Post-claim balance too low after reserve — skipping distribution')
    return
  }

  const perTierLamports = availableLamports / BigInt(tierCount)
  if (perTierLamports <= 0n) return

  logger.info(
    `[fee-claim] Distributing ${(Number(availableLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL across ${tierCount} tier(s) (${(Number(perTierLamports) / LAMPORTS_PER_SOL).toFixed(6)} each)`,
  )

  // 4. Transfer + enqueue deposit per tier
  // The primary vault wallet (fee-claim address) might be one of the
  // tier sub-wallets. For that wallet, skip the SOL transfer — it
  // already holds its share. For the others, transfer from primary.
  for (const sw of subWallets) {
    const tier = sw.riskTier
    const perTierSol = Number(perTierLamports) / LAMPORTS_PER_SOL

    // If this sub-wallet IS the primary fee-claim wallet, no transfer needed.
    // If it's a different wallet, send its share over.
    if (sw.address !== vaultAddress) {
      try {
        const sig = await transferSolFromServerWallet({
          fromPrivyWalletId: vaultPrivyWalletId,
          fromAddress: vaultAddress,
          toAddress: sw.address,
          lamports: perTierLamports,
        })
        logger.info(
          `[fee-claim] Transferred ${perTierSol.toFixed(6)} SOL to ${tier} sub-wallet ${sw.address.slice(0, 8)}: ${sig}`,
        )
      } catch (err) {
        logger.error(`[fee-claim] Transfer to ${tier} sub-wallet failed: ${err}`)
        continue // Skip this tier's deposit — don't create a phantom deposit
      }
    }

    // Create deposit + enqueue allocation
    const deposit = await db.deposit.create({
      data: {
        userId: vaultUser.id,
        riskTier: tier,
        amountSol: perTierSol,
        feeSol: 0,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    })

    await depositQueue.add('allocate', {
      depositId: deposit.id,
      userId: vaultUser.id,
    })

    logger.info(
      `[fee-claim] Enqueued ${tier} allocation: ${perTierSol.toFixed(6)} SOL (deposit ${deposit.id})`,
    )
  }

  await db.auditLog.create({
    data: {
      action: 'VAULT_FEE_CLAIM',
      resource: `user:${vaultUser.id}`,
      metadata: {
        positions: withFees.length,
        lamportsClaimed: totalLamportsClaimed.toString(),
        distributed: tierCount,
        perTierSol: Number(perTierLamports) / LAMPORTS_PER_SOL,
      },
    },
  })

  logger.info(
    `[fee-claim] Done: claimed from ${withFees.length} position(s), distributed to ${tierCount} tier(s)`,
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

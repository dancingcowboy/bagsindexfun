import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  buildBuyTransaction,
  buildSellTransaction,
  capInputToLiquidity,
  getNativeSolBalanceLamports,
  signVersionedTxBytes,
  submitAndConfirm,
} from '@bags-index/solana'
import {
  QUEUE_CUSTOM_VAULT_REBALANCE,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
  WALLET_RESERVE_SOL,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reconcileSubWalletHoldings } from '../lib/reconcile.js'
import { getLiveHoldings } from '@bags-index/solana'

interface CustomVaultJobData {
  customVaultId: string
}

const logger = { info: console.log, error: console.error }

/**
 * Custom vault rebalance worker.
 *
 * Each custom vault has a user-defined list of token mints and a
 * per-vault rebalance interval. Allocation is equal-weight across
 * all tokens + 10% BAGSX pinned — identical to the tier vaults'
 * BAGSX anchor but with equal (not score-based) distribution.
 *
 * Flow:
 *   1. Fetch CustomVault + SubWallet + Holdings
 *   2. Get live on-chain valuations
 *   3. Compute equal-weight targets
 *   4. Sell overweight positions
 *   5. Buy underweight positions (with 15% slippage retry)
 *   6. Reconcile holdings against on-chain state
 *   7. Update lastRebalancedAt
 */
export async function processCustomVaultRebalance(job: Job<CustomVaultJobData>) {
  const { customVaultId } = job.data
  const started = Date.now()
  logger.info(`[custom-vault] starting rebalance for vault=${customVaultId}`)

  const vault = await db.customVault.findUnique({
    where: { id: customVaultId },
    include: {
      subWallet: { include: { holdings: true } },
    },
  })

  if (!vault) {
    logger.error(`[custom-vault] vault not found: ${customVaultId}`)
    return
  }

  if (vault.status !== 'ACTIVE') {
    logger.info(`[custom-vault] vault ${customVaultId} is ${vault.status}, skipping`)
    return
  }

  const wallet = vault.subWallet
  if (!wallet) {
    logger.error(`[custom-vault] no sub-wallet for vault ${customVaultId}`)
    return
  }

  // ─── 1. Live valuations ────────────────────────────────────────────
  let live: Awaited<ReturnType<typeof getLiveHoldings>> | null = null
  try {
    live = await getLiveHoldings(wallet.address)
  } catch (err) {
    logger.error(`[custom-vault] live-read failed for ${wallet.address.slice(0, 8)}: ${err}`)
    return // Can't rebalance without valuations
  }

  const liveByMint = new Map<string, number>()
  if (live) for (const h of live.holdings) liveByMint.set(h.tokenMint, h.valueSol)

  let totalValueSol = live.nativeSol
  for (const h of wallet.holdings) {
    const liveVal = liveByMint.get(h.tokenMint)
    totalValueSol += liveVal ?? Number(h.valueSolEst ?? 0)
  }

  if (totalValueSol <= 0) {
    logger.info(`[custom-vault] vault ${customVaultId} has no value, skipping`)
    return
  }

  // ─── 2. Compute equal-weight targets ───────────────────────────────
  // BAGSX gets fixed 10%, remainder split equally among vault tokens.
  const allMints = [...new Set([...vault.tokenMints, BAGSX_MINT])]
  const nonBagsxMints = allMints.filter((m) => m !== BAGSX_MINT)
  const bagsxWeight = BAGSX_WEIGHT_PCT / 100
  const remainingWeight = 1 - bagsxWeight
  const perTokenWeight = nonBagsxMints.length > 0 ? remainingWeight / nonBagsxMints.length : 0

  const targetWeights = new Map<string, number>()
  targetWeights.set(BAGSX_MINT, bagsxWeight)
  for (const mint of nonBagsxMints) {
    targetWeights.set(mint, perTokenWeight)
  }

  // Current allocations by value
  const currentAllocations = new Map<string, number>()
  for (const h of wallet.holdings) {
    const val = liveByMint.get(h.tokenMint) ?? Number(h.valueSolEst ?? 0)
    currentAllocations.set(h.tokenMint, val / totalValueSol)
  }

  logger.info(
    `[custom-vault] vault=${customVaultId} value=${totalValueSol.toFixed(4)} SOL, ${nonBagsxMints.length} tokens + BAGSX, target=${(perTokenWeight * 100).toFixed(1)}% each`,
  )

  // ─── 3. Sell overweight positions ──────────────────────────────────
  let sellCount = 0
  for (const holding of wallet.holdings) {
    const target = targetWeights.get(holding.tokenMint) ?? 0
    const current = currentAllocations.get(holding.tokenMint) ?? 0
    const diff = current - target

    // Sell positions not in the target set entirely, or trim overweight by >2%
    if (diff <= 0.02 && target > 0) continue
    if (Number(holding.amount) <= 0) continue

    const sellRatio = target === 0 ? 1 : diff / current
    const tokensToSell = BigInt(Math.floor(Number(holding.amount) * sellRatio))
    if (tokensToSell <= 0n) continue

    const excessSol = diff * totalValueSol
    const proportionalCost = Number(holding.costBasisSol) * sellRatio

    try {
      const { txBytes, quote, route } = await buildSellTransaction({
        tokenMint: holding.tokenMint,
        tokenAmount: tokensToSell,
        userPublicKey: wallet.address,
      })

      const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL
      const realized = solOut - proportionalCost

      await db.holding.update({
        where: { id: holding.id },
        data: {
          amount: { decrement: tokensToSell },
          valueSolEst: { decrement: excessSol },
          costBasisSol: { decrement: proportionalCost },
          totalSoldSol: { increment: solOut },
          realizedPnlSol: { increment: realized },
        },
      })

      const signed = await signVersionedTxBytes({
        walletId: wallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirm(signed)

      await db.swapExecution.create({
        data: {
          subWalletId: wallet.id,
          inputMint: holding.tokenMint,
          outputMint: SOL_MINT,
          inputAmount: tokensToSell,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })
      sellCount++
      logger.info(`[custom-vault] sold ${holding.tokenMint.slice(0, 8)}: ${solOut.toFixed(4)} SOL`)
    } catch (err) {
      logger.error(`[custom-vault] sell failed ${holding.tokenMint.slice(0, 8)}: ${err}`)
    }
  }

  // ─── 4. Buy underweight positions ──────────────────────────────────
  let buyCount = 0
  for (const [tokenMint, targetWeight] of targetWeights) {
    if (tokenMint === SOL_MINT) continue
    const currentWeight = currentAllocations.get(tokenMint) ?? 0
    const diff = targetWeight - currentWeight
    if (diff <= 0) continue

    const desiredSol = diff * totalValueSol
    const desiredLamports = BigInt(Math.floor(desiredSol * LAMPORTS_PER_SOL))
    if (desiredLamports <= 0n) continue

    const liqCapped = await capInputToLiquidity(tokenMint, desiredLamports)
    const currentNativeLamports = await getNativeSolBalanceLamports(wallet.address)
    const reserveLamports = BigInt(Math.floor(WALLET_RESERVE_SOL * LAMPORTS_PER_SOL))
    const deployable =
      currentNativeLamports > reserveLamports ? currentNativeLamports - reserveLamports : 0n
    const buyLamports = liqCapped > deployable ? deployable : liqCapped
    if (buyLamports <= 0n) continue

    const actualSol = Number(buyLamports) / LAMPORTS_PER_SOL

    const executeBuy = async (slippageBps?: number) => {
      const { txBytes, quote, route } = await buildBuyTransaction({
        tokenMint,
        solAmount: buyLamports,
        userPublicKey: wallet.address,
        ...(slippageBps ? { slippageBps } : {}),
      })

      await db.holding.upsert({
        where: { subWalletId_tokenMint: { subWalletId: wallet.id, tokenMint } },
        update: {
          amount: { increment: BigInt(quote.outAmount) },
          valueSolEst: { increment: actualSol },
          costBasisSol: { increment: actualSol },
          totalBoughtSol: { increment: actualSol },
        },
        create: {
          subWalletId: wallet.id,
          tokenMint,
          amount: BigInt(quote.outAmount),
          valueSolEst: actualSol,
          costBasisSol: actualSol,
          totalBoughtSol: actualSol,
        },
      })

      const signed = await signVersionedTxBytes({
        walletId: wallet.privyWalletId,
        txBytes,
      })
      const sig = await submitAndConfirm(signed)

      await db.swapExecution.create({
        data: {
          subWalletId: wallet.id,
          inputMint: SOL_MINT,
          outputMint: tokenMint,
          inputAmount: buyLamports,
          outputAmount: BigInt(quote.outAmount),
          slippageBps: quote.slippageBps,
          route,
          status: 'CONFIRMED',
          txSignature: sig,
        },
      })
      return sig
    }

    try {
      await executeBuy()
      buyCount++
      logger.info(`[custom-vault] bought ${tokenMint.slice(0, 8)}: ${actualSol.toFixed(4)} SOL`)
    } catch (err) {
      logger.info(`[custom-vault] buy failed ${tokenMint.slice(0, 8)} (default), retrying 15%: ${err}`)
      try {
        await executeBuy(1500)
        buyCount++
        logger.info(`[custom-vault] buy succeeded on 15% retry: ${tokenMint.slice(0, 8)}`)
      } catch (retryErr) {
        logger.error(`[custom-vault] buy failed ${tokenMint.slice(0, 8)} even at 15%: ${retryErr}`)
      }
    }
  }

  // ─── 5. Reconcile & update ─────────────────────────────────────────
  try {
    await reconcileSubWalletHoldings(wallet.id, wallet.address)
  } catch (err) {
    logger.error(`[custom-vault] reconcile failed: ${err}`)
  }

  await db.customVault.update({
    where: { id: customVaultId },
    data: { lastRebalancedAt: new Date() },
  })

  const ms = Date.now() - started
  logger.info(
    `[custom-vault] done vault=${customVaultId} in ${ms}ms — sells=${sellCount} buys=${buyCount}`,
  )
  return { sellCount, buyCount }
}

export function createCustomVaultRebalanceWorker() {
  const worker = new Worker(QUEUE_CUSTOM_VAULT_REBALANCE, processCustomVaultRebalance, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[custom-vault] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[custom-vault] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

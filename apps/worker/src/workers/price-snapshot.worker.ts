import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { getBagsSolValue, getMintDecimalsBatch } from '@bags-index/solana'
import { QUEUE_PRICE_SNAPSHOT, LAMPORTS_PER_SOL } from '@bags-index/shared'
import { redis } from '../queue/redis.js'

/**
 * Hourly price-snapshot worker.
 *
 * Valuation source: Bags `/trade/quote` (inputMint=holding, outputMint=wSOL).
 * The response's `outAmount` is the SOL liquidation value in lamports, so
 * we don't need token decimals or a separate USD-price step — it's the
 * exact amount of SOL we'd receive if we sold the holding right now.
 *
 * For every SubWallet with at least one Holding we:
 *   1. Quote each holding's amount → wSOL via Bags
 *   2. Update `Holding.valueSolEst`
 *   3. Write a `PnlSnapshot` row per wallet
 *
 * Runs on a BullMQ repeatable every hour.
 */
export async function processSnapshot(_job?: Job) {
  const started = Date.now()
  const logger = { info: console.log, error: console.error }
  logger.info('[price-snapshot] starting cycle')

  const wallets = await db.subWallet.findMany({ include: { holdings: true } })
  const activeWallets = wallets.filter((w) => w.holdings.length > 0)
  if (activeWallets.length === 0) {
    logger.info('[price-snapshot] no wallets with holdings — skipping')
    return { snapshotsWritten: 0 }
  }

  // Cache quotes by `${mint}:${amount}` — if two wallets hold the exact same
  // amount of the same mint, reuse one call.
  const quoteCache = new Map<string, bigint | null>()
  async function quoteSol(mint: string, amount: string): Promise<bigint | null> {
    const key = `${mint}:${amount}`
    if (quoteCache.has(key)) return quoteCache.get(key)!
    const val = await getBagsSolValue(mint, amount)
    quoteCache.set(key, val)
    // Be polite to the Bags API — 1000 req/hr rate limit
    await new Promise((r) => setTimeout(r, 100))
    return val
  }

  let updatedHoldings = 0
  let snapshotsWritten = 0
  let mintsMissing = 0

  for (const wallet of activeWallets) {
    let totalValueSol = 0
    let totalCostSol = 0
    let realizedSol = 0

    for (const h of wallet.holdings) {
      const amount = h.amount?.toString() ?? '0'
      if (amount === '0') {
        totalCostSol += Number(h.costBasisSol ?? 0)
        realizedSol += Number(h.realizedPnlSol ?? 0)
        continue
      }

      const lamports = await quoteSol(h.tokenMint, amount)
      if (lamports === null) {
        mintsMissing++
        // Preserve prior value rather than zeroing it
        totalValueSol += Number(h.valueSolEst ?? 0)
        totalCostSol += Number(h.costBasisSol ?? 0)
        realizedSol += Number(h.realizedPnlSol ?? 0)
        continue
      }

      const valueSol = Number(lamports) / LAMPORTS_PER_SOL
      totalValueSol += valueSol
      totalCostSol += Number(h.costBasisSol ?? 0)
      realizedSol += Number(h.realizedPnlSol ?? 0)

      await db.holding.update({
        where: { id: h.id },
        data: { valueSolEst: valueSol.toFixed(9) },
      })
      updatedHoldings++
    }

    const unrealizedSol = totalValueSol - totalCostSol

    await db.pnlSnapshot.create({
      data: {
        subWalletId: wallet.id,
        totalValueSol: totalValueSol.toFixed(9),
        totalCostSol: totalCostSol.toFixed(9),
        realizedSol: realizedSol.toFixed(9),
        unrealizedSol: unrealizedSol.toFixed(9),
      },
    })
    snapshotsWritten++
  }

  // ─── Per-token price samples ──────────────────────────────────────────
  // Collect unique mints currently held, quote "1 whole token → SOL" for
  // each, and store one TokenPriceSnapshot row per mint. Drives the
  // per-token line chart on user/admin dashboards.
  try {
    const uniqueMints = new Set<string>()
    for (const w of activeWallets) for (const h of w.holdings) uniqueMints.add(h.tokenMint)

    // Also sample every token that has been in a tier top-10 during the last
    // 14 days. This (a) pre-populates the landing-page chart for tiers with
    // no live users yet, and (b) keeps individual lines from cutting off
    // mid-chart when a token gets rotated out of the index — they keep
    // streaming for a 14d tail window so the constituent lines stay visible.
    const tailStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const recentScores = await db.tokenScore.findMany({
      where: {
        isBlacklisted: false,
        rank: { gte: 1, lte: 10 },
        scoredAt: { gte: tailStart },
      },
      select: { tokenMint: true },
    })
    for (const s of recentScores) uniqueMints.add(s.tokenMint)

    const mintList = [...uniqueMints]
    if (mintList.length > 0) {
      const decimals = await getMintDecimalsBatch(mintList)
      let priceWrites = 0
      for (const mint of mintList) {
        const dec = decimals.get(mint)
        if (dec === undefined) continue
        // One whole token in base units
        const probe = (10n ** BigInt(dec)).toString()
        const lamports = await getBagsSolValue(mint, probe)
        if (lamports === null) continue
        const priceSol = Number(lamports) / LAMPORTS_PER_SOL
        await db.tokenPriceSnapshot.create({
          data: { tokenMint: mint, priceSol: priceSol.toFixed(12) },
        })
        priceWrites++
        await new Promise((r) => setTimeout(r, 100))
      }
      logger.info(`[price-snapshot] wrote ${priceWrites} token price samples`)
    }
  } catch (err) {
    logger.error(`[price-snapshot] per-token sampling failed: ${err}`)
  }

  const ms = Date.now() - started
  logger.info(
    `[price-snapshot] done in ${ms}ms — wallets=${snapshotsWritten} holdings=${updatedHoldings} missing=${mintsMissing} quotes=${quoteCache.size}`,
  )
  return { snapshotsWritten, updatedHoldings, mintsMissing }
}

export function createPriceSnapshotWorker() {
  const worker = new Worker(QUEUE_PRICE_SNAPSHOT, processSnapshot, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[price-snapshot] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[price-snapshot] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

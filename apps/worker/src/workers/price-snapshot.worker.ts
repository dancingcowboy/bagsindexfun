import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getBagsSolValue,
  getMintDecimalsBatch,
  getJupiterPrices,
  getDexVolumes,
  getLiveHoldings,
} from '@bags-index/solana'
import { SOL_MINT, BAGSX_MINT } from '@bags-index/shared'
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

  let updatedHoldings = 0
  let snapshotsWritten = 0
  let mintsMissing = 0

  for (const wallet of activeWallets) {
    let totalCostSol = wallet.holdings.reduce((s, h) => s + Number(h.costBasisSol ?? 0), 0)
    let realizedSol = Number(wallet.realizedPnlSol ?? 0)
    let totalValueSol = 0

    // Use live read-through so every holding picks up the Bags → Dex →
    // Jupiter fallback. Previously we called Bags directly per holding,
    // which silently returned null for tokens with no Bags route and
    // left `valueSolEst` stale, understating the vault's real value.
    let live: Awaited<ReturnType<typeof getLiveHoldings>> | null = null
    try {
      live = await getLiveHoldings(wallet.address)
    } catch (err) {
      logger.error(`[price-snapshot] live-read failed for ${wallet.address.slice(0, 8)}: ${err}`)
    }

    const liveByMint = new Map<string, number>()
    if (live) for (const h of live.holdings) liveByMint.set(h.tokenMint, h.valueSol)

    for (const h of wallet.holdings) {
      const amount = h.amount?.toString() ?? '0'
      if (amount === '0') continue

      const liveVal = liveByMint.get(h.tokenMint)
      if (liveVal === undefined) {
        mintsMissing++
        // Preserve prior DB value rather than zeroing it
        totalValueSol += Number(h.valueSolEst ?? 0)
        continue
      }

      totalValueSol += liveVal
      await db.holding.update({
        where: { id: h.id },
        data: { valueSolEst: liveVal.toFixed(9) },
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

    // Always sample the platform token ($BAGSX) — every vault holds 10%
    // exposure to it, so the chart needs a continuous price series.
    uniqueMints.add(BAGSX_MINT)

    const mintList = [...uniqueMints]
    if (mintList.length > 0) {
      const decimals = await getMintDecimalsBatch(mintList)

      // Fallback price sources for tokens with no Bags route (common for
      // DEGEN tier). We try Bags first (the hackathon target), then
      // DexScreener (best general coverage on Solana memes), then Jupiter.
      // USD prices are converted to SOL via SOL/USD from Jupiter.
      const [dexPrices, jupPrices] = await Promise.all([
        getDexVolumes(mintList),
        getJupiterPrices([...mintList, SOL_MINT]),
      ])
      const solUsd = Number(jupPrices.get(SOL_MINT)?.usdPrice ?? 0)

      let priceWrites = 0
      let bagsHits = 0
      let dexHits = 0
      let jupHits = 0
      for (const mint of mintList) {
        let priceSol: number | null = null

        const dec = decimals.get(mint)
        if (dec !== undefined) {
          const probe = (10n ** BigInt(dec)).toString()
          const lamports = await getBagsSolValue(mint, probe)
          if (lamports !== null) {
            priceSol = Number(lamports) / LAMPORTS_PER_SOL
            bagsHits++
          }
          await new Promise((r) => setTimeout(r, 100))
        }

        if (priceSol === null && solUsd > 0) {
          const usd = Number(dexPrices.get(mint)?.priceUsd ?? 0)
          if (usd > 0) {
            priceSol = usd / solUsd
            dexHits++
          }
        }

        if (priceSol === null && solUsd > 0) {
          const usd = Number(jupPrices.get(mint)?.usdPrice ?? 0)
          if (usd > 0) {
            priceSol = usd / solUsd
            jupHits++
          }
        }

        if (priceSol === null) continue
        await db.tokenPriceSnapshot.create({
          data: { tokenMint: mint, priceSol: priceSol.toFixed(12) },
        })
        priceWrites++
      }
      logger.info(
        `[price-snapshot] wrote ${priceWrites} token price samples (bags=${bagsHits} dex=${dexHits} jup=${jupHits})`,
      )
    }
  } catch (err) {
    logger.error(`[price-snapshot] per-token sampling failed: ${err}`)
  }

  const ms = Date.now() - started
  logger.info(
    `[price-snapshot] done in ${ms}ms — wallets=${snapshotsWritten} holdings=${updatedHoldings} missing=${mintsMissing}`,
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

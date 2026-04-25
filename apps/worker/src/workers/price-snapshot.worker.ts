import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getDexVolumes,
  priceHoldingsFromDex,
  getNativeSolBalance,
} from '@bags-index/solana'
import { SOL_MINT, BAGSX_MINT } from '@bags-index/shared'
import { QUEUE_PRICE_SNAPSHOT } from '@bags-index/shared'
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

  let updatedHoldings = 0
  let snapshotsWritten = 0
  let mintsMissing = 0

  for (const wallet of activeWallets) {
    let totalCostSol = wallet.holdings.reduce((s, h) => s + Number(h.costBasisSol ?? 0), 0)
    let realizedSol = Number(wallet.realizedPnlSol ?? 0)
    let totalValueSol = 0

    // Re-price DB holdings via DexScreener only (no Helius /balances).
    // Post-swap reconcile is the single source of truth for amounts and
    // decimals; we only fetch live prices here.
    const priced = await priceHoldingsFromDex(
      wallet.holdings.map((h) => ({
        tokenMint: h.tokenMint,
        amount: h.amount,
        decimals: h.decimals,
      })),
    ).catch((err) => {
      logger.error(`[price-snapshot] DexScreener re-price failed for ${wallet.address.slice(0, 8)}: ${err}`)
      return new Map<string, { valueSol: number; source: string }>() as any
    })

    for (const h of wallet.holdings) {
      const amount = h.amount?.toString() ?? '0'
      if (amount === '0') continue

      const p = priced.get(h.tokenMint)
      if (!p || p.source === 'none') {
        mintsMissing++
        // Preserve prior DB value rather than zeroing it
        totalValueSol += Number(h.valueSolEst ?? 0)
        continue
      }

      // Outlier guard: if the new valuation jumps >10x or drops <0.1x from
      // the DB estimate, DexScreener likely returned a bogus priceNative
      // (e.g. from a dead/scam pair). Keep the old estimate instead.
      const prevEst = Number(h.valueSolEst ?? 0)
      if (prevEst > 0.000001) {
        const ratio = p.valueSol / prevEst
        if (ratio > 10 || ratio < 0.1) {
          logger.info(
            `[price-snapshot] holding outlier skipped ${h.tokenMint.slice(0, 8)}… — prev=${prevEst.toFixed(9)} new=${p.valueSol.toFixed(9)} ratio=${ratio.toFixed(2)}x`,
          )
          totalValueSol += prevEst
          continue
        }
      }

      totalValueSol += p.valueSol
      await db.holding.update({
        where: { id: h.id },
        data: { valueSolEst: p.valueSol.toFixed(9) },
      })
      updatedHoldings++
    }

    // Native SOL sitting in the sub-wallet is real user value (the 12% SOL
    // anchor on CONSERVATIVE, plus any sell proceeds not yet redeployed).
    // getNativeSolBalance uses Helius RPC with public-RPC fallback.
    if (wallet.holdings.length > 0) {
      try {
        totalValueSol += await getNativeSolBalance(wallet.address)
      } catch (err) {
        logger.error(`[price-snapshot] native SOL fetch failed for ${wallet.address.slice(0, 8)}: ${err}`)
      }
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

    // 14-day tail: keeps tokens visible after they rotate out of the index.
    const tailStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const recentScores = await db.tokenScore.findMany({
      where: {
        isBlacklisted: false,
        rank: { gte: 1, lte: 10 },
        scoredAt: { gte: tailStart },
        source: { in: ['BAGS', 'DEXSCREENER'] },
      },
      select: { tokenMint: true },
    })
    for (const s of recentScores) uniqueMints.add(s.tokenMint)

    // Always sample the last KNOWN GOOD cycle per tier, regardless of age.
    // If empty cycles run for >14 days the tail window above would drop those
    // tokens, breaking the chart for the cycle the API falls back to.
    const scoreFilter = { isBlacklisted: false, rank: { gte: 1, lte: 10 } }
    for (const tier of ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const) {
      const lastGoodCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED', source: 'BAGS', tier, scores: { some: scoreFilter } },
        orderBy: { completedAt: 'desc' },
        include: { scores: { where: scoreFilter, select: { tokenMint: true } } },
      })
      if (lastGoodCycle) for (const s of lastGoodCycle.scores) uniqueMints.add(s.tokenMint)
    }

    // Always sample the platform token ($BAGSX) — every vault holds 10%
    // exposure to it, so the chart needs a continuous price series.
    uniqueMints.add(BAGSX_MINT)

    const mintList = [...uniqueMints]
    if (mintList.length > 0) {
      // DexScreener-only pricing: priceNative is direct SOL/token, no
      // Bags router probe and no Helius decimals fetch. Avoids burning
      // Helius credits on the hourly price path.
      const dexPrices = await getDexVolumes([...mintList, SOL_MINT])
      const solUsd = Number(dexPrices.get(SOL_MINT)?.priceUsd ?? 0)
      if (solUsd > 0) logger.info(`[price-snapshot] SOL/USD: $${solUsd.toFixed(2)}`)

      let priceWrites = 0
      let dexHits = 0
      for (const mint of mintList) {
        if (mint === SOL_MINT) continue
        let priceSol: number | null = null

        const native = dexPrices.get(mint)?.priceNative ?? 0
        if (native > 0) {
          priceSol = native
          dexHits++
        } else if (solUsd > 0) {
          const usd = Number(dexPrices.get(mint)?.priceUsd ?? 0)
          if (usd > 0) {
            priceSol = usd / solUsd
            dexHits++
          }
        }

        if (priceSol === null) continue

        // Outlier guard: skip if new price is >10x or <0.1x the most recent snapshot.
        // Prevents bad DexScreener fallback prices on illiquid pools from corrupting valuations.
        const lastSnap = await db.tokenPriceSnapshot.findFirst({
          where: { tokenMint: mint },
          orderBy: { createdAt: 'desc' },
          select: { priceSol: true },
        })
        if (lastSnap) {
          const prev = Number(lastSnap.priceSol)
          if (prev > 0) {
            const ratio = priceSol / prev
            if (ratio > 10 || ratio < 0.1) {
              logger.info(
                `[price-snapshot] outlier skipped ${mint.slice(0, 8)}… — prev=${prev.toFixed(12)} new=${priceSol.toFixed(12)} ratio=${ratio.toFixed(2)}x`,
              )
              continue
            }
          }
        }

        const mc = dexPrices.get(mint)?.marketCapUsd ?? 0
        await db.tokenPriceSnapshot.create({
          data: { tokenMint: mint, priceSol: priceSol.toFixed(12), marketCapUsd: mc },
        })
        priceWrites++
      }
      logger.info(`[price-snapshot] wrote ${priceWrites} token price samples (dex=${dexHits})`)

      // Refresh marketCapUsd on the latest TokenScore for each mint so
      // the dashboard/landing page always show current MC — not just
      // the value captured at scoring time.
      let mcUpdates = 0
      for (const [mint, dex] of dexPrices) {
        if (dex.marketCapUsd <= 0) continue
        const latest = await db.tokenScore.findFirst({
          where: { tokenMint: mint, source: 'BAGS' },
          orderBy: { scoredAt: 'desc' },
          select: { id: true, marketCapUsd: true },
        })
        if (!latest) continue
        if (Number(latest.marketCapUsd) === dex.marketCapUsd) continue
        await db.tokenScore.update({
          where: { id: latest.id },
          data: { marketCapUsd: dex.marketCapUsd },
        })
        mcUpdates++
      }
      if (mcUpdates > 0) {
        logger.info(`[price-snapshot] refreshed marketCapUsd on ${mcUpdates} token scores`)
      }
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

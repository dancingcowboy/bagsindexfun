import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getBagsSolValue,
  getMintDecimalsBatch,
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

    // Native SOL sitting in the sub-wallet is real user value (the 12% SOL
    // anchor on CONSERVATIVE, plus any sell proceeds not yet redeployed).
    // Without this, the PnlSnapshot history understates vault value and
    // every dashboard chart reads low.
    if (live && wallet.holdings.length > 0) {
      totalValueSol += live.nativeSol
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
      // Fetch DexScreener prices first — no Helius RPC, never 429s.
      // priceNative is direct SOL price; no solUsd needed.
      const dexPrices = await getDexVolumes([...mintList, SOL_MINT])
      let solUsd = Number(dexPrices.get(SOL_MINT)?.priceUsd ?? 0)
      if (solUsd <= 0) {
        try {
          const solRes = await fetch(
            'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
            { signal: AbortSignal.timeout(10_000) },
          )
          const solData = await solRes.json() as any
          const pairs: any[] = Array.isArray(solData) ? solData : solData?.pairs ?? []
          if (pairs.length > 0) {
            const best = pairs.reduce((a: any, p: any) =>
              (Number(p?.liquidity?.usd) || 0) > (Number(a?.liquidity?.usd) || 0) ? p : a,
              pairs[0],
            )
            solUsd = Number(best?.priceUsd) || 0
          }
        } catch { /* will skip USD-denominated pricing this cycle */ }
      }
      if (solUsd > 0) logger.info(`[price-snapshot] SOL/USD: $${solUsd.toFixed(2)}`)

      // Decimals are only needed for the Bags router probe. Fetch them but
      // don't let a Helius 429 block DexScreener pricing for everything else.
      let decimals = new Map<string, number>()
      try {
        decimals = await getMintDecimalsBatch(mintList)
      } catch (err) {
        logger.error(`[price-snapshot] getMintDecimalsBatch failed (will use DexScreener only): ${err}`)
      }

      let priceWrites = 0
      let bagsHits = 0
      let dexHits = 0
      for (const mint of mintList) {
        if (mint === SOL_MINT) continue
        let priceSol: number | null = null

        // 1. Bags router — most accurate for native Bags tokens
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

        // 2. DexScreener priceNative (direct SOL, no USD bridge)
        if (priceSol === null) {
          const native = dexPrices.get(mint)?.priceNative ?? 0
          if (native > 0) {
            priceSol = native
            dexHits++
          }
        }

        // 3. DexScreener priceUsd / solUsd fallback
        if (priceSol === null && solUsd > 0) {
          const usd = Number(dexPrices.get(mint)?.priceUsd ?? 0)
          if (usd > 0) {
            priceSol = usd / solUsd
            dexHits++
          }
        }

        if (priceSol === null) continue
        const mc = dexPrices.get(mint)?.marketCapUsd ?? 0
        await db.tokenPriceSnapshot.create({
          data: { tokenMint: mint, priceSol: priceSol.toFixed(12), marketCapUsd: mc },
        })
        priceWrites++
      }
      logger.info(
        `[price-snapshot] wrote ${priceWrites} token price samples (bags=${bagsHits} dex=${dexHits})`,
      )

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

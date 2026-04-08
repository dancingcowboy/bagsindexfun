import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { getDexVolumes, getMintDecimalsBatch, getJupiterPrices } from '@bags-index/solana'
import { QUEUE_PRICE_SNAPSHOT, WSOL_MINT } from '@bags-index/shared'
import { redis } from '../queue/redis.js'

/**
 * Hourly price-snapshot worker.
 *
 * For every SubWallet with at least one Holding:
 *   1. Fetch current USD prices from DexScreener (more reliable for low-cap
 *      Bags tokens than Jupiter). Falls back to Jupiter for anything missing.
 *   2. Resolve token decimals in a single batch RPC call.
 *   3. Recalculate `Holding.valueSolEst` from live prices.
 *   4. Write a `PnlSnapshot` row per wallet.
 *
 * Runs on a BullMQ repeatable every hour. Snapshot history drives the
 * per-vault PnL line chart in the dashboard.
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

  // Unique mint set (plus wSOL for the SOL→USD reference price)
  const mints = new Set<string>([WSOL_MINT])
  for (const w of activeWallets) for (const h of w.holdings) mints.add(h.tokenMint)
  const mintList = [...mints]

  // Prices: DexScreener first, Jupiter fallback for anything missing
  const dex = await getDexVolumes(mintList)
  const missing = mintList.filter((m) => !(dex.get(m)?.priceUsd))
  const jup = missing.length ? await getJupiterPrices(missing) : new Map()

  const priceUsdByMint = new Map<string, number>()
  for (const [m, v] of dex) if (v.priceUsd > 0) priceUsdByMint.set(m, v.priceUsd)
  for (const [m, v] of jup) if (!priceUsdByMint.has(m) && v.usdPrice > 0) priceUsdByMint.set(m, v.usdPrice)

  const solUsd = priceUsdByMint.get(WSOL_MINT)
  if (!solUsd || solUsd <= 0) {
    logger.error('[price-snapshot] no SOL/USD price — aborting')
    return { snapshotsWritten: 0 }
  }

  // Decimals in one batched RPC call
  const decimals = await getMintDecimalsBatch(mintList.filter((m) => m !== WSOL_MINT))

  let updatedHoldings = 0
  let snapshotsWritten = 0
  let mintsMissing = 0

  for (const wallet of activeWallets) {
    let totalValueSol = 0
    let totalCostSol = 0
    let realizedSol = 0

    for (const h of wallet.holdings) {
      const priceUsd = priceUsdByMint.get(h.tokenMint)
      const dec = decimals.get(h.tokenMint)
      if (!priceUsd || dec === undefined) {
        mintsMissing++
        // Preserve prior value instead of zeroing out
        totalValueSol += Number(h.valueSolEst ?? 0)
        totalCostSol += Number(h.costBasisSol ?? 0)
        realizedSol += Number(h.realizedPnlSol ?? 0)
        continue
      }
      const whole = Number(h.amount) / 10 ** dec
      const valueSol = (whole * priceUsd) / solUsd
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

  const ms = Date.now() - started
  logger.info(
    `[price-snapshot] done in ${ms}ms — wallets=${snapshotsWritten} holdings=${updatedHoldings} missing=${mintsMissing} SOL/USD=${solUsd.toFixed(3)}`,
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

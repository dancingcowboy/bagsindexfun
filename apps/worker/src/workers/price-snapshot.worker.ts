import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { getJupiterPrices } from '@bags-index/solana'
import { QUEUE_PRICE_SNAPSHOT, WSOL_MINT } from '@bags-index/shared'
import { redis } from '../queue/redis.js'

/**
 * Hourly price-snapshot worker.
 *
 * For every SubWallet with at least one Holding:
 *   1. Fetch current USD prices for all held mints + wrapped SOL
 *   2. Recalculate `Holding.valueSolEst` from live prices
 *   3. Write a `PnlSnapshot` row (totalValueSol + cost basis aggregates)
 *
 * Runs on a BullMQ repeatable every hour. Snapshot history drives the
 * per-vault PnL line chart in the dashboard.
 */
async function processSnapshot(_job: Job) {
  const started = Date.now()
  const logger = { info: console.log, error: console.error }
  logger.info('[price-snapshot] starting cycle')

  // 1. Collect every wallet + holding
  const wallets = await db.subWallet.findMany({
    include: { holdings: true },
  })
  const activeWallets = wallets.filter((w) => w.holdings.length > 0)
  if (activeWallets.length === 0) {
    logger.info('[price-snapshot] no wallets with holdings — skipping')
    return
  }

  // 2. Unique mint set (plus wSOL for the SOL→USD conversion)
  const mints = new Set<string>([WSOL_MINT])
  for (const w of activeWallets) for (const h of w.holdings) mints.add(h.tokenMint)

  // 3. Fetch prices
  const prices = await getJupiterPrices([...mints])
  const solUsd = prices.get(WSOL_MINT)?.usdPrice
  if (!solUsd || solUsd <= 0) {
    logger.error('[price-snapshot] no SOL/USD price — aborting')
    return
  }

  let updatedHoldings = 0
  let snapshotsWritten = 0
  let mintsMissing = 0

  // 4. Process each wallet
  for (const wallet of activeWallets) {
    let totalValueSol = 0
    let totalCostSol = 0
    let realizedSol = 0

    for (const h of wallet.holdings) {
      const info = prices.get(h.tokenMint)
      if (!info) {
        // No Jupiter route — keep previous value, don't zero it out
        mintsMissing++
        totalValueSol += Number(h.valueSolEst ?? 0)
        totalCostSol += Number(h.costBasisSol ?? 0)
        realizedSol += Number(h.realizedPnlSol ?? 0)
        continue
      }
      const whole = Number(h.amount) / 10 ** info.decimals
      const valueSol = (whole * info.usdPrice) / solUsd
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

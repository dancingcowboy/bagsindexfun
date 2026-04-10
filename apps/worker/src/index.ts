import 'dotenv/config'
import { Queue } from 'bullmq'
import {
  QUEUE_SCORING,
  QUEUE_ANALYSIS,
  QUEUE_FEE_CLAIM,
  QUEUE_PRICE_SNAPSHOT,
  FEE_CLAIM_INTERVAL_HOURS,
} from '@bags-index/shared'
import { redis } from './queue/redis.js'
import { createScoringWorker } from './workers/scoring.worker.js'
import { createDepositWorker } from './workers/deposit.worker.js'
import { createWithdrawalWorker } from './workers/withdrawal.worker.js'
import { createRebalanceWorker } from './workers/rebalance.worker.js'
import { createAnalysisWorker } from './workers/analysis.worker.js'
import { createFeeClaimWorker } from './workers/fee-claim.worker.js'
import { createPriceSnapshotWorker } from './workers/price-snapshot.worker.js'
import { createSwitchWorker } from './workers/switch.worker.js'
import { startTweetPoller, stopTweetPoller } from './workers/tweet-poller.js'

console.log('[worker] Starting bags-index workers...')

// Start all workers
const scoringWorker = createScoringWorker()
const depositWorker = createDepositWorker()
const withdrawalWorker = createWithdrawalWorker()
const rebalanceWorker = createRebalanceWorker()
const analysisWorker = createAnalysisWorker()
const feeClaimWorker = createFeeClaimWorker()
const priceSnapshotWorker = createPriceSnapshotWorker()
const switchWorker = createSwitchWorker()

// Per-tier scoring on offset intervals — DEGEN every 4h23m, BALANCED every
// 12h08m, CONSERVATIVE every 23h23m. Offsets stagger the three tiers so they
// rarely fire together; combined with rebalance batching this lets the system
// scale comfortably past 100 wallets without overlapping load on Bags API.
const scoringQueue = new Queue(QUEUE_SCORING, { connection: redis })
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000
// Remove the legacy "score everything once a day" scheduler if it still exists
try {
  await scoringQueue.removeJobScheduler('daily-scoring')
} catch {
  /* fine if it didn't exist */
}
await scoringQueue.upsertJobScheduler(
  'tier-scoring-DEGEN',
  { every: 4 * HOUR_MS + 23 * MIN_MS },
  { name: 'tier-scoring-DEGEN', data: { tier: 'DEGEN' } },
)
await scoringQueue.upsertJobScheduler(
  'tier-scoring-BALANCED',
  { every: 12 * HOUR_MS + 8 * MIN_MS },
  { name: 'tier-scoring-BALANCED', data: { tier: 'BALANCED' } },
)
await scoringQueue.upsertJobScheduler(
  'tier-scoring-CONSERVATIVE',
  { every: 23 * HOUR_MS + 23 * MIN_MS },
  { name: 'tier-scoring-CONSERVATIVE', data: { tier: 'CONSERVATIVE' } },
)

// Schedule daily AI analysis at 00:30 UTC (after scoring completes)
const analysisQueue = new Queue(QUEUE_ANALYSIS, { connection: redis })
await analysisQueue.upsertJobScheduler(
  'daily-analysis',
  { pattern: '30 0 * * *' },
  { name: 'daily-analysis' }
)

// Schedule vault fee auto-claim every FEE_CLAIM_INTERVAL_HOURS hours
const feeClaimQueue = new Queue(QUEUE_FEE_CLAIM, { connection: redis })
await feeClaimQueue.upsertJobScheduler(
  'vault-fee-claim',
  { pattern: `0 */${FEE_CLAIM_INTERVAL_HOURS} * * *` },
  { name: 'vault-fee-claim' },
)

// Schedule hourly price snapshots (for per-vault PnL history charts)
const priceSnapshotQueue = new Queue(QUEUE_PRICE_SNAPSHOT, { connection: redis })
await priceSnapshotQueue.upsertJobScheduler(
  'hourly-price-snapshot',
  { pattern: '0 * * * *' },
  { name: 'hourly-price-snapshot' },
)

// Start the X campaign tweet poller (60s tick, 50min min gap)
startTweetPoller()

console.log(
  `[worker] All workers started. Scoring 00:00 UTC, AI analysis 00:30 UTC, vault fee-claim every ${FEE_CLAIM_INTERVAL_HOURS}h, tweet poller running.`,
)

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('[worker] Shutting down...')
  stopTweetPoller()
  await Promise.all([
    scoringWorker.close(),
    depositWorker.close(),
    withdrawalWorker.close(),
    rebalanceWorker.close(),
    analysisWorker.close(),
    feeClaimWorker.close(),
    priceSnapshotWorker.close(),
    switchWorker.close(),
  ])
  await redis.quit()
  process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

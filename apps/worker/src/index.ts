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
import { createBurnWorker } from './workers/burn.worker.js'
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
const burnWorker = createBurnWorker()
const analysisWorker = createAnalysisWorker()
const feeClaimWorker = createFeeClaimWorker()
const priceSnapshotWorker = createPriceSnapshotWorker()
const switchWorker = createSwitchWorker()

// Schedule daily scoring at 00:00 UTC
const scoringQueue = new Queue(QUEUE_SCORING, { connection: redis })
await scoringQueue.upsertJobScheduler(
  'daily-scoring',
  { pattern: '0 0 * * *' },
  { name: 'daily-scoring' }
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
    burnWorker.close(),
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

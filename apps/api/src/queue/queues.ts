import { Queue } from 'bullmq'
import { redis } from './redis.js'
import {
  QUEUE_SCORING,
  QUEUE_REBALANCE,
  QUEUE_DEPOSIT,
  QUEUE_WITHDRAWAL,
  QUEUE_PRICE_SNAPSHOT,
  QUEUE_SWITCH,
  QUEUE_VAULT_SWITCH,
} from '@bags-index/shared'

const defaultOpts = { connection: redis }

export const scoringQueue = new Queue(QUEUE_SCORING, defaultOpts)
export const rebalanceQueue = new Queue(QUEUE_REBALANCE, defaultOpts)
export const depositQueue = new Queue(QUEUE_DEPOSIT, defaultOpts)
export const withdrawalQueue = new Queue(QUEUE_WITHDRAWAL, defaultOpts)
export const priceSnapshotQueue = new Queue(QUEUE_PRICE_SNAPSHOT, defaultOpts)
export const switchQueue = new Queue(QUEUE_SWITCH, defaultOpts)
export const vaultSwitchQueue = new Queue(QUEUE_VAULT_SWITCH, defaultOpts)

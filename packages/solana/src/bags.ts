import axios from 'axios'
import { BAGS_API_BASE } from '@bags-index/shared'
import type { BagsTokenFeedItem, BagsTradeQuote, BagsSwapResponse } from '@bags-index/shared'

function getClient() {
  const apiKey = process.env.BAGS_API_KEY
  if (!apiKey) throw new Error('BAGS_API_KEY is required')
  return axios.create({
    baseURL: BAGS_API_BASE,
    headers: { 'x-api-key': apiKey },
    timeout: 15_000,
  })
}

/**
 * Fetch the token launch feed from Bags.
 * Returns all tokens; filter by status === 'MIGRATED' for tradeable tokens.
 */
export async function getTokenFeed(): Promise<BagsTokenFeedItem[]> {
  const client = getClient()
  const res = await client.get('/token-launch/feed')
  return res.data.response ?? res.data
}

/**
 * Fetch the full Bags pools list. With `onlyMigrated=true` returns only pools
 * that have graduated to DAMM v2 (tradeable on AMM rails). The endpoint has no
 * pagination — it returns the entire universe in one shot.
 */
export interface BagsPool {
  tokenMint: string
  dbcConfigKey: string
  dbcPoolKey: string
  dammV2PoolKey: string | null
}
export async function getBagsPools(onlyMigrated = true): Promise<BagsPool[]> {
  const client = getClient()
  const res = await client.get('/solana/bags/pools', { params: { onlyMigrated } })
  const data = res.data.response ?? res.data
  return Array.isArray(data) ? data : []
}

/**
 * Get a swap quote from Bags trade API.
 */
export async function getTradeQuote(params: {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps?: number
  slippageMode?: 'auto' | 'manual'
}): Promise<BagsTradeQuote> {
  const client = getClient()
  const res = await client.get('/trade/quote', { params })
  return res.data.response ?? res.data
}

/**
 * Get a signed swap transaction from Bags trade API.
 * Returns a base58-encoded VersionedTransaction ready for signing.
 */
export async function getSwapTransaction(params: {
  quoteResponse: BagsTradeQuote
  userPublicKey: string
}): Promise<BagsSwapResponse> {
  const client = getClient()
  const res = await client.post('/trade/swap', params)
  return res.data.response ?? res.data
}

// ─── Fee claiming ───────────────────────────────────────────────────────────

export interface ClaimablePosition {
  baseMint: string
  quoteMint: string
  totalClaimableLamportsUserShare: string
  claimableDisplayAmount: string
  isMigrated: boolean
  userBps: number
  claimerIndex: number
}

/**
 * Read accrued (unclaimed) trading fees for a wallet across every Bags token
 * it is registered as a fee-share recipient on. Returns one entry per token.
 * Use `totalClaimableLamportsUserShare > 0` to gate claim calls.
 */
export async function getClaimablePositions(
  wallet: string
): Promise<ClaimablePosition[]> {
  const client = getClient()
  const res = await client.get('/token-launch/claimable-positions', {
    params: { wallet },
  })
  const data = res.data.response ?? res.data
  return Array.isArray(data) ? data : []
}

export interface ClaimTransaction {
  tx: string // base58-encoded VersionedTransaction
  blockhash: { blockhash: string; lastValidBlockHeight: number }
}

/**
 * Build the unsigned claim transaction(s) for a (wallet, tokenMint) pair.
 * Bags may return multiple txs if the token has both a virtual-pool and a
 * DAMM-pool fee leg. Each tx must be deserialized, signed by `feeClaimer`,
 * and submitted via Helius (use sendJitoProtected).
 */
export async function buildClaimFeeTransactions(params: {
  feeClaimer: string
  tokenMint: string
}): Promise<ClaimTransaction[]> {
  const client = getClient()
  const res = await client.post('/token-launch/claim-txs/v3', params)
  const data = res.data.response ?? res.data
  return Array.isArray(data) ? data : []
}

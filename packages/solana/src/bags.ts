import axios from 'axios'
import { BAGS_API_BASE } from '@bags-index/shared'
import type { BagsTokenFeedItem, BagsTradeQuote, BagsSwapResponse } from '@bags-index/shared'

// Shared across all getClient() calls in this process. When Bags returns a
// 429 with remaining:0, we stash the reset time here so every subsequent
// request fails fast instead of burning another round-trip + retry storm.
let bagsQuotaDrainedUntil = 0

function getClient() {
  const apiKey = process.env.BAGS_API_KEY
  if (!apiKey) throw new Error('BAGS_API_KEY is required')
  const client = axios.create({
    baseURL: BAGS_API_BASE,
    headers: { 'x-api-key': apiKey },
    timeout: 15_000,
  })
  // Bags enforces a hard 1000 req/hour quota that resets at the top of each
  // hour. The 429 body carries `{ limit, remaining, resetTime }` — no
  // Retry-After header. Strategy:
  //   - If `remaining === 0`, the bucket is drained. Don't retry; throw fast
  //     so callers fail loud instead of amplifying the burn 5x.
  //   - For 5xx (and 429 without a drained body, e.g. transient), do up to
  //     2 quick retries with jittered backoff.
  // Also tracks a cached reset timestamp so once we're drained, subsequent
  // calls short-circuit without even hitting the network.
  client.interceptors.response.use(
    (res) => res,
    async (err) => {
      const cfg: any = err.config
      if (!cfg) throw err
      const status = err.response?.status
      const body = err.response?.data
      if (status === 429) {
        // Remember the reset so future callers fail fast.
        if (body?.resetTime) {
          bagsQuotaDrainedUntil = new Date(body.resetTime).getTime()
        }
        // Quota drained → no point retrying.
        if (body?.remaining === 0) throw err
      }
      const retriable = status === 429 || (status >= 500 && status < 600)
      if (!retriable) throw err
      cfg.__bagsRetry = (cfg.__bagsRetry ?? 0) + 1
      if (cfg.__bagsRetry > 2) throw err
      const base = 1000 * Math.pow(2, cfg.__bagsRetry - 1)
      const wait = base + Math.floor(Math.random() * 400)
      await new Promise((r) => setTimeout(r, wait))
      return client.request(cfg)
    },
  )
  // Pre-flight: if we know the quota is drained, fail immediately.
  client.interceptors.request.use((cfg) => {
    if (bagsQuotaDrainedUntil && Date.now() < bagsQuotaDrainedUntil) {
      const secs = Math.ceil((bagsQuotaDrainedUntil - Date.now()) / 1000)
      throw new Error(
        `Bags API quota drained — resets in ${secs}s (at ${new Date(bagsQuotaDrainedUntil).toISOString()})`,
      )
    }
    return cfg
  })
  return client
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
 * Valuation helper: ask Bags what `amountBaseUnits` of `tokenMint` would swap
 * to in SOL right now. Returns lamports as a bigint, or `null` if Bags has no
 * route (low-liquidity / just-launched / de-listed).
 *
 * Uses `/trade/quote` with outputMint = wrapped SOL. Does NOT need the token's
 * decimals — the response's `outAmount` is already denominated in SOL
 * lamports, so multiplying a holding's raw amount by "price per unit" is
 * unnecessary. This is literally the liquidation value at current on-chain
 * prices.
 */
const WSOL_MINT_INTERNAL = 'So11111111111111111111111111111111111111112'
// In-process TTL cache for valuation quotes. The hourly price-snapshot
// worker, the dashboard live-read, and the /portfolio/pnl route all hit
// this helper with overlapping mints — without caching, a single dashboard
// load from two users fans out into dozens of /trade/quote calls, which
// punches through the Bags 1000 req/hour bucket in minutes.
// TTL is 60s — price moves on illiquid memes happen fast, but a minute of
// staleness is acceptable for valuation (not for buy quotes, which
// intentionally go through getTradeQuote, not this helper).
const VALUATION_TTL_MS = 60_000
const valuationCache = new Map<string, { value: bigint | null; at: number }>()
export async function getBagsSolValue(
  tokenMint: string,
  amountBaseUnits: string,
): Promise<bigint | null> {
  const cacheKey = `${tokenMint}:${amountBaseUnits}`
  const hit = valuationCache.get(cacheKey)
  if (hit && Date.now() - hit.at < VALUATION_TTL_MS) return hit.value
  try {
    const client = getClient()
    const res = await client.get('/trade/quote', {
      params: {
        inputMint: tokenMint,
        outputMint: WSOL_MINT_INTERNAL,
        amount: amountBaseUnits,
        slippageBps: 500,
        slippageMode: 'manual',
      },
    })
    const data = res.data?.response ?? res.data
    const out = data?.outAmount ?? data?.quote?.outAmount
    const value = out ? BigInt(out) : null
    valuationCache.set(cacheKey, { value, at: Date.now() })
    return value
  } catch {
    // Cache negative result too — hammering a dead route wastes quota.
    valuationCache.set(cacheKey, { value: null, at: Date.now() })
    return null
  }
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

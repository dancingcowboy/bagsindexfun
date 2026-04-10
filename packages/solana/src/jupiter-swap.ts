import axios from 'axios'

/**
 * Jupiter v6 swap fallback. Used when Bags trade API is rate-limited
 * (1000 req/hour hard cap) or returns no route for a given pair.
 *
 * Jupiter is an aggregator — it composes routes across every major Solana
 * DEX (Raydium, Orca, Meteora, Phoenix, …), so routing coverage is
 * strictly better than any single venue. It's a drop-in for the
 * Bags `/trade/quote` + `/trade/swap` pair.
 *
 * Endpoints:
 *   - GET  https://api.jup.ag/swap/v1/quote
 *   - POST https://api.jup.ag/swap/v1/swap
 *
 * Response shape note: Jupiter's swap returns a base64-encoded
 * VersionedTransaction (not base58 like Bags), so callers must not
 * bs58-decode the result of this module's builders.
 */

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote'
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap'

function jupHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY
  return key ? { 'x-api-key': key } : {}
}

const MAX_RETRIES = 4
const BASE_DELAY_MS = 2_000

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const is429 = err?.response?.status === 429
      if (!is429 || attempt === MAX_RETRIES) throw err
      const delay = BASE_DELAY_MS * 2 ** attempt
      console.warn(`[jupiter] 429 on ${label}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

export interface JupiterQuote {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  priceImpactPct: string
  routePlan: unknown[]
  [key: string]: unknown
}

export interface JupiterSwapResponse {
  swapTransaction: string // base64-encoded VersionedTransaction
  lastValidBlockHeight: number
}

export async function getJupiterQuote(params: {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps: number
}): Promise<JupiterQuote> {
  return withRetry(async () => {
    const res = await axios.get(JUP_QUOTE, {
      params: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: params.slippageBps,
        // Allow up to 3-hop routes — Jupiter will pick the best.
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
      },
      headers: jupHeaders(),
      timeout: 15_000,
    })
    return res.data as JupiterQuote
  }, `quote ${params.outputMint.slice(0, 8)}`)
}

export async function buildJupiterSwapTx(params: {
  quote: JupiterQuote
  userPublicKey: string
}): Promise<JupiterSwapResponse> {
  return withRetry(async () => {
    const res = await axios.post(
      JUP_SWAP,
      {
        quoteResponse: params.quote,
        userPublicKey: params.userPublicKey,
        // Let Jupiter auto-wrap/unwrap SOL so callers don't need an explicit
        // wSOL ATA management step.
        wrapAndUnwrapSol: true,
        // Dynamic compute unit limit — Jupiter sizes it to the route.
        dynamicComputeUnitLimit: true,
        // Priority fee auto-set to land fast without overpaying.
        prioritizationFeeLamports: 'auto',
      },
      { headers: jupHeaders(), timeout: 20_000 },
    )
    return res.data as JupiterSwapResponse
  }, `swap ${params.quote.outputMint?.slice(0, 8) ?? '?'}`)
}

/**
 * Liquidation value fallback via Jupiter v6 quote. Same contract as
 * `getBagsSolValue` — returns lamports as a bigint, or null if no route.
 * Used by getLiveHoldings when Bags has no route or is rate-limited.
 */
const WSOL = 'So11111111111111111111111111111111111111112'
export async function getJupiterSolValue(
  tokenMint: string,
  amountBaseUnits: string,
): Promise<bigint | null> {
  try {
    // getJupiterQuote already has retry logic for 429s
    const q = await getJupiterQuote({
      inputMint: tokenMint,
      outputMint: WSOL,
      amount: amountBaseUnits,
      slippageBps: 500,
    })
    return q.outAmount ? BigInt(q.outAmount) : null
  } catch {
    return null
  }
}

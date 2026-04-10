import axios from 'axios'

export interface JupPriceInfo {
  usdPrice: number
  liquidity: number
  decimals: number
  createdAt: string
  blockId: number
}

function jupPriceUrl(): string {
  // With a JUPITER_API_KEY use the keyed endpoint (higher rate limits);
  // without, fall back to the keyless lite endpoint.
  return process.env.JUPITER_API_KEY
    ? 'https://api.jup.ag/price/v3'
    : 'https://lite-api.jup.ag/price/v3'
}

function jupHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY
  return key ? { 'x-api-key': key } : {}
}

/**
 * Batch-fetch prices + liquidity from Jupiter Price API v3.
 * Batch up to 100 mints per call.
 * Response shape: `{ [mint]: { usdPrice, liquidity, decimals, createdAt, blockId } }`.
 * Mints with no Jupiter route are simply absent from the response.
 */
export async function getJupiterPrices(
  mints: string[]
): Promise<Map<string, JupPriceInfo>> {
  const out = new Map<string, JupPriceInfo>()
  const BATCH = 100
  for (let i = 0; i < mints.length; i += BATCH) {
    const slice = mints.slice(i, i + BATCH)
    try {
      const res = await axios.get(
        `${jupPriceUrl()}?ids=${slice.join(',')}`,
        { headers: jupHeaders(), timeout: 15_000 }
      )
      const data = res.data ?? {}
      for (const [mint, info] of Object.entries(data)) {
        if (info && typeof info === 'object') out.set(mint, info as JupPriceInfo)
      }
    } catch (err) {
      console.error(`[jupiter] price batch failed @${i}:`, err)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return out
}

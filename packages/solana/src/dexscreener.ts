import axios from 'axios'

export interface DexVolume {
  volumeH24Usd: number
  priceUsd: number
  liquidityUsd: number
  marketCapUsd: number
}

/**
 * Batch-fetch 24h volume / price / liquidity from DexScreener.
 * Free, no key. The tokens endpoint accepts up to 30 mint addresses per call.
 * For each token we keep the deepest pair (max liquidity) — that's the one
 * the index actually trades against.
 */
export async function getDexVolumes(
  mints: string[]
): Promise<Map<string, DexVolume>> {
  const out = new Map<string, DexVolume>()
  const BATCH = 30
  for (let i = 0; i < mints.length; i += BATCH) {
    const slice = mints.slice(i, i + BATCH)
    try {
      const res = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${slice.join(',')}`,
        { timeout: 15_000 }
      )
      const pairs: any[] = Array.isArray(res.data) ? res.data : res.data?.pairs ?? []
      // Group by base token, keep deepest pair per mint
      const best = new Map<string, any>()
      for (const p of pairs) {
        const mint = p?.baseToken?.address
        if (!mint) continue
        const liq = Number(p?.liquidity?.usd) || 0
        const prev = best.get(mint)
        if (!prev || liq > Number(prev?.liquidity?.usd ?? 0)) best.set(mint, p)
      }
      for (const [mint, p] of best) {
        out.set(mint, {
          volumeH24Usd: Number(p?.volume?.h24) || 0,
          priceUsd: Number(p?.priceUsd) || 0,
          liquidityUsd: Number(p?.liquidity?.usd) || 0,
          marketCapUsd: Number(p?.marketCap) || Number(p?.fdv) || 0,
        })
      }
    } catch (err) {
      console.error(`[dexscreener] batch failed @${i}:`, err)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return out
}

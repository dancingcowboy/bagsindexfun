import axios from 'axios'

export interface DexVolume {
  volumeH24Usd: number
  priceUsd: number
  priceNative: number // price in SOL (quote token of the deepest pair)
  liquidityUsd: number
  marketCapUsd: number
  pairCreatedAt: number | null // epoch ms
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
          priceNative: Number(p?.priceNative) || 0,
          liquidityUsd: Number(p?.liquidity?.usd) || 0,
          marketCapUsd: Number(p?.marketCap) || Number(p?.fdv) || 0,
          pairCreatedAt: p?.pairCreatedAt ? Number(p.pairCreatedAt) : null,
        })
      }
    } catch (err) {
      console.error(`[dexscreener] batch failed @${i}:`, err)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return out
}

/**
 * Return up to `limit` top Solana token mints ranked by 24h USD volume.
 * Composes a candidate pool from DexScreener's free boost/profile endpoints,
 * enriches each candidate via getDexVolumes(), then picks the highest-volume N.
 *
 * Free API, no key. No Helius cost. Used by admin DexScreener scoring worker.
 */
export async function getDexscreenerTopSolanaMints(
  limit = 30
): Promise<string[]> {
  const candidates = new Set<string>()

  const endpoints = [
    'https://api.dexscreener.com/token-boosts/top/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ]

  for (const url of endpoints) {
    try {
      const res = await axios.get(url, { timeout: 15_000 })
      const rows: any[] = Array.isArray(res.data) ? res.data : []
      for (const r of rows) {
        if (r?.chainId !== 'solana') continue
        const addr = r?.tokenAddress
        if (typeof addr === 'string' && addr.length >= 32) candidates.add(addr)
      }
    } catch (err) {
      console.error(`[dexscreener] candidate fetch failed ${url}:`, err)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  // Fallback: if under 2x limit, supplement via search for 'solana'
  if (candidates.size < limit * 2) {
    try {
      const res = await axios.get(
        'https://api.dexscreener.com/latest/dex/search?q=solana',
        { timeout: 15_000 }
      )
      const pairs: any[] = res.data?.pairs ?? []
      for (const p of pairs) {
        if (p?.chainId !== 'solana') continue
        const addr = p?.baseToken?.address
        if (typeof addr === 'string' && addr.length >= 32) candidates.add(addr)
      }
    } catch (err) {
      console.error(`[dexscreener] search fallback failed:`, err)
    }
  }

  if (candidates.size === 0) return []

  const volMap = await getDexVolumes([...candidates])
  const ranked = [...volMap.entries()]
    .filter(([, v]) => v.volumeH24Usd > 0 && v.liquidityUsd > 0)
    .sort(([, a], [, b]) => b.volumeH24Usd - a.volumeH24Usd)
    .slice(0, limit)
    .map(([mint]) => mint)

  return ranked
}

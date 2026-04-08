import 'dotenv/config'
import axios from 'axios'
import fs from 'node:fs'

/**
 * Preview the past 7d performance of each tier's index, weighted by
 * composite score. Uses GeckoTerminal free API for OHLCV (no key).
 *
 * Input:  /tmp/bagsindex-tiers.csv — "tier,symbol,mint,score" per row
 * Output: per-tier 7d %, daily equity curve, per-token contribution
 */

interface Row {
  tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
  symbol: string
  mint: string
  score: number
}

interface Candle {
  t: number // unix seconds
  o: number
  h: number
  l: number
  c: number
  v: number
}

const CSV_PATH = '/tmp/bagsindex-tiers.csv'
const GT = 'https://api.geckoterminal.com/api/v2'
const DAYS = 7

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Find the deepest USD pool on Solana for a given token mint, then fetch
 * daily OHLCV for the last DAYS days.
 */
async function getWithRetry(url: string, params: any = {}): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await axios.get(url, { params, timeout: 15_000 })
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < 3) {
        const wait = 15_000 * (attempt + 1)
        console.error(`    rate-limited, waiting ${wait / 1000}s...`)
        await sleep(wait)
        continue
      }
      throw err
    }
  }
}

async function fetchOhlcv(mint: string): Promise<Candle[] | null> {
  try {
    // 1. Pools for this token, sorted by reserve
    const poolsRes = await getWithRetry(
      `${GT}/networks/solana/tokens/${mint}/pools`,
      { page: 1 },
    )
    const pools = poolsRes.data?.data ?? []
    if (pools.length === 0) return null
    // Pick deepest by reserve_in_usd
    pools.sort(
      (a: any, b: any) =>
        Number(b.attributes?.reserve_in_usd || 0) -
        Number(a.attributes?.reserve_in_usd || 0),
    )
    const poolAddr = pools[0]?.attributes?.address
    if (!poolAddr) return null

    await sleep(2500) // rate-limit courtesy

    // 2. OHLCV for the pool — daily, last DAYS days
    const ohlcvRes = await getWithRetry(
      `${GT}/networks/solana/pools/${poolAddr}/ohlcv/day`,
      { aggregate: 1, limit: DAYS + 1, currency: 'usd', token: 'base' },
    )
    const rows: any[] = ohlcvRes.data?.data?.attributes?.ohlcv_list ?? []
    // rows are [timestamp, o, h, l, c, v]
    return rows
      .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
      .sort((a, b) => a.t - b.t)
  } catch (err: any) {
    console.error(`  [gt] ${mint.slice(0, 8)} failed: ${err.message}`)
    return null
  }
}

async function main() {
  const csv = fs.readFileSync(CSV_PATH, 'utf-8').trim().split('\n')
  const rows: Row[] = csv.map((line) => {
    const [tier, symbol, mint, score] = line.split(',')
    return { tier: tier.trim() as Row['tier'], symbol, mint, score: Number(score) }
  })

  console.log(`Loaded ${rows.length} token rows across tiers.\n`)

  // Unique mints
  const uniqueMints = Array.from(new Set(rows.map((r) => r.mint)))
  console.log(`Fetching OHLCV for ${uniqueMints.length} unique mints...\n`)

  const ohlcvByMint = new Map<string, Candle[]>()
  for (const mint of uniqueMints) {
    const symbol = rows.find((r) => r.mint === mint)?.symbol
    process.stdout.write(`  ${symbol?.padEnd(12)} ${mint.slice(0, 8)}  ...`)
    const candles = await fetchOhlcv(mint)
    if (candles && candles.length >= 2) {
      ohlcvByMint.set(mint, candles)
      const first = candles[0].o
      const last = candles[candles.length - 1].c
      const pct = ((last - first) / first) * 100
      console.log(` ${candles.length} candles, ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`)
    } else {
      console.log(` NO DATA`)
    }
    await sleep(2500)
  }

  console.log('\n' + '='.repeat(70))
  console.log('PER-TIER WEIGHTED 7-DAY PERFORMANCE')
  console.log('='.repeat(70) + '\n')

  const tiers: Row['tier'][] = ['CONSERVATIVE', 'BALANCED', 'DEGEN']
  for (const tier of tiers) {
    const tokens = rows.filter((r) => r.tier === tier)
    const totalScore = tokens.reduce((s, t) => s + t.score, 0)

    // Find common timeline — longest intersection of candle timestamps
    const candleSets = tokens
      .map((t) => ohlcvByMint.get(t.mint))
      .filter((c): c is Candle[] => !!c && c.length >= 2)
    if (candleSets.length === 0) {
      console.log(`${tier}: NO DATA\n`)
      continue
    }

    // Determine the timestamp range that every token has
    const allTimestamps = new Set<number>(candleSets[0].map((c) => c.t))
    for (let i = 1; i < candleSets.length; i++) {
      const s = new Set(candleSets[i].map((c) => c.t))
      for (const t of allTimestamps) if (!s.has(t)) allTimestamps.delete(t)
    }
    const timestamps = Array.from(allTimestamps).sort((a, b) => a - b)
    if (timestamps.length < 2) {
      console.log(`${tier}: insufficient overlapping candles\n`)
      continue
    }

    // Compute weighted index value over time (normalized to 100 at t0)
    // index(t) = Σ weight_i * (price_i(t) / price_i(t0))
    const baseline = new Map<string, number>()
    for (const tok of tokens) {
      const candles = ohlcvByMint.get(tok.mint)
      if (!candles) continue
      const c0 = candles.find((c) => c.t === timestamps[0])
      if (c0) baseline.set(tok.mint, c0.o)
    }

    const weighted: Array<{ t: number; value: number }> = []
    for (const t of timestamps) {
      let value = 0
      for (const tok of tokens) {
        const candles = ohlcvByMint.get(tok.mint)
        if (!candles) continue
        const c = candles.find((c) => c.t === t)
        const base = baseline.get(tok.mint)
        if (!c || !base) continue
        const w = tok.score / totalScore
        value += w * (c.c / base) * 100
      }
      weighted.push({ t, value })
    }

    const start = weighted[0].value
    const end = weighted[weighted.length - 1].value
    const pct = ((end - start) / start) * 100

    console.log(`${tier}  (${tokens.length} tokens, ${timestamps.length} days of overlap)`)
    console.log(`  7d: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`)
    console.log(`  Daily equity curve (indexed to 100):`)
    for (const w of weighted) {
      const date = new Date(w.t * 1000).toISOString().slice(0, 10)
      const bar = '█'.repeat(Math.max(0, Math.round((w.value - 80) / 2)))
      console.log(`    ${date}  ${w.value.toFixed(2).padStart(7)}  ${bar}`)
    }
    console.log('')

    // Per-token contribution
    const contribs = tokens
      .map((tok) => {
        const candles = ohlcvByMint.get(tok.mint)
        if (!candles) return { symbol: tok.symbol, pct: null, weight: tok.score / totalScore }
        const c0 = candles.find((c) => c.t === timestamps[0])
        const cn = candles.find((c) => c.t === timestamps[timestamps.length - 1])
        if (!c0 || !cn) return { symbol: tok.symbol, pct: null, weight: tok.score / totalScore }
        return {
          symbol: tok.symbol,
          pct: ((cn.c - c0.o) / c0.o) * 100,
          weight: tok.score / totalScore,
        }
      })
      .sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity))

    console.log(`  Per-token 7d (weight → move):`)
    for (const c of contribs) {
      const pctStr = c.pct === null ? 'n/a' : `${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%`
      console.log(`    ${c.symbol.padEnd(12)} ${(c.weight * 100).toFixed(1).padStart(5)}%  ${pctStr}`)
    }
    console.log('')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

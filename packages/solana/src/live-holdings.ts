import { getTokenBalances } from './helius.js'
import { getBagsSolValue } from './bags.js'
import { getJupiterSolValue } from './jupiter-swap.js'
import { getDexVolumes } from './dexscreener.js'
import { getJupiterPrices } from './jupiter.js'
import { getNativeSolBalance } from './connection.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const LAMPORTS_PER_SOL = 1_000_000_000

export interface LiveHolding {
  tokenMint: string
  amount: string // raw base-unit amount (bigint string)
  decimals: number
  valueSol: number
  priceSol: number
  source: 'bags' | 'dex' | 'jupiter' | 'none'
}

export interface LiveHoldingsResult {
  walletAddress: string
  nativeSol: number
  holdings: LiveHolding[]
  totalValueSol: number
}

/**
 * Live-read a wallet's holdings from on-chain state, priced against SOL
 * via Bags (primary) → DexScreener → Jupiter fallback. No DB dependency —
 * this is the source of truth for "what does this wallet actually hold
 * and what's it worth right now".
 *
 * - Amounts come from Helius enhanced API (`/balances`)
 * - Prices come from Bags `/trade/quote` (wSOL out) first; if Bags has no
 *   route we convert DexScreener's priceUsd, then Jupiter's usdPrice,
 *   using Jupiter's own WSOL usdPrice for SOL/USD
 * - Zero-balance mints are filtered out
 */
export async function getLiveHoldings(walletAddress: string): Promise<LiveHoldingsResult> {
  const [chain, nativeSol] = await Promise.all([
    getTokenBalances(walletAddress) as Promise<{
      tokens?: Array<{ mint: string; amount: number | string; decimals: number }>
    }>,
    getNativeSolBalance(walletAddress).catch(() => 0),
  ])

  const raw = (chain.tokens ?? []).filter((t) => {
    const amt = typeof t.amount === 'string' ? BigInt(t.amount) : BigInt(Math.floor(Number(t.amount) || 0))
    return amt > 0n && t.mint !== SOL_MINT
  })
  if (raw.length === 0) {
    return { walletAddress, nativeSol, holdings: [], totalValueSol: nativeSol }
  }

  const mints = raw.map((t) => t.mint)
  // Fire all three price sources in parallel; Bags per-mint probe still
  // needs the decimals (we already have them from Helius).
  const [dexPrices, jupPrices] = await Promise.all([
    getDexVolumes(mints),
    getJupiterPrices([...mints, SOL_MINT]),
  ])
  const solUsd = Number(jupPrices.get(SOL_MINT)?.usdPrice ?? 0)

  const holdings: LiveHolding[] = []
  for (const t of raw) {
    const amountRaw = typeof t.amount === 'string' ? t.amount : String(t.amount)
    const amountBig = BigInt(Math.floor(Number(amountRaw)))
    const decimals = t.decimals
    const whole = Number(amountBig) / 10 ** decimals

    // Price cascade: Bags → DexScreener → Jupiter (batch) → Jupiter (quote).
    // DexScreener is free with no meaningful rate limit, so we try it before
    // Jupiter to avoid burning Jupiter API quota on pricing.
    let priceSol = 0
    let source: LiveHolding['source'] = 'none'
    try {
      const probe = (10n ** BigInt(decimals)).toString()
      const lamports = await getBagsSolValue(t.mint, probe)
      if (lamports !== null) {
        priceSol = Number(lamports) / LAMPORTS_PER_SOL
        source = 'bags'
      }
    } catch {
      // fall through
    }

    // DexScreener USD → SOL (already batch-fetched, no extra request)
    if (priceSol === 0 && solUsd > 0) {
      const usd = Number(dexPrices.get(t.mint)?.priceUsd ?? 0)
      if (usd > 0) {
        priceSol = usd / solUsd
        source = 'dex'
      }
    }

    // Jupiter batch price (already fetched, no extra request)
    if (priceSol === 0 && solUsd > 0) {
      const usd = Number(jupPrices.get(t.mint)?.usdPrice ?? 0)
      if (usd > 0) {
        priceSol = usd / solUsd
        source = 'jupiter'
      }
    }

    // Last resort: per-token Jupiter quote (costs 1 API request each)
    if (priceSol === 0) {
      try {
        const probe = (10n ** BigInt(decimals)).toString()
        const jLamports = await getJupiterSolValue(t.mint, probe)
        if (jLamports !== null) {
          priceSol = Number(jLamports) / LAMPORTS_PER_SOL
          source = 'jupiter'
        }
      } catch {
        // fall through
      }
    }

    const valueSol = priceSol * whole
    holdings.push({
      tokenMint: t.mint,
      amount: amountRaw,
      decimals,
      valueSol,
      priceSol,
      source,
    })
  }

  holdings.sort((a, b) => b.valueSol - a.valueSol)
  const totalValueSol = nativeSol + holdings.reduce((s, h) => s + h.valueSol, 0)

  return { walletAddress, nativeSol, holdings, totalValueSol }
}

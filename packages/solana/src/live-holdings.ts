import { getTokenBalances } from './helius.js'
import { getDexVolumes } from './dexscreener.js'
import { getJupiterPrices } from './jupiter.js'
import { getNativeSolBalance } from './connection.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

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
 * Live-read a wallet's holdings from on-chain state, priced against SOL.
 * No DB dependency — this is the source of truth for "what does this
 * wallet actually hold and what's it worth right now".
 *
 * - Amounts: Helius enhanced API (`/balances`)
 * - Prices: DexScreener batch (free, unlimited, covers the whole Solana
 *   DEX graph in one request) → Jupiter batch as fallback for anything
 *   Dex doesn't index. We deliberately skip Bags `/trade/quote` in the
 *   hot path — it's per-mint and rate-limited, and any Bags pair is
 *   already a DEX pair so Dex covers it. Bags is only used for building
 *   actual swap transactions, not for valuation.
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
  // Fire price sources in parallel. Include SOL_MINT in DexScreener batch
  // so we have a fallback if Jupiter doesn't return a SOL/USD price.
  const [dexPrices, jupPrices] = await Promise.all([
    getDexVolumes([...mints, SOL_MINT]),
    getJupiterPrices([...mints, SOL_MINT]),
  ])
  let solUsd = Number(jupPrices.get(SOL_MINT)?.usdPrice ?? 0)
  if (solUsd <= 0) solUsd = Number(dexPrices.get(SOL_MINT)?.priceUsd ?? 0)

  const holdings: LiveHolding[] = []
  for (const t of raw) {
    const amountRaw = typeof t.amount === 'string' ? t.amount : String(t.amount)
    const amountBig = BigInt(Math.floor(Number(amountRaw)))
    const decimals = t.decimals
    const whole = Number(amountBig) / 10 ** decimals

    // Price cascade: DexScreener batch → Jupiter batch. Both are already
    // fetched once above, so this loop issues zero network calls.
    let priceSol = 0
    let source: LiveHolding['source'] = 'none'

    if (solUsd > 0) {
      const dexUsd = Number(dexPrices.get(t.mint)?.priceUsd ?? 0)
      if (dexUsd > 0) {
        priceSol = dexUsd / solUsd
        source = 'dex'
      }
    }

    if (priceSol === 0 && solUsd > 0) {
      const jupUsd = Number(jupPrices.get(t.mint)?.usdPrice ?? 0)
      if (jupUsd > 0) {
        priceSol = jupUsd / solUsd
        source = 'jupiter'
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

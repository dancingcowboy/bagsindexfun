import { getDexVolumes } from './dexscreener.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

export interface DbHoldingInput {
  tokenMint: string
  amount: bigint | string | number
  decimals: number
}

export interface PricedHolding {
  tokenMint: string
  amount: string
  decimals: number
  valueSol: number
  priceSol: number
  source: 'dex' | 'none'
}

/**
 * Price a list of DB-sourced holdings using DexScreener only.
 *
 * The hot path for the dashboard and the hourly snapshot worker. Avoids
 * Helius entirely — we trust the DB's amount/decimals (kept fresh by
 * post-swap reconcile) and only ask DexScreener for prices. DexScreener
 * returns `priceNative` (SOL per whole token) directly, so we can skip the
 * USD→SOL conversion that used to depend on Jupiter.
 */
export async function priceHoldingsFromDex(
  holdings: DbHoldingInput[],
): Promise<Map<string, PricedHolding>> {
  const out = new Map<string, PricedHolding>()
  if (holdings.length === 0) return out

  const mints = [...new Set(holdings.map((h) => h.tokenMint))].filter(
    (m) => m !== SOL_MINT,
  )
  const dex = await getDexVolumes(mints)

  for (const h of holdings) {
    const amountStr =
      typeof h.amount === 'bigint' ? h.amount.toString() : String(h.amount)
    const amountBig = BigInt(amountStr)
    if (amountBig === 0n) {
      out.set(h.tokenMint, {
        tokenMint: h.tokenMint,
        amount: amountStr,
        decimals: h.decimals,
        valueSol: 0,
        priceSol: 0,
        source: 'none',
      })
      continue
    }
    const whole = Number(amountBig) / 10 ** h.decimals
    const priceSol = Number(dex.get(h.tokenMint)?.priceNative ?? 0)
    const valueSol = priceSol > 0 ? priceSol * whole : 0
    out.set(h.tokenMint, {
      tokenMint: h.tokenMint,
      amount: amountStr,
      decimals: h.decimals,
      valueSol,
      priceSol,
      source: priceSol > 0 ? 'dex' : 'none',
    })
  }
  return out
}

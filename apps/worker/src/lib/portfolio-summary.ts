import { db } from '@bags-index/db'
import type { RiskTier } from '@bags-index/shared'

export interface SummaryHolding {
  tokenMint: string
  tokenSymbol: string | null
  valueSol: number
}

export interface SummaryTier {
  riskTier: RiskTier
  walletAddress: string
  totalValueSol: number
  holdings: SummaryHolding[]
}

export interface PortfolioSummary {
  tiers: SummaryTier[]
  totalValueSol: number
}

/**
 * DB-only portfolio summary used by the user-notification path. Reads
 * `Holding.valueSolEst` (kept fresh by post-swap reconcile) rather than
 * doing a live chain read — this runs inline after every trading event
 * and must be fast and cheap.
 */
export async function buildUserPortfolioSummary(userId: string): Promise<PortfolioSummary> {
  const wallets = await db.subWallet.findMany({
    where: { userId },
    include: { holdings: true },
  })

  const mints = new Set<string>()
  for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)

  const scores = mints.size
    ? await db.tokenScore.findMany({
        where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
        orderBy: { scoredAt: 'desc' },
        select: { tokenMint: true, tokenSymbol: true },
      })
    : []
  const symByMint = new Map<string, string | null>()
  for (const s of scores) if (!symByMint.has(s.tokenMint)) symByMint.set(s.tokenMint, s.tokenSymbol)

  const tiers: SummaryTier[] = wallets.map((w) => {
    const holdings = w.holdings
      .map((h) => ({
        tokenMint: h.tokenMint,
        tokenSymbol: symByMint.get(h.tokenMint) ?? null,
        valueSol: Number(h.valueSolEst ?? 0),
      }))
      .filter((h) => h.valueSol > 0)
      .sort((a, b) => b.valueSol - a.valueSol)
    const totalValueSol = holdings.reduce((s, h) => s + h.valueSol, 0)
    return {
      riskTier: w.riskTier,
      walletAddress: w.address,
      totalValueSol,
      holdings,
    }
  })

  return {
    tiers,
    totalValueSol: tiers.reduce((s, t) => s + t.totalValueSol, 0),
  }
}

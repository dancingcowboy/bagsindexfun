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
  /** Sum of holding cost basis in SOL (DB-tracked, proportionally scaled). */
  costBasisSol: number
  /** Realized PnL already paid out / compounded. */
  realizedPnlSol: number
  /** totalValueSol − costBasisSol (open position PnL). */
  unrealizedPnlSol: number
  /** realizedPnlSol + unrealizedPnlSol. */
  totalPnlSol: number
  holdings: SummaryHolding[]
}

export interface PortfolioSummary {
  tiers: SummaryTier[]
  totalValueSol: number
  totalCostBasisSol: number
  totalRealizedPnlSol: number
  totalUnrealizedPnlSol: number
  totalPnlSol: number
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
    const costBasisSol = w.holdings.reduce((s, h) => s + Number(h.costBasisSol ?? 0), 0)
    const realizedPnlSol = Number(w.realizedPnlSol ?? 0)
    const unrealizedPnlSol = totalValueSol - costBasisSol
    const totalPnlSol = realizedPnlSol + unrealizedPnlSol
    return {
      riskTier: w.riskTier!,
      walletAddress: w.address,
      totalValueSol,
      costBasisSol,
      realizedPnlSol,
      unrealizedPnlSol,
      totalPnlSol,
      holdings,
    }
  })

  return {
    tiers,
    totalValueSol: tiers.reduce((s, t) => s + t.totalValueSol, 0),
    totalCostBasisSol: tiers.reduce((s, t) => s + t.costBasisSol, 0),
    totalRealizedPnlSol: tiers.reduce((s, t) => s + t.realizedPnlSol, 0),
    totalUnrealizedPnlSol: tiers.reduce((s, t) => s + t.unrealizedPnlSol, 0),
    totalPnlSol: tiers.reduce((s, t) => s + t.totalPnlSol, 0),
  }
}

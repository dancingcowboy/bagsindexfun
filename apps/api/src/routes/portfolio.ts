import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { RISK_TIERS } from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * GET /portfolio
   * Aggregate portfolio across all the user's tier wallets.
   * Returns holdings grouped by riskTier.
   */
  app.get('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId

      const wallets = await db.subWallet.findMany({
        where: { userId },
        include: { holdings: true },
      })

      if (wallets.length === 0) {
        return { success: true, data: { totalValueSol: '0', tiers: [] } }
      }

      const tiers = wallets.map((w) => {
        const totalValueSol = w.holdings.reduce(
          (sum: number, h) => sum + Number(h.valueSolEst),
          0,
        )
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          totalValueSol: totalValueSol.toFixed(9),
          holdings: w.holdings.map((h) => ({
            tokenMint: h.tokenMint,
            amount: h.amount.toString(),
            valueSol: Number(h.valueSolEst).toFixed(9),
            allocationPct:
              totalValueSol > 0
                ? ((Number(h.valueSolEst) / totalValueSol) * 100).toFixed(2)
                : '0',
          })),
        }
      })

      const grandTotal = tiers.reduce((s, t) => s + Number(t.totalValueSol), 0)

      return {
        success: true,
        data: {
          totalValueSol: grandTotal.toFixed(9),
          tiers,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get portfolio')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/pnl
   * Per-tier PnL for the authenticated user only (ownership scoped).
   */
  app.get('/pnl', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const wallets = await db.subWallet.findMany({
        where: { userId },
        include: { holdings: true },
      })
      const tiers = wallets.map((w) => {
        const currentValue = w.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0)
        const costBasis = w.holdings.reduce((s, h) => s + Number(h.costBasisSol), 0)
        const realized = Number(w.realizedPnlSol)
        const unrealized = currentValue - costBasis
        const totalPnl = realized + unrealized
        const invested = w.holdings.reduce((s, h) => s + Number(h.totalBoughtSol), 0)
        const pnlPct = invested > 0 ? (totalPnl / invested) * 100 : 0
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          currentValueSol: currentValue.toFixed(9),
          costBasisSol: costBasis.toFixed(9),
          realizedSol: realized.toFixed(9),
          unrealizedSol: unrealized.toFixed(9),
          totalPnlSol: totalPnl.toFixed(9),
          pnlPct: pnlPct.toFixed(2),
        }
      })
      const totals = tiers.reduce(
        (acc, t) => ({
          currentValueSol: acc.currentValueSol + Number(t.currentValueSol),
          costBasisSol: acc.costBasisSol + Number(t.costBasisSol),
          realizedSol: acc.realizedSol + Number(t.realizedSol),
          unrealizedSol: acc.unrealizedSol + Number(t.unrealizedSol),
          totalPnlSol: acc.totalPnlSol + Number(t.totalPnlSol),
        }),
        { currentValueSol: 0, costBasisSol: 0, realizedSol: 0, unrealizedSol: 0, totalPnlSol: 0 },
      )
      return { success: true, data: { tiers, totals } }
    } catch (err) {
      app.log.error(err, 'Failed to get pnl')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/pnl-history?hours=168
   * Hourly PnL snapshot history for each of the user's sub-wallets.
   * Ownership-scoped: only returns rows belonging to wallets owned by
   * the authenticated user.
   */
  app.get<{ Querystring: { hours?: string } }>('/pnl-history', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId },
        select: { id: true, address: true, riskTier: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: { tiers: [] } }
      }

      const snapshots = await db.pnlSnapshot.findMany({
        where: {
          subWalletId: { in: wallets.map((w) => w.id) },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          subWalletId: true,
          totalValueSol: true,
          totalCostSol: true,
          unrealizedSol: true,
          realizedSol: true,
          createdAt: true,
        },
      })

      const byWallet = new Map<string, typeof snapshots>()
      for (const s of snapshots) {
        const arr = byWallet.get(s.subWalletId) ?? []
        arr.push(s)
        byWallet.set(s.subWalletId, arr)
      }

      const tiers = wallets.map((w) => ({
        riskTier: w.riskTier,
        walletAddress: w.address,
        points: (byWallet.get(w.id) ?? []).map((s) => ({
          t: s.createdAt,
          valueSol: s.totalValueSol.toString(),
          costSol: s.totalCostSol.toString(),
          unrealizedSol: s.unrealizedSol.toString(),
          realizedSol: s.realizedSol.toString(),
        })),
      }))

      return { success: true, data: { tiers, hours } }
    } catch (err) {
      app.log.error(err, 'Failed to get pnl history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/token-price-history?hours=168
   * Per-token SOL price history (one sample per hour) for every token the
   * authenticated user currently holds. Each series is normalized to base
   * 100 at the first sample so lines are comparable across tokens.
   * Ownership scoped: only mints present in the user's wallets.
   */
  app.get<{ Querystring: { hours?: string } }>('/token-price-history', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId },
        include: { holdings: { select: { tokenMint: true } } },
      })
      const mints = new Set<string>()
      for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
      if (mints.size === 0) return { success: true, data: { tokens: [], hours } }

      // Resolve symbol/name via most recent TokenScore
      const scores = await db.tokenScore.findMany({
        where: { tokenMint: { in: [...mints] } },
        orderBy: { scoredAt: 'desc' },
        select: { tokenMint: true, tokenSymbol: true, tokenName: true },
      })
      const metaByMint = new Map<string, { symbol: string; name: string }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint)) metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName })
      }

      const samples = await db.tokenPriceSnapshot.findMany({
        where: { tokenMint: { in: [...mints] }, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { tokenMint: true, priceSol: true, createdAt: true },
      })

      const byMint = new Map<string, typeof samples>()
      for (const s of samples) {
        const arr = byMint.get(s.tokenMint) ?? []
        arr.push(s)
        byMint.set(s.tokenMint, arr)
      }

      const tokens = [...mints].map((mint) => {
        const series = byMint.get(mint) ?? []
        const base = series.length > 0 ? Number(series[0].priceSol) : 0
        return {
          tokenMint: mint,
          tokenSymbol: metaByMint.get(mint)?.symbol ?? null,
          tokenName: metaByMint.get(mint)?.name ?? null,
          points: series.map((p) => ({
            t: p.createdAt,
            priceSol: p.priceSol.toString(),
            indexed: base > 0 ? (Number(p.priceSol) / base) * 100 : 100,
          })),
        }
      })

      return { success: true, data: { tokens, hours } }
    } catch (err) {
      app.log.error(err, 'Failed to get token price history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/transactions
   * Swap execution history across all the user's sub-wallets.
   */
  app.get('/transactions', async (req, reply) => {
    try {
      const userId = req.authUser!.userId

      const wallets = await db.subWallet.findMany({
        where: { userId },
        select: { id: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: [] }
      }

      const executions = await db.swapExecution.findMany({
        where: { subWalletId: { in: wallets.map((w) => w.id) } },
        orderBy: { executedAt: 'desc' },
        take: 100,
      })

      return {
        success: true,
        data: executions.map((e) => ({
          id: e.id,
          inputMint: e.inputMint,
          outputMint: e.outputMint,
          inputAmount: e.inputAmount.toString(),
          outputAmount: e.outputAmount?.toString() ?? null,
          txSignature: e.txSignature,
          status: e.status,
          executedAt: e.executedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to get transactions')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

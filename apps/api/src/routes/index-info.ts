import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'

/**
 * Public routes — no auth required. Exposes index composition and burn stats.
 */
export async function indexInfoRoutes(app: FastifyInstance) {
  /**
   * GET /index/current
   * Current top 10 tokens with scores and weights.
   */
  app.get('/current', async (_req, reply) => {
    try {
      const latestCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: {
            where: { isBlacklisted: false },
            orderBy: { rank: 'asc' },
            take: 10,
          },
        },
      })

      if (!latestCycle) {
        return { success: true, data: { cycleId: null, tokens: [] } }
      }

      const totalScore = latestCycle.scores.reduce(
        (sum, s) => sum + Number(s.compositeScore),
        0
      )

      return {
        success: true,
        data: {
          cycleId: latestCycle.id,
          scoredAt: latestCycle.completedAt,
          tokens: latestCycle.scores.map((s) => ({
            tokenMint: s.tokenMint,
            tokenSymbol: s.tokenSymbol,
            tokenName: s.tokenName,
            volume24h: Number(s.volume24h),
            holderCount: s.holderCount,
            holderGrowthPct: Number(s.holderGrowthPct),
            priceUsd: Number(s.priceUsd),
            liquidityUsd: Number(s.liquidityUsd),
            compositeScore: Number(s.compositeScore),
            rank: s.rank,
            weightPct: totalScore > 0
              ? ((Number(s.compositeScore) / totalScore) * 100).toFixed(2)
              : '0',
          })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get current index')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /index/history
   * Historical scoring cycles.
   */
  app.get('/history', async (_req, reply) => {
    try {
      const cycles = await db.scoringCycle.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        take: 30,
        include: {
          scores: {
            where: { isBlacklisted: false },
            orderBy: { rank: 'asc' },
            take: 10,
          },
        },
      })

      return {
        success: true,
        data: cycles.map((c) => ({
          cycleId: c.id,
          scoredAt: c.completedAt,
          tokenCount: c.tokenCount,
          tokens: c.scores.map((s) => ({
            tokenMint: s.tokenMint,
            tokenSymbol: s.tokenSymbol,
            rank: s.rank,
            compositeScore: Number(s.compositeScore),
          })),
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to get index history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /index/burns
   * Platform token burn stats and history.
   */
  app.get('/burns', async (_req, reply) => {
    try {
      const burns = await db.burnRecord.findMany({
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })

      const totalBurned = burns.reduce((sum, b) => sum + b.tokensBurned, 0n)
      const totalSolSpent = burns.reduce((sum, b) => sum + Number(b.solSpent), 0)

      return {
        success: true,
        data: {
          totalTokensBurned: totalBurned.toString(),
          totalSolSpent: totalSolSpent.toFixed(9),
          burnCount: burns.length,
          recentBurns: burns.slice(0, 20).map((b) => ({
            id: b.id,
            tokensBurned: b.tokensBurned.toString(),
            solSpent: Number(b.solSpent).toFixed(9),
            burnTxSig: b.burnTxSig,
            createdAt: b.createdAt,
          })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get burn stats')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

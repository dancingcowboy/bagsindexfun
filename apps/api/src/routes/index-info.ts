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
   * GET /index/aggregate-history?tier=BALANCED&hours=168
   *
   * Aggregated index line for a tier: weighted average of constituent
   * token prices, chained across scoring cycles so that rebalances don't
   * distort the series. For each hour bucket:
   *   - find the scoring cycle active at that time
   *   - take its top-10 normalized weights (compositeScore) for the tier
   *   - weighted return since the previous bucket, chained onto the index
   * Index is normalized to 100 at the first bucket in range.
   */
  app.get<{ Querystring: { tier?: string; hours?: string } }>(
    '/aggregate-history',
    async (req, reply) => {
      try {
        const tier = (req.query.tier ?? 'BALANCED').toUpperCase() as
          | 'CONSERVATIVE'
          | 'BALANCED'
          | 'DEGEN'
        if (!['CONSERVATIVE', 'BALANCED', 'DEGEN'].includes(tier)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10), 1), 24 * 90)
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)

        // 1. Load scoring cycles that could be active in the range (one
        //    before `since` too, so the earliest bucket has weights).
        const cycles = await db.scoringCycle.findMany({
          where: { status: 'COMPLETED', completedAt: { not: null } },
          orderBy: { completedAt: 'asc' },
          select: { id: true, completedAt: true },
        })
        if (cycles.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }

        // 2. Load all tier top-10 weights per cycle we care about.
        const cycleIds = cycles.map((c) => c.id)
        const scores = await db.tokenScore.findMany({
          where: {
            cycleId: { in: cycleIds },
            riskTier: tier,
            isBlacklisted: false,
            rank: { gte: 1, lte: 10 },
          },
          select: {
            cycleId: true,
            tokenMint: true,
            compositeScore: true,
          },
        })
        // weights[cycleId] = Map<mint, weight>
        const weightsByCycle = new Map<string, Map<string, number>>()
        for (const s of scores) {
          let m = weightsByCycle.get(s.cycleId)
          if (!m) {
            m = new Map()
            weightsByCycle.set(s.cycleId, m)
          }
          m.set(s.tokenMint, Number(s.compositeScore))
        }
        // Normalize in case compositeScore doesn't exactly sum to 1
        for (const m of weightsByCycle.values()) {
          const tot = [...m.values()].reduce((a, b) => a + b, 0) || 1
          for (const [k, v] of m) m.set(k, v / tot)
        }

        // 3. Load all price snapshots for mints that ever appeared in a
        //    tier cycle, within a slightly padded range.
        const allMints = new Set<string>()
        for (const m of weightsByCycle.values()) for (const k of m.keys()) allMints.add(k)
        if (allMints.size === 0) {
          return { success: true, data: { tier, points: [] } }
        }
        const samples = await db.tokenPriceSnapshot.findMany({
          where: {
            tokenMint: { in: [...allMints] },
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'asc' },
          select: { tokenMint: true, priceSol: true, createdAt: true },
        })
        if (samples.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }

        // 4. Bucket by hour (floor to hour). Collect mint→price for each bucket.
        const bucketKey = (d: Date) => {
          const x = new Date(d)
          x.setMinutes(0, 0, 0)
          return x.toISOString()
        }
        const buckets = new Map<string, Map<string, number>>()
        for (const s of samples) {
          const k = bucketKey(s.createdAt)
          let m = buckets.get(k)
          if (!m) {
            m = new Map()
            buckets.set(k, m)
          }
          m.set(s.tokenMint, Number(s.priceSol))
        }
        const orderedKeys = [...buckets.keys()].sort()

        // 5. For each bucket, find the active cycle (latest completedAt <= bucket time).
        const cycleForTime = (t: number): string | null => {
          let chosen: string | null = null
          for (const c of cycles) {
            if (c.completedAt && c.completedAt.getTime() <= t) chosen = c.id
            else break
          }
          return chosen
        }

        // 6. Chain weighted returns. For each pair of consecutive buckets,
        //    use the weights active at the START of the step and take the
        //    weighted sum of per-token returns for tokens present in BOTH
        //    buckets. Missing tokens on either side contribute 0 weight to
        //    that step (weights are renormalized over the overlap).
        const points: { t: string; indexed: number }[] = []
        let index = 100
        points.push({ t: orderedKeys[0], indexed: 100 })
        for (let i = 1; i < orderedKeys.length; i++) {
          const prevKey = orderedKeys[i - 1]
          const curKey = orderedKeys[i]
          const prev = buckets.get(prevKey)!
          const cur = buckets.get(curKey)!
          const cycleId = cycleForTime(new Date(prevKey).getTime())
          const weights = cycleId ? weightsByCycle.get(cycleId) : null
          if (!weights || weights.size === 0) {
            points.push({ t: curKey, indexed: index })
            continue
          }
          // Overlap weights (tokens present in both buckets AND in the active cycle)
          const overlap: Array<{ w: number; ret: number }> = []
          let wSum = 0
          for (const [mint, w] of weights) {
            const p0 = prev.get(mint)
            const p1 = cur.get(mint)
            if (p0 && p1 && p0 > 0) {
              overlap.push({ w, ret: p1 / p0 - 1 })
              wSum += w
            }
          }
          if (wSum === 0) {
            points.push({ t: curKey, indexed: index })
            continue
          }
          let stepRet = 0
          for (const o of overlap) stepRet += (o.w / wSum) * o.ret
          index = index * (1 + stepRet)
          points.push({ t: curKey, indexed: index })
        }

        return { success: true, data: { tier, points } }
      } catch (err) {
        app.log.error(err, 'Failed to compute aggregate index history')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

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

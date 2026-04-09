import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'

/**
 * Public routes — no auth required. Exposes index composition.
 */
// Scoring cadence per tier — must match apps/worker/src/index.ts scheduler.
// Rebalance is reactive (fires after scoring if composition changed), so
// "next cycle" here means the next scoring run per tier.
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000
const TIER_INTERVAL_MS: Record<'CONSERVATIVE' | 'BALANCED' | 'DEGEN', number> = {
  DEGEN: 4 * HOUR_MS + 23 * MIN_MS,
  BALANCED: 12 * HOUR_MS + 8 * MIN_MS,
  CONSERVATIVE: 23 * HOUR_MS + 23 * MIN_MS,
}

export async function indexInfoRoutes(app: FastifyInstance) {
  /**
   * GET /index/schedule
   * Per-tier last-scored and next-scheduled cycle times. Powers the
   * dashboard countdown so users can see when their vault will next be
   * rescored (and potentially rebalanced).
   */
  app.get('/schedule', async (_req, reply) => {
    try {
      const tiers = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
      const rows = await Promise.all(
        tiers.map(async (tier) => {
          const last = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', tier, completedAt: { not: null } },
            orderBy: { completedAt: 'desc' },
            select: { completedAt: true },
          })
          const intervalMs = TIER_INTERVAL_MS[tier]
          const lastScoredAt = last?.completedAt ?? null
          const nextScoringAt = lastScoredAt
            ? new Date(lastScoredAt.getTime() + intervalMs)
            : null
          return { tier, lastScoredAt, nextScoringAt, intervalMs }
        }),
      )
      return { success: true, data: rows }
    } catch (err) {
      app.log.error(err, 'Failed to get index schedule')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

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

        // 1. Use the LATEST completed cycle's top-10 as a constant basket
        //    for the whole window. Earlier approach used the cycle active
        //    at each bucket time, but that means tokens added in today's
        //    cycle (e.g. PRIMIS in CONSERVATIVE) get weight 0 for older
        //    buckets and their later spikes never enter the index. The
        //    intuitive view is "how would today's top 10 have performed
        //    over the past N hours" — same convention as the per-token
        //    chart below.
        // Scope to the latest completed cycle *for this tier*. Per-tier
        // scoring writes tier-scoped cycles, so a global latest-cycle
        // lookup only returns whichever tier ran last. Fall back to any
        // legacy tier-less cycle if no tier-scoped one exists yet.
        let latestCycle = await db.scoringCycle.findFirst({
          where: { status: 'COMPLETED', completedAt: { not: null }, tier },
          orderBy: { completedAt: 'desc' },
          select: { id: true },
        })
        if (!latestCycle) {
          latestCycle = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', completedAt: { not: null }, tier: null },
            orderBy: { completedAt: 'desc' },
            select: { id: true },
          })
        }
        if (!latestCycle) {
          return { success: true, data: { tier, points: [] } }
        }
        const scores = await db.tokenScore.findMany({
          where: {
            cycleId: latestCycle.id,
            riskTier: tier,
            isBlacklisted: false,
            rank: { gte: 1, lte: 10 },
          },
          select: { tokenMint: true, compositeScore: true },
        })
        const weights = new Map<string, number>()
        const totalScore = scores.reduce((a, s) => a + Number(s.compositeScore), 0) || 1
        for (const s of scores) {
          weights.set(s.tokenMint, Number(s.compositeScore) / totalScore)
        }

        // 2. Load price snapshots for the basket mints over the window.
        const allMints = new Set<string>(weights.keys())
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

        // 4. Build per-mint sorted price series for forward-filling. Each
        //    mint typically only has one sample per hour, and not every
        //    mint samples on the same hour boundary, so the previous
        //    "tokens in BOTH adjacent buckets" approach gave near-empty
        //    overlap and a flat index line. Instead, for each hour bucket
        //    we look up each weighted token's last-known price (≤ bucket
        //    time). Tokens with no observation yet are skipped for that
        //    bucket only.
        const seriesByMint = new Map<string, { t: number; price: number }[]>()
        for (const s of samples) {
          const arr = seriesByMint.get(s.tokenMint) ?? []
          arr.push({ t: s.createdAt.getTime(), price: Number(s.priceSol) })
          seriesByMint.set(s.tokenMint, arr)
        }
        // samples are already orderBy createdAt asc, so per-mint arrays are sorted

        const priceAt = (mint: string, t: number): number | null => {
          const arr = seriesByMint.get(mint)
          if (!arr || arr.length === 0) return null
          // Binary search for the largest entry with t <= target
          let lo = 0
          let hi = arr.length - 1
          let chosen = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (arr[mid].t <= t) {
              chosen = mid
              lo = mid + 1
            } else {
              hi = mid - 1
            }
          }
          if (chosen < 0) return null
          return arr[chosen].price
        }

        // 5. Build an ordered list of hourly bucket timestamps spanning
        //    the full range, regardless of whether any sample landed
        //    exactly on that hour. Start at the first hour ≥ since.
        const startBucket = new Date(since)
        startBucket.setMinutes(0, 0, 0)
        // If the first bucket has no observation for any weighted token,
        // step forward until one does.
        const HOUR = 60 * 60 * 1000
        const nowFloor = new Date()
        nowFloor.setMinutes(0, 0, 0)
        const orderedTimes: number[] = []
        for (let t = startBucket.getTime(); t <= nowFloor.getTime(); t += HOUR) {
          orderedTimes.push(t)
        }

        // 6. Chain weighted returns across consecutive buckets using the
        //    constant latest-cycle basket and forward-filled per-mint prices.
        const points: { t: string; indexed: number }[] = []
        let index = 100
        let started = false
        let prevTime = -1
        for (const t of orderedTimes) {
          if (!started) {
            let any = false
            for (const mint of weights.keys()) {
              if (priceAt(mint, t) !== null) { any = true; break }
            }
            if (!any) continue
            started = true
            prevTime = t
            points.push({ t: new Date(t).toISOString(), indexed: 100 })
            continue
          }

          let stepRet = 0
          let wSum = 0
          for (const [mint, w] of weights) {
            const p0 = priceAt(mint, prevTime)
            const p1 = priceAt(mint, t)
            if (p0 !== null && p1 !== null && p0 > 0) {
              stepRet += w * (p1 / p0 - 1)
              wSum += w
            }
          }
          if (wSum > 0) {
            stepRet /= wSum
            index = index * (1 + stepRet)
          }
          points.push({ t: new Date(t).toISOString(), indexed: index })
          prevTime = t
        }

        return { success: true, data: { tier, points } }
      } catch (err) {
        app.log.error(err, 'Failed to compute aggregate index history')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * GET /index/token-price-history?tier=BALANCED&hours=168
   * Public per-token price series for the latest top-10 of a given tier,
   * normalized to base 100 at the first sample. Lets visitors compare
   * tier performance before depositing.
   */
  app.get<{ Querystring: { tier?: string; hours?: string } }>(
    '/token-price-history',
    async (req, reply) => {
      try {
        const tier = (req.query.tier ?? 'BALANCED').toUpperCase() as
          | 'CONSERVATIVE'
          | 'BALANCED'
          | 'DEGEN'
        if (!['CONSERVATIVE', 'BALANCED', 'DEGEN'].includes(tier)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)

        // Latest completed cycle *for this tier*. Per-tier scoring writes
        // tier-scoped cycles, so the global "latest completed" only covers
        // whichever tier ran last — we must scope the lookup by tier.
        // Fall back to any legacy tier-less cycle if no tier-scoped cycle
        // exists yet.
        let cycle = await db.scoringCycle.findFirst({
          where: { status: 'COMPLETED', tier },
          orderBy: { completedAt: 'desc' },
          include: {
            scores: {
              where: { riskTier: tier, isBlacklisted: false, rank: { gte: 1, lte: 10 } },
              orderBy: { rank: 'asc' },
              select: { tokenMint: true, tokenSymbol: true, tokenName: true },
            },
          },
        })
        if (!cycle) {
          cycle = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', tier: null },
            orderBy: { completedAt: 'desc' },
            include: {
              scores: {
                where: { riskTier: tier, isBlacklisted: false, rank: { gte: 1, lte: 10 } },
                orderBy: { rank: 'asc' },
                select: { tokenMint: true, tokenSymbol: true, tokenName: true },
              },
            },
          })
        }
        if (!cycle || cycle.scores.length === 0) {
          return { success: true, data: { tier, tokens: [], hours } }
        }

        const mints = cycle.scores.map((s) => s.tokenMint)
        const metaByMint = new Map(cycle.scores.map((s) => [s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName }]))

        const samples = await db.tokenPriceSnapshot.findMany({
          where: { tokenMint: { in: mints }, createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { tokenMint: true, priceSol: true, createdAt: true },
        })
        const byMint = new Map<string, typeof samples>()
        for (const s of samples) {
          const arr = byMint.get(s.tokenMint) ?? []
          arr.push(s)
          byMint.set(s.tokenMint, arr)
        }

        const tokens = mints.map((mint) => {
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

        return { success: true, data: { tier, tokens, hours } }
      } catch (err) {
        app.log.error(err, 'Failed to get tier token price history')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

}

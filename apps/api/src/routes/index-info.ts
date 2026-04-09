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

        // 6. Active cycle resolver (latest completedAt ≤ bucket time).
        const cycleForTime = (t: number): string | null => {
          let chosen: string | null = null
          for (const c of cycles) {
            if (c.completedAt && c.completedAt.getTime() <= t) chosen = c.id
            else break
          }
          return chosen
        }

        // 7. Chain weighted returns across consecutive buckets, using
        //    forward-filled per-mint prices. For each pair (prev, cur),
        //    the step return is the weight-renormalized average of
        //    (price_cur / price_prev − 1) over the active tier weights.
        const points: { t: string; indexed: number }[] = []
        let index = 100
        let started = false
        let prevTime = -1
        for (const t of orderedTimes) {
          if (!started) {
            // Wait until at least one weighted token has a price at this time
            const cycleId = cycleForTime(t)
            const weights = cycleId ? weightsByCycle.get(cycleId) : null
            if (!weights) continue
            let any = false
            for (const mint of weights.keys()) {
              if (priceAt(mint, t) !== null) {
                any = true
                break
              }
            }
            if (!any) continue
            started = true
            prevTime = t
            points.push({ t: new Date(t).toISOString(), indexed: 100 })
            continue
          }

          const cycleId = cycleForTime(prevTime)
          const weights = cycleId ? weightsByCycle.get(cycleId) : null
          if (!weights || weights.size === 0) {
            points.push({ t: new Date(t).toISOString(), indexed: index })
            prevTime = t
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

        // Latest completed cycle's top 10 for this tier
        const cycle = await db.scoringCycle.findFirst({
          where: { status: 'COMPLETED' },
          orderBy: { completedAt: 'desc' },
          include: {
            scores: {
              where: { riskTier: tier, isBlacklisted: false, rank: { gte: 1, lte: 10 } },
              orderBy: { rank: 'asc' },
              select: { tokenMint: true, tokenSymbol: true, tokenName: true },
            },
          },
        })
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

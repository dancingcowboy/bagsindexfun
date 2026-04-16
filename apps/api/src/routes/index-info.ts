import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import {
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
  TIER_SCORING_CONFIG,
} from '@bags-index/shared'

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
            where: { status: 'COMPLETED', tier, source: 'BAGS', completedAt: { not: null } },
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
  app.get<{ Querystring: { tier?: string } }>('/current', async (req, reply) => {
    try {
      // Optional tier filter — when omitted, returns the most recently
      // completed cycle (whichever tier ran last). Dashboard passes
      // ?tier=… to scope the constituent table to a single index.
      const tierParam = req.query.tier?.toUpperCase()
      const allowed = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
      const tierFilter =
        tierParam && (allowed as readonly string[]).includes(tierParam)
          ? (tierParam as (typeof allowed)[number])
          : undefined
      const latestCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED', source: 'BAGS', ...(tierFilter ? { tier: tierFilter } : {}) },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: {
            where: { isBlacklisted: false, source: 'BAGS', ...(tierFilter ? { riskTier: tierFilter } : {}) },
            orderBy: { rank: 'asc' },
            take: 10,
          },
        },
      })

      if (!latestCycle) {
        return { success: true, data: { cycleId: null, tokens: [] } }
      }

      // Square-root weighting: w_i = √score_i / Σ √score_j.
      const totalScore = latestCycle.scores.reduce(
        (sum, s) => sum + Math.sqrt(Number(s.compositeScore)),
        0
      )

      const cycleTier = (latestCycle.tier ?? 'BALANCED') as
        | 'CONSERVATIVE'
        | 'BALANCED'
        | 'DEGEN'
      const anchorPct = TIER_SCORING_CONFIG[cycleTier]?.solAnchorPct ?? 0
      const scoredScale = (100 - BAGSX_WEIGHT_PCT - anchorPct) / 100

      const scoredTokens = latestCycle.scores.map((s) => ({
        tokenMint: s.tokenMint,
        tokenSymbol: s.tokenSymbol,
        tokenName: s.tokenName,
        volume24h: Number(s.volume24h),
        holderCount: s.holderCount,
        holderGrowthPct: Number(s.holderGrowthPct),
        priceUsd: Number(s.priceUsd),
        liquidityUsd: Number(s.liquidityUsd),
        marketCapUsd: Number(s.marketCapUsd),
        compositeScore: Number(s.compositeScore),
        rank: s.rank,
        weightPct:
          totalScore > 0
            ? ((Math.sqrt(Number(s.compositeScore)) / totalScore) * 100 * scoredScale).toFixed(2)
            : '0',
      }))

      // BAGSX pseudo-entry with the latest sampled SOL price + market cap.
      const bagsxSnap = await db.tokenPriceSnapshot.findFirst({
        where: { tokenMint: BAGSX_MINT },
        orderBy: { createdAt: 'desc' },
        select: { priceSol: true, marketCapUsd: true },
      })
      const bagsxEntry = {
        tokenMint: BAGSX_MINT,
        tokenSymbol: 'BAGSX',
        tokenName: 'Bags Index',
        volume24h: 0,
        holderCount: 0,
        holderGrowthPct: 0,
        priceUsd: 0,
        priceSol: bagsxSnap ? Number(bagsxSnap.priceSol) : 0,
        liquidityUsd: 0,
        marketCapUsd: bagsxSnap ? Number(bagsxSnap.marketCapUsd) : 0,
        compositeScore: 0,
        rank: scoredTokens.length + 1,
        weightPct: BAGSX_WEIGHT_PCT.toFixed(2),
        isFixed: true as const,
      }

      const tokens: any[] = [...scoredTokens, bagsxEntry]
      if (anchorPct > 0) {
        tokens.push({
          tokenMint: 'SOL',
          tokenSymbol: 'SOL',
          tokenName: 'Solana',
          volume24h: 0,
          holderCount: 0,
          holderGrowthPct: 0,
          priceUsd: 0,
          liquidityUsd: 0,
          marketCapUsd: 0,
          compositeScore: 0,
          rank: scoredTokens.length + 2,
          weightPct: anchorPct.toFixed(2),
          isFixed: true as const,
        })
      }

      return {
        success: true,
        data: {
          cycleId: latestCycle.id,
          scoredAt: latestCycle.completedAt,
          tier: cycleTier,
          tokens,
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
        where: { status: 'COMPLETED', source: 'BAGS' },
        orderBy: { completedAt: 'desc' },
        take: 30,
        include: {
          scores: {
            where: { isBlacklisted: false, source: 'BAGS' },
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
   * Honest-replay index line for a tier: walks each historical scoring
   * cycle in sequence and uses THAT cycle's actual top-10 basket for its
   * window. No survivorship bias — tokens that entered later don't get
   * credit for gains that happened before they were picked. Across cycle
   * boundaries the basket switches and no return is booked on the step
   * itself (models an instant, frictionless rebalance — a slippage-drag
   * model can be layered on later). Index is normalized to 100 at the
   * first emitted bucket in range.
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

        // 1. Load every completed cycle for this tier whose window
        //    overlaps the range. We need the one that was ACTIVE at
        //    `since` (i.e. the latest cycle completed before the range
        //    start) plus all cycles that completed within the range.
        const [activeAtStart, withinRange] = await Promise.all([
          db.scoringCycle.findFirst({
            where: {
              status: 'COMPLETED',
              source: 'BAGS',
              tier,
              completedAt: { not: null, lte: since },
            },
            orderBy: { completedAt: 'desc' },
            select: { id: true, completedAt: true },
          }),
          db.scoringCycle.findMany({
            where: {
              status: 'COMPLETED',
              source: 'BAGS',
              tier,
              completedAt: { gt: since },
            },
            orderBy: { completedAt: 'asc' },
            select: { id: true, completedAt: true },
          }),
        ])
        const cycles = [
          ...(activeAtStart ? [activeAtStart] : []),
          ...withinRange,
        ]
        if (cycles.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }

        // 2. Load the top-10 basket for each cycle in a single query,
        //    then group by cycleId → weights (normalized by compositeScore
        //    with BAGSX fixed at BAGSX_WEIGHT_PCT and SOL anchor treated
        //    as cash at 0 return).
        const anchorPct = TIER_SCORING_CONFIG[tier]?.solAnchorPct ?? 0
        const scoredScale = (100 - BAGSX_WEIGHT_PCT - anchorPct) / 100
        const allScores = await db.tokenScore.findMany({
          where: {
            cycleId: { in: cycles.map((c) => c.id) },
            riskTier: tier,
            isBlacklisted: false,
            rank: { gte: 1, lte: 10 },
          },
          select: { cycleId: true, tokenMint: true, compositeScore: true },
        })
        const basketByCycle = new Map<string, Map<string, number>>()
        const allMints = new Set<string>([BAGSX_MINT])
        for (const c of cycles) {
          const scores = allScores.filter((s) => s.cycleId === c.id)
          const basket = new Map<string, number>()
          // Square-root weighting (matches live rebalance worker).
          const total =
            scores.reduce((a, s) => a + Math.sqrt(Number(s.compositeScore)), 0) || 1
          for (const s of scores) {
            basket.set(
              s.tokenMint,
              (Math.sqrt(Number(s.compositeScore)) / total) * scoredScale,
            )
            allMints.add(s.tokenMint)
          }
          basket.set(BAGSX_MINT, BAGSX_WEIGHT_PCT / 100)
          basketByCycle.set(c.id, basket)
        }

        // 3. Load price snapshots for every mint that ever appeared in any
        //    basket in range. Pad `since` back by a few hours so the first
        //    bucket in range has a forward-fillable price.
        const priceSince = new Date(since.getTime() - 24 * HOUR_MS)
        const samples = await db.tokenPriceSnapshot.findMany({
          where: {
            tokenMint: { in: [...allMints] },
            createdAt: { gte: priceSince },
          },
          orderBy: { createdAt: 'asc' },
          select: { tokenMint: true, priceSol: true, createdAt: true },
        })
        if (samples.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }
        const seriesByMint = new Map<string, { t: number; price: number }[]>()
        for (const s of samples) {
          const arr = seriesByMint.get(s.tokenMint) ?? []
          arr.push({ t: s.createdAt.getTime(), price: Number(s.priceSol) })
          seriesByMint.set(s.tokenMint, arr)
        }
        const priceAt = (mint: string, t: number): number | null => {
          const arr = seriesByMint.get(mint)
          if (!arr || arr.length === 0) return null
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

        // 4. Resolve which cycle is active at a given time (latest cycle
        //    with completedAt <= t). Binary search keeps this fast.
        const cycleTimes = cycles.map((c) => ({
          t: c.completedAt!.getTime(),
          id: c.id,
        }))
        const activeCycleAt = (t: number): string | null => {
          let lo = 0
          let hi = cycleTimes.length - 1
          let chosen = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (cycleTimes[mid].t <= t) {
              chosen = mid
              lo = mid + 1
            } else {
              hi = mid - 1
            }
          }
          return chosen < 0 ? null : cycleTimes[chosen].id
        }

        // 5. Hourly bucket timeline from `since` to now.
        const startBucket = new Date(since)
        startBucket.setMinutes(0, 0, 0)
        const nowFloor = new Date()
        nowFloor.setMinutes(0, 0, 0)
        const orderedTimes: number[] = []
        for (let t = startBucket.getTime(); t <= nowFloor.getTime(); t += HOUR_MS) {
          orderedTimes.push(t)
        }

        // 6. Walk buckets. Within a cycle: chain weighted return using its
        //    basket. Across cycles: switch basket, no return booked on the
        //    transition step (rebalance treated as instantaneous / free).
        const points: { t: string; indexed: number; rebalance?: boolean }[] = []
        let index = 100
        let prevTime = -1
        let prevCycleId: string | null = null
        for (const t of orderedTimes) {
          const cycleId = activeCycleAt(t)
          if (!cycleId) continue
          const basket = basketByCycle.get(cycleId)
          if (!basket) continue

          // First emitted bucket — baseline at 100.
          if (prevTime < 0) {
            let any = false
            for (const mint of basket.keys()) {
              if (priceAt(mint, t) !== null) { any = true; break }
            }
            if (!any) continue
            points.push({ t: new Date(t).toISOString(), indexed: 100 })
            prevTime = t
            prevCycleId = cycleId
            continue
          }

          // Cycle switched between prev and now — book no return on the
          // rebalance step itself; basket changes going forward. Mark the
          // bucket so the chart can show a dot at the rebalance.
          if (cycleId !== prevCycleId) {
            points.push({ t: new Date(t).toISOString(), indexed: index, rebalance: true })
            prevTime = t
            prevCycleId = cycleId
            continue
          }

          // Same cycle — chain weighted return using current basket.
          let stepRet = 0
          let wSum = 0
          for (const [mint, w] of basket) {
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
          prevCycleId = cycleId
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
          where: { status: 'COMPLETED', tier, source: 'BAGS' },
          orderBy: { completedAt: 'desc' },
          include: {
            scores: {
              where: { riskTier: tier, isBlacklisted: false, rank: { gte: 1, lte: 10 }, source: 'BAGS' },
              orderBy: { rank: 'asc' },
              select: { tokenMint: true, tokenSymbol: true, tokenName: true },
            },
          },
        })
        if (!cycle) {
          cycle = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', tier: null, source: 'BAGS' },
            orderBy: { completedAt: 'desc' },
            include: {
              scores: {
                where: { riskTier: tier, isBlacklisted: false, rank: { gte: 1, lte: 10 }, source: 'BAGS' },
                orderBy: { rank: 'asc' },
                select: { tokenMint: true, tokenSymbol: true, tokenName: true },
              },
            },
          })
        }
        if (!cycle || cycle.scores.length === 0) {
          return { success: true, data: { tier, tokens: [], hours } }
        }

        const mints = [...cycle.scores.map((s) => s.tokenMint), BAGSX_MINT]
        const metaByMint = new Map<string, { symbol: string | null; name: string | null }>(
          cycle.scores.map((s) => [s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName }]),
        )
        metaByMint.set(BAGSX_MINT, { symbol: 'BAGSX', name: 'Bags Index' })

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
   * GET /index/hotlist
   * All scored Bags tokens from the latest cycle per tier. Powers the
   * public hotlist page — no new API calls needed, reuses scoring data.
   */
  app.get<{ Querystring: { tier?: string } }>('/hotlist', async (req, reply) => {
    try {
      const tiers = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
      const tierParam = req.query.tier?.toUpperCase()
      const filterTiers =
        tierParam && (tiers as readonly string[]).includes(tierParam)
          ? [tierParam as (typeof tiers)[number]]
          : [...tiers]

      const results = await Promise.all(
        filterTiers.map(async (tier) => {
          const cycle = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', tier, source: 'BAGS' },
            orderBy: { completedAt: 'desc' },
            select: { id: true, completedAt: true },
          })
          if (!cycle) return { tier, scoredAt: null, tokens: [] }

          const scores = await db.tokenScore.findMany({
            where: { cycleId: cycle.id, riskTier: tier, source: 'BAGS' },
            orderBy: [{ rank: 'asc' }],
          })
          return {
            tier,
            scoredAt: cycle.completedAt,
            tokens: scores.map((s) => ({
              tokenMint: s.tokenMint,
              tokenSymbol: s.tokenSymbol,
              tokenName: s.tokenName,
              rank: s.rank,
              compositeScore: Number(s.compositeScore),
              volume24h: Number(s.volume24h),
              holderCount: s.holderCount,
              holderGrowthPct: Number(s.holderGrowthPct),
              priceUsd: Number(s.priceUsd),
              liquidityUsd: Number(s.liquidityUsd),
              marketCapUsd: Number(s.marketCapUsd),
              safetyVerdict: s.safetyVerdict,
              isBlacklisted: s.isBlacklisted,
            })),
          }
        }),
      )

      return { success: true, data: results }
    } catch (err) {
      app.log.error(err, 'Failed to get hotlist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /index/vault — public protocol vault summary.
   * Shows BALANCED tier holdings, total value, and claim stats.
   * No auth required — this powers the landing page vault card.
   */
  app.get('/vault', async (_req, reply) => {
    try {
      const user = await db.user.findUnique({
        where: { privyUserId: 'system:protocol-vault' },
        include: {
          subWallets: {
            where: { riskTier: 'BALANCED' },
            include: { holdings: true },
          },
        },
      })
      if (!user) return { success: true, data: null }

      const sw = user.subWallets[0]
      if (!sw) return { success: true, data: null }

      // Resolve token symbols + market caps
      const mints = sw.holdings.map((h) => h.tokenMint)
      const scores = mints.length
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: mints }, source: 'BAGS' },
            orderBy: { scoredAt: 'desc' },
            select: { tokenMint: true, tokenSymbol: true, tokenName: true, marketCapUsd: true },
          })
        : []
      const metaByMint = new Map<string, { symbol: string; name: string; marketCapUsd: number }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint)) metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName, marketCapUsd: Number(s.marketCapUsd) })
      }

      const tokenValueSol = sw.holdings.reduce((s, h) => s + Number(h.valueSolEst || 0), 0)

      // Claim stats from audit log
      const claimCount = await db.auditLog.count({ where: { action: 'VAULT_FEE_CLAIM' } })
      const claimLogs = await db.auditLog.findMany({
        where: { action: 'VAULT_FEE_CLAIM' },
        select: { resource: true },
      })
      const claimDepositIds = claimLogs
        .map((l) => (l.resource ?? '').replace(/^deposit:/, ''))
        .filter(Boolean)
      const totalClaimedSol = claimDepositIds.length
        ? (await db.deposit.aggregate({
            where: { id: { in: claimDepositIds }, userId: user.id },
            _sum: { amountSol: true },
          }))._sum.amountSol
        : null

      return {
        success: true,
        data: {
          tier: 'BALANCED',
          totalValueSol: tokenValueSol.toFixed(6),
          totalClaimedSol: Number(totalClaimedSol ?? 0).toFixed(6),
          claimCount,
          holdings: sw.holdings
            .map((h) => {
              const meta = metaByMint.get(h.tokenMint)
              return {
                tokenMint: h.tokenMint,
                tokenSymbol: meta?.symbol ?? h.tokenMint.slice(0, 6),
                tokenName: meta?.name ?? null,
                amount: h.amount.toString(),
                valueSolEst: Number(h.valueSolEst || 0).toFixed(6),
                marketCapUsd: meta?.marketCapUsd ?? 0,
                weightPct: 0, // filled below
              }
            })
            .sort((a, b) => Number(b.valueSolEst) - Number(a.valueSolEst))
            .map((h) => ({
              ...h,
              weightPct: tokenValueSol > 0
                ? ((Number(h.valueSolEst) / tokenValueSol) * 100).toFixed(1)
                : '0',
            })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to load public vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

}

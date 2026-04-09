import { Worker, type Job, Queue } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getBagsPools,
  getJupiterPrices,
  getDexVolumes,
  getHolderCount,
  getTokenMetadataBatch,
} from '@bags-index/solana'
import {
  QUEUE_SCORING,
  QUEUE_REBALANCE,
  TOP_N_TOKENS,
  RISK_TIERS,
  TIER_SCORING_CONFIG,
  MAX_TOKEN_WEIGHT_PCT,
  type RiskTier,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'
import { reviewToken, type SafetyVerdict } from '../lib/agent-review.js'

const rebalanceQueue = new Queue(QUEUE_REBALANCE, { connection: redis })

interface RawToken {
  tokenMint: string
  tokenSymbol: string
  tokenName: string
  volume24h: number
  holderCount: number
  holderGrowthPct: number
  priceUsd: number
  liquidityUsd: number
  ageDays: number
}

interface ScoringJobData {
  tier?: RiskTier
}

/**
 * Scoring worker — runs once per tier on its own schedule (DEGEN every 4h,
 * BALANCED every 12h, CONSERVATIVE every 24h, with offsets).
 *
 * Each invocation scores ONE tier and writes a tier-scoped ScoringCycle row.
 * Cross-tier disjointness is preserved by reading the latest completed cycles
 * of the other two tiers and excluding the mints they currently hold.
 *
 * A legacy "score-all-three" mode is preserved for the manual /admin trigger:
 * if no tier is supplied, the worker scores all three tiers in sequence using
 * the historical greedy unique-assignment path.
 */
async function processScoring(job: Job<ScoringJobData>) {
  const logger = { info: console.log, error: console.error }
  const requestedTier = job.data?.tier
  if (requestedTier) {
    return processSingleTier(requestedTier, logger)
  }
  logger.info(`[scoring] Starting LEGACY all-tier scoring cycle (job: ${job.id})`)

  const cycle = await db.scoringCycle.create({ data: { status: 'RUNNING' } })

  try {
    // 1. Fetch full Bags universe (migrated to DAMM v2 only)
    const pools = await getBagsPools(true)
    logger.info(`[scoring] ${pools.length} migrated pools on Bags`)
    const allMints = pools.map((p) => p.tokenMint)

    // Stage 1+2: prefilter via Jupiter Price API (free, batched, returns price
    // + confidence + depth in one shot). Drops dead/illiquid/low-confidence.
    const prices = await getJupiterPrices(allMints)
    const MIN_LIQ_USD = 5000
    const survivors = allMints.filter((mint) => {
      const info = prices.get(mint)
      if (!info || !(info.usdPrice > 0)) return false
      if (!(info.liquidity >= MIN_LIQ_USD)) return false
      return true
    })
    logger.info(
      `[scoring] prefilter: ${survivors.length}/${allMints.length} survived Jupiter price+depth`
    )

    // Stage 2.5: DexScreener for real 24h volume (free, batched ≤30/call)
    const volumes = await getDexVolumes(survivors)
    logger.info(`[scoring] dexscreener: ${volumes.size} volume rows`)

    // Stage 3: Helius DAS metadata batch (≤1000 mints/call)
    const metadata = new Map<string, { symbol: string; name: string }>()
    for (let i = 0; i < survivors.length; i += 1000) {
      const slice = survivors.slice(i, i + 1000)
      try {
        const batch = await getTokenMetadataBatch(slice)
        for (const a of batch || []) {
          if (!a) continue
          metadata.set(a.id, {
            symbol: a.content?.metadata?.symbol ?? '',
            name: a.content?.metadata?.name ?? '',
          })
        }
      } catch (err) {
        logger.error(`[scoring] metadata batch failed: ${err}`)
      }
    }

    const tradeable = survivors.map((mint) => ({
      tokenMint: mint,
      symbol: metadata.get(mint)?.symbol ?? mint.slice(0, 6),
      name: metadata.get(mint)?.name ?? 'Unknown',
    }))

    // 2. Previous cycle for holder growth
    const prevCycle = await db.scoringCycle.findFirst({
      where: { status: 'COMPLETED', id: { not: cycle.id } },
      orderBy: { completedAt: 'desc' },
      include: { scores: true },
    })
    const prevHolderMap = new Map(
      prevCycle?.scores.map((s) => [s.tokenMint, s.holderCount]) ?? []
    )

    const blacklisted = new Set(
      (await db.tokenBlacklist.findMany()).map((b) => b.tokenMint)
    )

    // 3. Gather raw signals per token (once — reused across tiers)
    const raw: RawToken[] = []
    for (const token of tradeable) {
      if (blacklisted.has(token.tokenMint)) continue
      try {
        const holderCount = await getHolderCount(token.tokenMint)
        const prevHolders = prevHolderMap.get(token.tokenMint) ?? holderCount
        const holderGrowthPct =
          prevHolders > 0 ? ((holderCount - prevHolders) / prevHolders) * 100 : 0

        const info = prices.get(token.tokenMint)
        const vol = volumes.get(token.tokenMint)
        const priceUsd = vol?.priceUsd || info?.usdPrice || 0
        const liquidityUsd = vol?.liquidityUsd || info?.liquidity || 0
        const volume24h = vol?.volumeH24Usd || 0
        const ageDays = info?.createdAt
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(info.createdAt).getTime()) / 86_400_000)
            )
          : 0
        // TODO: pull true 24h volume from a dedicated source
        raw.push({
          tokenMint: token.tokenMint,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          volume24h,
          holderCount,
          holderGrowthPct,
          priceUsd,
          liquidityUsd,
          ageDays,
        })
      } catch (err) {
        logger.error(`[scoring] Failed to read ${token.symbol}: ${err}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    let totalWritten = 0
    const previousTopByTier = new Map<RiskTier, string[]>()
    for (const tier of RISK_TIERS) {
      previousTopByTier.set(
        tier,
        prevCycle?.scores
          .filter((s) => s.riskTier === tier && s.rank > 0)
          .sort((a, b) => a.rank - b.rank)
          .map((s) => s.tokenMint) ?? []
      )
    }

    // 4. Score every token against every tier's weights independently.
    type Scored = RawToken & { compositeScore: number }
    const scoredByTier = new Map<RiskTier, Scored[]>()
    const universeByTier = new Map<RiskTier, Set<string>>()

    for (const tier of RISK_TIERS) {
      const cfg = TIER_SCORING_CONFIG[tier]
      let universe = raw.filter(
        (t) =>
          t.liquidityUsd >= cfg.minLiquidityUsd &&
          t.holderCount >= cfg.minHolderCount &&
          t.ageDays >= cfg.minAgeDays &&
          ('maxAgeDays' in cfg ? t.ageDays <= cfg.maxAgeDays : true)
      )
      if (universe.length === 0) universe = [...raw] // scaffold fallback

      const maxVolume = Math.max(...universe.map((t) => t.volume24h), 1)
      const maxGrowth = Math.max(...universe.map((t) => Math.max(0, t.holderGrowthPct)), 1)
      const maxLiquidity = Math.max(...universe.map((t) => t.liquidityUsd), 1)

      const scored = universe
        .map((t) => ({
          ...t,
          compositeScore:
            cfg.weights.volume * (t.volume24h / maxVolume) +
            cfg.weights.holderGrowth * (Math.max(0, t.holderGrowthPct) / maxGrowth) +
            cfg.weights.liquidity * (t.liquidityUsd / maxLiquidity),
        }))
        .sort((a, b) => b.compositeScore - a.compositeScore)

      scoredByTier.set(tier, scored)
      universeByTier.set(tier, new Set(universe.map((t) => t.tokenMint)))
    }

    // 5. Layer-A agent safety review — runs ONCE per unique mint, cached.
    //    The agent only removes; it does not reorder or assign.
    const uniqueMints = new Map<string, RawToken>()
    for (const tier of RISK_TIERS) {
      for (const t of scoredByTier.get(tier) ?? []) {
        if (!uniqueMints.has(t.tokenMint)) uniqueMints.set(t.tokenMint, t)
      }
    }
    const reviewByMint = new Map<
      string,
      { verdict: SafetyVerdict; reason: string }
    >()
    for (const [mint, t] of uniqueMints) {
      const r = await reviewToken({
        tokenMint: mint,
        symbol: t.tokenSymbol,
        name: t.tokenName,
        holderCount: t.holderCount,
        liquidityUsd: t.liquidityUsd,
        ageDays: t.ageDays,
        tier: 'BALANCED',
      })
      reviewByMint.set(mint, { verdict: r.verdict, reason: r.reason })
      await db.auditLog.create({
        data: {
          action: 'AGENT_SAFETY_REVIEW',
          resource: `token:${mint}`,
          metadata: {
            cycleId: cycle.id,
            symbol: t.tokenSymbol,
            verdict: r.verdict,
            reason: r.reason,
          },
        },
      })
    }

    // 6. Unique assignment — greedy by best-fit score so tiers diverge.
    //    Build all (tier, token, tierScore) pairs where the token both
    //    (a) passed agent review and (b) is in that tier's filtered universe.
    //    Sort desc by tierScore, walk the list, assign each token to the first
    //    tier that wants it (while that tier still has an open slot ≤ TOP_N).
    //    Result: the token lands in the tier where it scores highest.
    type Pair = { tier: RiskTier; token: Scored }
    const pairs: Pair[] = []
    for (const tier of RISK_TIERS) {
      for (const t of scoredByTier.get(tier) ?? []) {
        if (reviewByMint.get(t.tokenMint)?.verdict !== 'PASS') continue
        pairs.push({ tier, token: t })
      }
    }
    pairs.sort((a, b) => b.token.compositeScore - a.token.compositeScore)

    const assignedByTier = new Map<RiskTier, Scored[]>(
      RISK_TIERS.map((t) => [t, []] as [RiskTier, Scored[]])
    )
    const assignedMints = new Set<string>()
    for (const p of pairs) {
      if (assignedMints.has(p.token.tokenMint)) continue
      const bucket = assignedByTier.get(p.tier)!
      if (bucket.length >= TOP_N_TOKENS) continue
      bucket.push(p.token)
      assignedMints.add(p.token.tokenMint)
    }

    // 6b. Backfill: if a tier is short (universe too small), grab the next-best
    //     PASS tokens that passed ANY universe filter, ignoring uniqueness — we
    //     prefer a full pool over perfect divergence when supply is thin.
    for (const tier of RISK_TIERS) {
      const bucket = assignedByTier.get(tier)!
      if (bucket.length >= TOP_N_TOKENS) continue
      const existing = new Set(bucket.map((t) => t.tokenMint))
      const pool = (scoredByTier.get(tier) ?? []).filter(
        (t) => !existing.has(t.tokenMint) && reviewByMint.get(t.tokenMint)?.verdict === 'PASS',
      )
      for (const t of pool) {
        if (bucket.length >= TOP_N_TOKENS) break
        bucket.push(t)
      }
    }

    // 7. Persist assigned tokens + REMOVED rows for transparency
    for (const tier of RISK_TIERS) {
      const bucket = assignedByTier.get(tier)!
      // Sort bucket by this tier's own score for stable ranking
      bucket.sort((a, b) => b.compositeScore - a.compositeScore)

      // 7a. Apply per-token weight cap. Rewrites compositeScore so the values
      //     sum to 1.0 with no single token exceeding MAX_TOKEN_WEIGHT_PCT.
      //     Downstream `score / sum(scores)` naturally yields the capped weight.
      if (bucket.length > 0) {
        const total = bucket.reduce((s, t) => s + t.compositeScore, 0) || 1
        const weights = new Map<string, number>(
          bucket.map((t) => [t.tokenMint, t.compositeScore / total]),
        )
        for (let iter = 0; iter < 10; iter++) {
          let excess = 0
          const capped = new Set<string>()
          for (const [mint, w] of weights) {
            if (w > MAX_TOKEN_WEIGHT_PCT) {
              excess += w - MAX_TOKEN_WEIGHT_PCT
              weights.set(mint, MAX_TOKEN_WEIGHT_PCT)
              capped.add(mint)
            }
          }
          if (excess === 0) break
          const uncappedSum = [...weights.entries()]
            .filter(([m]) => !capped.has(m))
            .reduce((s, [, w]) => s + w, 0)
          if (uncappedSum === 0) break
          for (const [mint, w] of weights) {
            if (!capped.has(mint)) {
              weights.set(mint, w + excess * (w / uncappedSum))
            }
          }
        }
        for (const t of bucket) {
          t.compositeScore = weights.get(t.tokenMint) ?? 0
        }
      }

      for (let i = 0; i < bucket.length; i++) {
        const t = bucket[i]
        const r = reviewByMint.get(t.tokenMint)!
        await db.tokenScore.create({
          data: {
            cycleId: cycle.id,
            riskTier: tier,
            tokenMint: t.tokenMint,
            tokenSymbol: t.tokenSymbol,
            tokenName: t.tokenName,
            volume24h: t.volume24h,
            holderCount: t.holderCount,
            holderGrowthPct: t.holderGrowthPct,
            priceUsd: t.priceUsd,
            liquidityUsd: t.liquidityUsd,
            compositeScore: t.compositeScore,
            rank: i + 1,
            safetyVerdict: r.verdict,
            safetyReason: r.reason,
          },
        })
      }
      // Removed tokens: write once per tier they were a candidate in
      const removed = (scoredByTier.get(tier) ?? []).filter(
        (t) => reviewByMint.get(t.tokenMint)?.verdict === 'REMOVED',
      )
      for (const t of removed) {
        const r = reviewByMint.get(t.tokenMint)!
        await db.tokenScore.create({
          data: {
            cycleId: cycle.id,
            riskTier: tier,
            tokenMint: t.tokenMint,
            tokenSymbol: t.tokenSymbol,
            tokenName: t.tokenName,
            volume24h: t.volume24h,
            holderCount: t.holderCount,
            holderGrowthPct: t.holderGrowthPct,
            priceUsd: t.priceUsd,
            liquidityUsd: t.liquidityUsd,
            compositeScore: t.compositeScore,
            rank: 0,
            isBlacklisted: true,
            safetyVerdict: 'REMOVED',
            safetyReason: r.reason,
          },
        })
      }

      totalWritten += bucket.length
      logger.info(
        `[scoring] ${tier}: ${bucket.length} assigned, ${removed.length} removed`,
      )

      // Enqueue per-tier rebalance if composition changed
      const newTop = bucket.map((t) => t.tokenMint).sort()
      const prevTop = [...(previousTopByTier.get(tier) ?? [])].sort()
      if (JSON.stringify(prevTop) !== JSON.stringify(newTop) && bucket.length > 0) {
        await rebalanceQueue.add(`rebalance-${tier}`, {
          scoringCycleId: cycle.id,
          riskTier: tier,
        })
        logger.info(`[scoring] ${tier}: rankings changed — rebalance enqueued`)
      }
    }

    await db.scoringCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        tokenCount: totalWritten,
      },
    })
    logger.info(`[scoring] Cycle ${cycle.id} complete — ${totalWritten} scores written`)
  } catch (err) {
    logger.error(`[scoring] Cycle failed: ${err}`)
    await db.scoringCycle.update({
      where: { id: cycle.id },
      data: { status: 'FAILED' },
    })
    throw err
  }
}

/**
 * Single-tier scoring path. Creates a tier-scoped ScoringCycle, builds the
 * universe via Bags + Jupiter + DexScreener + Helius, scores against this
 * tier's weights, excludes mints currently held by the other two tiers'
 * latest completed cycles (so the three baskets stay disjoint without
 * needing to score them simultaneously), runs Layer-A safety review,
 * persists the top-10 + REMOVED rows, and enqueues a per-tier rebalance.
 */
async function processSingleTier(
  tier: RiskTier,
  logger: { info: (m: string) => void; error: (m: string) => void },
) {
  logger.info(`[scoring] Starting per-tier scoring for ${tier}`)
  const cycle = await db.scoringCycle.create({
    data: { status: 'RUNNING', tier },
  })

  try {
    // 1. Universe fetch (same pipeline as legacy path)
    const pools = await getBagsPools(true)
    const allMints = pools.map((p) => p.tokenMint)
    const prices = await getJupiterPrices(allMints)
    const MIN_LIQ_USD = 5000
    const survivors = allMints.filter((mint) => {
      const info = prices.get(mint)
      return !!info && info.usdPrice > 0 && info.liquidity >= MIN_LIQ_USD
    })
    const volumes = await getDexVolumes(survivors)
    const metadata = new Map<string, { symbol: string; name: string }>()
    for (let i = 0; i < survivors.length; i += 1000) {
      try {
        const batch = await getTokenMetadataBatch(survivors.slice(i, i + 1000))
        for (const a of batch || []) {
          if (!a) continue
          metadata.set(a.id, {
            symbol: a.content?.metadata?.symbol ?? '',
            name: a.content?.metadata?.name ?? '',
          })
        }
      } catch (err) {
        logger.error(`[scoring/${tier}] metadata batch failed: ${err}`)
      }
    }

    // 2. Holder growth baseline = previous COMPLETED cycle for THIS tier
    const prevCycle = await db.scoringCycle.findFirst({
      where: { status: 'COMPLETED', tier, id: { not: cycle.id } },
      orderBy: { completedAt: 'desc' },
      include: { scores: true },
    })
    const prevHolderMap = new Map(
      prevCycle?.scores.map((s) => [s.tokenMint, s.holderCount]) ?? [],
    )
    const previousTopMints = (prevCycle?.scores ?? [])
      .filter((s) => s.rank > 0)
      .sort((a, b) => a.rank - b.rank)
      .map((s) => s.tokenMint)

    // 3. Disjointness — exclude tokens currently held by the OTHER two tiers'
    //    latest completed cycles. Each tier's basket stays unique without
    //    requiring simultaneous scoring runs.
    const otherTiers = RISK_TIERS.filter((t) => t !== tier)
    const excludedMints = new Set<string>()
    for (const ot of otherTiers) {
      const otherCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED', tier: ot },
        orderBy: { completedAt: 'desc' },
        select: { id: true },
      })
      if (!otherCycle) continue
      const otherScores = await db.tokenScore.findMany({
        where: {
          cycleId: otherCycle.id,
          isBlacklisted: false,
          rank: { gt: 0 },
        },
        select: { tokenMint: true },
      })
      for (const s of otherScores) excludedMints.add(s.tokenMint)
    }

    const blacklisted = new Set(
      (await db.tokenBlacklist.findMany()).map((b) => b.tokenMint),
    )

    // 4. Build raw signals for tradeable tokens
    const tradeable = survivors
      .filter((m) => !blacklisted.has(m) && !excludedMints.has(m))
      .map((mint) => ({
        tokenMint: mint,
        symbol: metadata.get(mint)?.symbol ?? mint.slice(0, 6),
        name: metadata.get(mint)?.name ?? 'Unknown',
      }))

    const raw: RawToken[] = []
    for (const token of tradeable) {
      try {
        const holderCount = await getHolderCount(token.tokenMint)
        const prevHolders = prevHolderMap.get(token.tokenMint) ?? holderCount
        const holderGrowthPct =
          prevHolders > 0 ? ((holderCount - prevHolders) / prevHolders) * 100 : 0
        const info = prices.get(token.tokenMint)
        const vol = volumes.get(token.tokenMint)
        const priceUsd = vol?.priceUsd || info?.usdPrice || 0
        const liquidityUsd = vol?.liquidityUsd || info?.liquidity || 0
        const volume24h = vol?.volumeH24Usd || 0
        const ageDays = info?.createdAt
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(info.createdAt).getTime()) / 86_400_000),
            )
          : 0
        raw.push({
          tokenMint: token.tokenMint,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          volume24h,
          holderCount,
          holderGrowthPct,
          priceUsd,
          liquidityUsd,
          ageDays,
        })
      } catch (err) {
        logger.error(`[scoring/${tier}] read failed ${token.symbol}: ${err}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    // 5. Apply this tier's universe filter + score
    const cfg = TIER_SCORING_CONFIG[tier]
    let universe = raw.filter(
      (t) =>
        t.liquidityUsd >= cfg.minLiquidityUsd &&
        t.holderCount >= cfg.minHolderCount &&
        t.ageDays >= cfg.minAgeDays &&
        ('maxAgeDays' in cfg ? t.ageDays <= cfg.maxAgeDays : true),
    )
    if (universe.length === 0) universe = [...raw]

    const maxVolume = Math.max(...universe.map((t) => t.volume24h), 1)
    const maxGrowth = Math.max(...universe.map((t) => Math.max(0, t.holderGrowthPct)), 1)
    const maxLiquidity = Math.max(...universe.map((t) => t.liquidityUsd), 1)

    type Scored = RawToken & { compositeScore: number }
    const scored: Scored[] = universe
      .map((t) => ({
        ...t,
        compositeScore:
          cfg.weights.volume * (t.volume24h / maxVolume) +
          cfg.weights.holderGrowth * (Math.max(0, t.holderGrowthPct) / maxGrowth) +
          cfg.weights.liquidity * (t.liquidityUsd / maxLiquidity),
      }))
      .sort((a, b) => b.compositeScore - a.compositeScore)

    // 6. Layer-A safety review on the top candidates we might keep
    const candidates = scored.slice(0, TOP_N_TOKENS * 3)
    const reviewByMint = new Map<string, { verdict: SafetyVerdict; reason: string }>()
    for (const t of candidates) {
      const r = await reviewToken({
        tokenMint: t.tokenMint,
        symbol: t.tokenSymbol,
        name: t.tokenName,
        holderCount: t.holderCount,
        liquidityUsd: t.liquidityUsd,
        ageDays: t.ageDays,
        tier,
      })
      reviewByMint.set(t.tokenMint, { verdict: r.verdict, reason: r.reason })
      await db.auditLog.create({
        data: {
          action: 'AGENT_SAFETY_REVIEW',
          resource: `token:${t.tokenMint}`,
          metadata: {
            cycleId: cycle.id,
            tier,
            symbol: t.tokenSymbol,
            verdict: r.verdict,
            reason: r.reason,
          },
        },
      })
    }

    // 7. Take top-N PASS tokens
    const bucket: Scored[] = []
    for (const t of scored) {
      if (bucket.length >= TOP_N_TOKENS) break
      const r = reviewByMint.get(t.tokenMint)
      if (!r) continue
      if (r.verdict !== 'PASS') continue
      bucket.push(t)
    }

    // 8. Apply per-token weight cap (same as legacy path)
    if (bucket.length > 0) {
      const total = bucket.reduce((s, t) => s + t.compositeScore, 0) || 1
      const weights = new Map<string, number>(
        bucket.map((t) => [t.tokenMint, t.compositeScore / total]),
      )
      for (let iter = 0; iter < 10; iter++) {
        let excess = 0
        const capped = new Set<string>()
        for (const [mint, w] of weights) {
          if (w > MAX_TOKEN_WEIGHT_PCT) {
            excess += w - MAX_TOKEN_WEIGHT_PCT
            weights.set(mint, MAX_TOKEN_WEIGHT_PCT)
            capped.add(mint)
          }
        }
        if (excess === 0) break
        const uncappedSum = [...weights.entries()]
          .filter(([m]) => !capped.has(m))
          .reduce((s, [, w]) => s + w, 0)
        if (uncappedSum === 0) break
        for (const [mint, w] of weights) {
          if (!capped.has(mint)) {
            weights.set(mint, w + excess * (w / uncappedSum))
          }
        }
      }
      for (const t of bucket) {
        t.compositeScore = weights.get(t.tokenMint) ?? 0
      }
    }

    // 9. Persist top-N + REMOVED rows
    for (let i = 0; i < bucket.length; i++) {
      const t = bucket[i]
      const r = reviewByMint.get(t.tokenMint)!
      await db.tokenScore.create({
        data: {
          cycleId: cycle.id,
          riskTier: tier,
          tokenMint: t.tokenMint,
          tokenSymbol: t.tokenSymbol,
          tokenName: t.tokenName,
          volume24h: t.volume24h,
          holderCount: t.holderCount,
          holderGrowthPct: t.holderGrowthPct,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          compositeScore: t.compositeScore,
          rank: i + 1,
          safetyVerdict: r.verdict,
          safetyReason: r.reason,
        },
      })
    }
    const removed = candidates.filter(
      (t) => reviewByMint.get(t.tokenMint)?.verdict === 'REMOVED',
    )
    for (const t of removed) {
      const r = reviewByMint.get(t.tokenMint)!
      await db.tokenScore.create({
        data: {
          cycleId: cycle.id,
          riskTier: tier,
          tokenMint: t.tokenMint,
          tokenSymbol: t.tokenSymbol,
          tokenName: t.tokenName,
          volume24h: t.volume24h,
          holderCount: t.holderCount,
          holderGrowthPct: t.holderGrowthPct,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          compositeScore: t.compositeScore,
          rank: 0,
          isBlacklisted: true,
          safetyVerdict: 'REMOVED',
          safetyReason: r.reason,
        },
      })
    }

    await db.scoringCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        tokenCount: bucket.length,
      },
    })
    logger.info(
      `[scoring/${tier}] complete — ${bucket.length} assigned, ${removed.length} removed`,
    )

    // 10. Enqueue rebalance only if composition changed
    const newTopSorted = bucket.map((t) => t.tokenMint).sort()
    const prevTopSorted = [...previousTopMints].sort()
    if (
      bucket.length > 0 &&
      JSON.stringify(prevTopSorted) !== JSON.stringify(newTopSorted)
    ) {
      await rebalanceQueue.add(`rebalance-${tier}-${cycle.id}`, {
        scoringCycleId: cycle.id,
        riskTier: tier,
      })
      logger.info(`[scoring/${tier}] composition changed — rebalance enqueued`)
    } else {
      logger.info(`[scoring/${tier}] composition unchanged — no rebalance`)
    }
  } catch (err) {
    logger.error(`[scoring/${tier}] failed: ${err}`)
    await db.scoringCycle.update({
      where: { id: cycle.id },
      data: { status: 'FAILED' },
    })
    throw err
  }
}

export function createScoringWorker() {
  const worker = new Worker(QUEUE_SCORING, processScoring, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[scoring] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[scoring] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

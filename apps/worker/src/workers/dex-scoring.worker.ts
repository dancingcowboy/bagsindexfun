import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import {
  getDexscreenerTopSolanaMints,
  getDexVolumes,
  getHolderCount,
  getTokenMetadataBatch,
} from '@bags-index/solana'
import {
  QUEUE_DEX_SCORING,
  DEXSCREENER_UNIVERSE_SIZE,
  RISK_TIERS,
  TIER_SCORING_CONFIG,
  MAX_TOKEN_WEIGHT_PCT,
  type RiskTier,
} from '@bags-index/shared'
import { redis } from '../queue/redis.js'

interface RawToken {
  tokenMint: string
  tokenSymbol: string
  tokenName: string
  volume24h: number
  holderCount: number
  holderGrowthPct: number
  priceUsd: number
  liquidityUsd: number
  marketCapUsd: number
  ageDays: number
}

const SOURCE = 'DEXSCREENER'

async function processDexScoring(job: Job) {
  const logger = { info: console.log, error: console.error }
  logger.info(`[dex-scoring] start (job: ${job.id})`)

  const cycles: Record<RiskTier, { id: string }> = {} as any
  for (const tier of RISK_TIERS) {
    const c = await db.scoringCycle.create({
      data: { status: 'RUNNING', tier, source: SOURCE },
    })
    cycles[tier] = { id: c.id }
  }

  try {
    // 1. Universe — top N Solana mints by 24h volume on DexScreener
    const mints = await getDexscreenerTopSolanaMints(DEXSCREENER_UNIVERSE_SIZE)
    logger.info(`[dex-scoring] universe size: ${mints.length}`)
    if (mints.length === 0) throw new Error('empty dexscreener universe')

    // 2. Enrich (re-call — cheap, free API)
    const volumes = await getDexVolumes(mints)

    // 3. Metadata batch (1 Helius call)
    const metaBatch = await getTokenMetadataBatch(mints)
    const metadata = new Map<string, { symbol: string; name: string }>()
    for (const a of metaBatch || []) {
      if (!a) continue
      metadata.set(a.id, {
        symbol: a.content?.metadata?.symbol ?? '',
        name: a.content?.metadata?.name ?? '',
      })
    }

    // 4. Previous DexScreener cycles for holder growth (per tier, latest)
    const prevByTier = new Map<RiskTier, Map<string, number>>()
    for (const tier of RISK_TIERS) {
      const prev = await db.scoringCycle.findFirst({
        where: {
          status: 'COMPLETED',
          tier,
          source: SOURCE,
          id: { not: cycles[tier].id },
        },
        orderBy: { completedAt: 'desc' },
        include: { scores: true },
      })
      prevByTier.set(
        tier,
        new Map(prev?.scores.map((s) => [s.tokenMint, s.holderCount]) ?? [])
      )
    }

    const blacklisted = new Set(
      (await db.tokenBlacklist.findMany()).map((b) => b.tokenMint)
    )

    // 5. Gather raw signals (serial with 200ms throttle → 30 Helius calls)
    const raw: RawToken[] = []
    for (const mint of mints) {
      if (blacklisted.has(mint)) continue
      try {
        const holderCount = await getHolderCount(mint, { maxPages: 1 })
        // Use CONSERVATIVE tier's history as the reference growth baseline (flat list)
        const prevHolders =
          prevByTier.get('CONSERVATIVE')?.get(mint) ?? holderCount
        const holderGrowthPct =
          prevHolders > 0 ? ((holderCount - prevHolders) / prevHolders) * 100 : 0
        const vol = volumes.get(mint)
        const priceUsd = vol?.priceUsd || 0
        const liquidityUsd = vol?.liquidityUsd || 0
        const volume24h = vol?.volumeH24Usd || 0
        const marketCapUsd = vol?.marketCapUsd || 0
        const ageDays = vol?.pairCreatedAt
          ? Math.max(
              0,
              Math.floor((Date.now() - vol.pairCreatedAt) / 86_400_000)
            )
          : 0
        const meta = metadata.get(mint)
        raw.push({
          tokenMint: mint,
          tokenSymbol: meta?.symbol || mint.slice(0, 6),
          tokenName: meta?.name || 'Unknown',
          volume24h,
          holderCount,
          holderGrowthPct,
          priceUsd,
          liquidityUsd,
          marketCapUsd,
          ageDays,
        })
      } catch (err) {
        logger.error(`[dex-scoring] failed ${mint}: ${err}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    // 6. Per-tier scoring — SAME universe, DIFFERENT weights (no disjointness)
    for (const tier of RISK_TIERS) {
      const cfg = TIER_SCORING_CONFIG[tier]
      // Keep full universe visible; do NOT hard-filter like the Bags pipeline.
      // Admin wants raw top-30 view per risk lens.
      const universe = raw
      if (universe.length === 0) continue

      const maxVolume = Math.max(...universe.map((t) => t.volume24h), 1)
      const maxGrowth = Math.max(
        ...universe.map((t) => Math.max(0, t.holderGrowthPct)),
        1
      )
      const maxLiquidity = Math.max(...universe.map((t) => t.liquidityUsd), 1)

      const scored = universe
        .map((t) => ({
          ...t,
          compositeScore:
            cfg.weights.volume * (t.volume24h / maxVolume) +
            cfg.weights.holderGrowth *
              (Math.max(0, t.holderGrowthPct) / maxGrowth) +
            cfg.weights.liquidity * (t.liquidityUsd / maxLiquidity),
        }))
        .sort((a, b) => b.compositeScore - a.compositeScore)

      // Apply per-token cap (normalize to weights, iterative cap to MAX_TOKEN_WEIGHT_PCT)
      const total = scored.reduce((s, t) => s + t.compositeScore, 0) || 1
      let weights = scored.map((t) => t.compositeScore / total)
      for (let iter = 0; iter < 10; iter++) {
        const over = weights.findIndex((w) => w > MAX_TOKEN_WEIGHT_PCT)
        if (over < 0) break
        const excess = weights[over] - MAX_TOKEN_WEIGHT_PCT
        weights[over] = MAX_TOKEN_WEIGHT_PCT
        const others = weights
          .map((_, i) => i)
          .filter((i) => i !== over && weights[i] < MAX_TOKEN_WEIGHT_PCT)
        if (others.length === 0) break
        const share = excess / others.length
        for (const i of others) weights[i] += share
      }

      await db.tokenScore.createMany({
        data: scored.map((t, i) => ({
          cycleId: cycles[tier].id,
          riskTier: tier,
          tokenMint: t.tokenMint,
          tokenSymbol: t.tokenSymbol,
          tokenName: t.tokenName,
          volume24h: t.volume24h,
          holderCount: t.holderCount,
          holderGrowthPct: t.holderGrowthPct,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          marketCapUsd: t.marketCapUsd,
          compositeScore: t.compositeScore,
          rank: i + 1,
          source: SOURCE,
        })),
      })

      await db.scoringCycle.update({
        where: { id: cycles[tier].id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          tokenCount: scored.length,
        },
      })
      logger.info(
        `[dex-scoring] ${tier}: ${scored.length} tokens scored, top=${scored[0]?.tokenSymbol}`
      )
    }

    logger.info(`[dex-scoring] done`)
  } catch (err) {
    logger.error(`[dex-scoring] failed: ${err}`)
    for (const tier of RISK_TIERS) {
      await db.scoringCycle
        .update({
          where: { id: cycles[tier].id },
          data: { status: 'FAILED', completedAt: new Date() },
        })
        .catch(() => {})
    }
    throw err
  }
}

export function createDexScoringWorker() {
  return new Worker(QUEUE_DEX_SCORING, processDexScoring, {
    connection: redis,
    concurrency: 1,
  })
}

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
  TOP_N_TOKENS,
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

type Scored = RawToken & { compositeScore: number }

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
    // 1. Universe
    const mints = await getDexscreenerTopSolanaMints(DEXSCREENER_UNIVERSE_SIZE)
    logger.info(`[dex-scoring] universe: ${mints.length}`)
    if (mints.length === 0) throw new Error('empty dexscreener universe')

    // 2. Enrich
    const volumes = await getDexVolumes(mints)

    // 3. Metadata (1 Helius call)
    const metaBatch = await getTokenMetadataBatch(mints)
    const metadata = new Map<string, { symbol: string; name: string }>()
    for (const a of metaBatch || []) {
      if (!a) continue
      metadata.set(a.id, {
        symbol: a.content?.metadata?.symbol ?? '',
        name: a.content?.metadata?.name ?? '',
      })
    }

    // 4. Previous CONSERVATIVE cycle for holder growth baseline
    const prev = await db.scoringCycle.findFirst({
      where: {
        status: 'COMPLETED',
        tier: 'CONSERVATIVE',
        source: SOURCE,
      },
      orderBy: { completedAt: 'desc' },
      include: { scores: true },
    })
    const prevHolderMap = new Map<string, number>(
      prev?.scores.map((s) => [s.tokenMint, s.holderCount]) ?? []
    )

    const blacklisted = new Set(
      (await db.tokenBlacklist.findMany()).map((b) => b.tokenMint)
    )

    // 5. Gather raw signals (30 Helius calls, 1 page each)
    const raw: RawToken[] = []
    for (const mint of mints) {
      if (blacklisted.has(mint)) continue
      try {
        const holderCount = await getHolderCount(mint, { maxPages: 1 })
        const prevHolders = prevHolderMap.get(mint) ?? holderCount
        const holderGrowthPct =
          prevHolders > 0
            ? ((holderCount - prevHolders) / prevHolders) * 100
            : 0
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

    // 6. Per-tier scoring against full universe (no hard tier filters — raw admin intel)
    const scoredByTier = new Map<RiskTier, Scored[]>()
    for (const tier of RISK_TIERS) {
      const cfg = TIER_SCORING_CONFIG[tier]
      const maxVolume = Math.max(...raw.map((t) => t.volume24h), 1)
      const maxGrowth = Math.max(
        ...raw.map((t) => Math.max(0, t.holderGrowthPct)),
        1
      )
      const maxLiquidity = Math.max(...raw.map((t) => t.liquidityUsd), 1)
      const scored = raw
        .map((t) => ({
          ...t,
          compositeScore:
            cfg.weights.volume * (t.volume24h / maxVolume) +
            cfg.weights.holderGrowth *
              (Math.max(0, t.holderGrowthPct) / maxGrowth) +
            cfg.weights.liquidity * (t.liquidityUsd / maxLiquidity),
        }))
        .sort((a, b) => b.compositeScore - a.compositeScore)
      scoredByTier.set(tier, scored)
    }

    // 7. Greedy disjoint assignment — each mint lands in the tier where it
    //    scores highest; each tier holds top TOP_N_TOKENS unique picks.
    type Pair = { tier: RiskTier; token: Scored }
    const pairs: Pair[] = []
    for (const tier of RISK_TIERS) {
      for (const t of scoredByTier.get(tier) ?? []) {
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

    // 7b. Backfill thin tiers (universe may be under 30 if DexScreener endpoints stale)
    for (const tier of RISK_TIERS) {
      const bucket = assignedByTier.get(tier)!
      if (bucket.length >= TOP_N_TOKENS) continue
      const existing = new Set(bucket.map((t) => t.tokenMint))
      for (const t of scoredByTier.get(tier) ?? []) {
        if (bucket.length >= TOP_N_TOKENS) break
        if (existing.has(t.tokenMint)) continue
        bucket.push(t)
      }
    }

    // 8. Persist + apply per-token weight cap per tier
    for (const tier of RISK_TIERS) {
      const bucket = assignedByTier.get(tier)!
      bucket.sort((a, b) => b.compositeScore - a.compositeScore)

      if (bucket.length > 0) {
        const total = bucket.reduce((s, t) => s + t.compositeScore, 0) || 1
        const weights = new Map<string, number>(
          bucket.map((t) => [t.tokenMint, t.compositeScore / total])
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

      await db.tokenScore.createMany({
        data: bucket.map((t, i) => ({
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
          tokenCount: bucket.length,
        },
      })
      logger.info(
        `[dex-scoring] ${tier}: ${bucket.length} picks, top=${bucket[0]?.tokenSymbol}`
      )
    }

    // 9. Price snapshots for charting — one row per mint per cycle.
    //    Convert USD → SOL so values are consistent with the hourly
    //    price-snapshot worker (which also stores SOL-denominated prices).
    const snapshotMints = new Set<string>()
    for (const tier of RISK_TIERS) {
      for (const t of assignedByTier.get(tier)!) snapshotMints.add(t.tokenMint)
    }

    // Get SOL/USD for conversion — same approach as price-snapshot worker.
    const SOL_MINT = 'So11111111111111111111111111111111111111112'
    const solDex = await getDexVolumes([SOL_MINT])
    let solUsd = Number(solDex.get(SOL_MINT)?.priceUsd ?? 0)
    if (solUsd <= 0) {
      try {
        const solRes = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`,
          { signal: AbortSignal.timeout(10_000) },
        )
        const solData = await solRes.json() as any
        const pairs: any[] = Array.isArray(solData) ? solData : solData?.pairs ?? []
        if (pairs.length > 0) {
          const best = pairs.reduce((a: any, p: any) =>
            (Number(p?.liquidity?.usd) || 0) > (Number(a?.liquidity?.usd) || 0) ? p : a,
            pairs[0],
          )
          solUsd = Number(best?.priceUsd) || 0
        }
      } catch { /* skip SOL pricing this cycle */ }
    }
    logger.info(`[dex-scoring] SOL/USD for snapshots: $${solUsd.toFixed(2)}`)

    const now = new Date()
    const snapshotRows: Array<{
      tokenMint: string
      priceSol: string
      marketCapUsd: string
      createdAt: Date
    }> = []
    for (const mint of snapshotMints) {
      const v = volumes.get(mint)
      if (!v || !(v.priceUsd > 0)) continue
      // Convert USD → SOL for consistency with hourly price-snapshot worker.
      const priceSol = solUsd > 0 ? v.priceUsd / solUsd : 0
      if (priceSol <= 0) continue
      snapshotRows.push({
        tokenMint: mint,
        priceSol: priceSol.toFixed(12),
        marketCapUsd: v.marketCapUsd.toFixed(2),
        createdAt: now,
      })
    }
    if (snapshotRows.length > 0) {
      await db.tokenPriceSnapshot.createMany({ data: snapshotRows })
      logger.info(
        `[dex-scoring] wrote ${snapshotRows.length} price snapshots for chart`
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

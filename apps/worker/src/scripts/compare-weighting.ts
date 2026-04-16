/**
 * One-shot analysis: replay each tier's aggregate index line two ways
 * and print the cumulative cumulative return.
 *   - "weighted":   current algorithm (compositeScore-weighted inside
 *                   each top-10, BAGSX pinned at 10%, SOL anchor as cash)
 *   - "equal":      same basket, but every scored mint gets 1/10 of the
 *                   scored allocation slice — so the biggest and the
 *                   smallest token each carry the same load.
 * Mirrors the honest-replay algorithm from
 * apps/api/src/routes/index-info.ts aggregate-history handler.
 *
 * Usage: npx tsx src/scripts/compare-weighting.ts [hours=720]
 */
import { db } from '@bags-index/db'
import { BAGSX_MINT, BAGSX_WEIGHT_PCT, TIER_SCORING_CONFIG } from '@bags-index/shared'

const HOUR_MS = 60 * 60 * 1000
const hours = Math.max(1, Math.min(parseInt(process.argv[2] ?? '720', 10), 24 * 90))

type Tier = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
type Mode = 'weighted' | 'equal' | 'squared' | 'sqrt' | 'bucketed'
const TIERS: Tier[] = ['CONSERVATIVE', 'BALANCED', 'DEGEN']
const MODES: Mode[] = ['weighted', 'equal', 'squared', 'sqrt', 'bucketed']

async function replayTier(tier: Tier, mode: Mode) {
  const since = new Date(Date.now() - hours * HOUR_MS)

  const [activeAtStart, withinRange] = await Promise.all([
    db.scoringCycle.findFirst({
      where: { status: 'COMPLETED', source: 'BAGS', tier, completedAt: { not: null, lte: since } },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true },
    }),
    db.scoringCycle.findMany({
      where: { status: 'COMPLETED', source: 'BAGS', tier, completedAt: { gt: since } },
      orderBy: { completedAt: 'asc' },
      select: { id: true, completedAt: true },
    }),
  ])
  const cycles = [...(activeAtStart ? [activeAtStart] : []), ...withinRange]
  if (cycles.length === 0) return { index: 100, points: 0, cycles: 0 }

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
    if (mode === 'weighted') {
      const total = scores.reduce((a, s) => a + Number(s.compositeScore), 0) || 1
      for (const s of scores) {
        basket.set(s.tokenMint, (Number(s.compositeScore) / total) * scoredScale)
        allMints.add(s.tokenMint)
      }
    } else if (mode === 'squared') {
      const total = scores.reduce((a, s) => a + Number(s.compositeScore) ** 2, 0) || 1
      for (const s of scores) {
        basket.set(s.tokenMint, (Number(s.compositeScore) ** 2 / total) * scoredScale)
        allMints.add(s.tokenMint)
      }
    } else if (mode === 'sqrt') {
      const total = scores.reduce((a, s) => a + Math.sqrt(Number(s.compositeScore)), 0) || 1
      for (const s of scores) {
        basket.set(s.tokenMint, (Math.sqrt(Number(s.compositeScore)) / total) * scoredScale)
        allMints.add(s.tokenMint)
      }
    } else if (mode === 'bucketed') {
      // Top 3 → 50% of scored slice, next 3 → 30%, rest → 20%, split equally within bucket.
      const ranked = [...scores].sort(
        (a, b) => Number(b.compositeScore) - Number(a.compositeScore),
      )
      const buckets: [typeof ranked, number][] = [
        [ranked.slice(0, 3), 0.5],
        [ranked.slice(3, 6), 0.3],
        [ranked.slice(6), 0.2],
      ]
      for (const [group, share] of buckets) {
        if (group.length === 0) continue
        const per = (share * scoredScale) / group.length
        for (const s of group) {
          basket.set(s.tokenMint, per)
          allMints.add(s.tokenMint)
        }
      }
    } else {
      const n = scores.length || 1
      const perToken = scoredScale / n
      for (const s of scores) {
        basket.set(s.tokenMint, perToken)
        allMints.add(s.tokenMint)
      }
    }
    basket.set(BAGSX_MINT, BAGSX_WEIGHT_PCT / 100)
    basketByCycle.set(c.id, basket)
  }

  const priceSince = new Date(since.getTime() - 24 * HOUR_MS)
  const samples = await db.tokenPriceSnapshot.findMany({
    where: { tokenMint: { in: [...allMints] }, createdAt: { gte: priceSince } },
    orderBy: { createdAt: 'asc' },
    select: { tokenMint: true, priceSol: true, createdAt: true },
  })
  const seriesByMint = new Map<string, { t: number; price: number }[]>()
  for (const s of samples) {
    const arr = seriesByMint.get(s.tokenMint) ?? []
    arr.push({ t: s.createdAt.getTime(), price: Number(s.priceSol) })
    seriesByMint.set(s.tokenMint, arr)
  }
  const priceAt = (mint: string, t: number): number | null => {
    const arr = seriesByMint.get(mint)
    if (!arr || arr.length === 0) return null
    let lo = 0, hi = arr.length - 1, chosen = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].t <= t) { chosen = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return chosen < 0 ? null : arr[chosen].price
  }
  const cycleTimes = cycles.map((c) => ({ t: c.completedAt!.getTime(), id: c.id }))
  const activeCycleAt = (t: number): string | null => {
    let lo = 0, hi = cycleTimes.length - 1, chosen = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cycleTimes[mid].t <= t) { chosen = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return chosen < 0 ? null : cycleTimes[chosen].id
  }

  const startBucket = new Date(since)
  startBucket.setMinutes(0, 0, 0)
  const nowFloor = new Date()
  nowFloor.setMinutes(0, 0, 0)

  let index = 100
  let prevTime = -1
  let prevCycleId: string | null = null
  let points = 0
  for (let t = startBucket.getTime(); t <= nowFloor.getTime(); t += HOUR_MS) {
    const cycleId = activeCycleAt(t)
    if (!cycleId) continue
    const basket = basketByCycle.get(cycleId)
    if (!basket) continue
    if (prevTime < 0) {
      let any = false
      for (const mint of basket.keys()) if (priceAt(mint, t) !== null) { any = true; break }
      if (!any) continue
      points++
      prevTime = t
      prevCycleId = cycleId
      continue
    }
    if (cycleId !== prevCycleId) {
      points++
      prevTime = t
      prevCycleId = cycleId
      continue
    }
    let stepRet = 0, wSum = 0
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
      index *= 1 + stepRet
    }
    points++
    prevTime = t
    prevCycleId = cycleId
  }
  return { index, points, cycles: cycles.length }
}

async function main() {
  const fmt = (n: number) => (n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`)
  console.log(`\nWeighting-scheme comparison  (last ${hours}h)\n`)
  const header =
    'Tier          | ' + MODES.map((m) => m.padEnd(8)).join(' | ') + ' | Cycles | Points'
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const tier of TIERS) {
    const results = await Promise.all(MODES.map((m) => replayTier(tier, m)))
    const cells = results.map((r) => fmt(r.index - 100).padStart(8))
    const cycles = results[0].cycles
    const points = results[0].points
    console.log(
      `${tier.padEnd(13)} | ${cells.join(' | ')} | ${String(cycles).padStart(6)} | ${String(points).padStart(6)}`,
    )
  }
  console.log(
    '\nweighted = compositeScore / Σscore  (current live algorithm)',
  )
  console.log('equal    = 1/n per token')
  console.log('squared  = score² / Σscore²  (concentrates on top picks)')
  console.log('sqrt     = √score / Σ√score  (flattens toward equal)')
  console.log('bucketed = top3:50% / next3:30% / rest:20%, equal within each bucket')
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

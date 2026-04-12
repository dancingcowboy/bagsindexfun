import { db } from '@bags-index/db'
import type { RiskTier } from '@bags-index/shared'
import { postTweet } from './twitter.js'
import { mirrorTweetToTelegram } from './telegram.js'

const TIER_EMOJI: Record<string, string> = {
  CONSERVATIVE: '🟢',
  BALANCED: '🟡',
  DEGEN: '🔴',
}

/**
 * Build and post a tweet announcing a single tier's reshuffle:
 * - Top 3 selected tokens
 * - Tokens added / dropped vs the previous COMPLETED cycle for THIS tier
 * - One-line reasoning (top driver across this tier's scores)
 *
 * Mirrors to Telegram via the standard helper. Never throws — failure here
 * must not block the rebalance worker.
 *
 * Per-tier scoring schedules mean each tier reshuffle posts its own update,
 * rather than the legacy "daily summary across all 3 tiers" tweet.
 */
export async function postRebalanceAnnouncement(scoringCycleId: string): Promise<void> {
  console.log(`[rebalance-tweet] entry cycle=${scoringCycleId}`)
  if (!process.env.TWITTER_API_KEY) {
    console.log('[rebalance-tweet] no TWITTER_API_KEY — skipping')
    return
  }
  try {
    const cycle = await db.scoringCycle.findUnique({
      where: { id: scoringCycleId },
      include: {
        scores: {
          where: { isBlacklisted: false, rank: { gt: 0 } },
          orderBy: { rank: 'asc' },
        },
      },
    })
    if (!cycle) {
      console.log('[rebalance-tweet] cycle not found')
      return
    }

    // Resolve which tier this cycle scored. New cycles always set `tier`;
    // legacy "score-everything" rows leave it null and we just bail.
    const tier = cycle.tier as RiskTier | null
    if (!tier) {
      console.log('[rebalance-tweet] cycle has no tier — skipping (legacy)')
      return
    }

    const tierScores = cycle.scores.filter((s) => s.riskTier === tier)
    console.log(`[rebalance-tweet] ${tier} scores=${cycle.scores.length} tierScores=${tierScores.length}`)
    if (tierScores.length === 0) {
      console.log(`[rebalance-tweet] no tierScores for ${tier} — riskTiers=${[...new Set(cycle.scores.map((s) => s.riskTier))].join(',')}`)
      return
    }

    // Previous COMPLETED cycle for THIS tier — used for added/dropped diff.
    const prevCycle = await db.scoringCycle.findFirst({
      where: {
        status: 'COMPLETED',
        tier,
        id: { not: cycle.id },
      },
      orderBy: { completedAt: 'desc' },
      include: {
        scores: {
          where: { isBlacklisted: false, rank: { gt: 0 } },
          orderBy: { rank: 'asc' },
        },
      },
    })

    // Max 3 cashtags per tweet — use them on the top 3 for cross-pollination.
    const top3 = tierScores.slice(0, 3).map((s) => `$${s.tokenSymbol}`).join(' · ')
    const prevMints = new Set((prevCycle?.scores ?? []).map((s) => s.tokenMint))
    const currentMints = new Set(tierScores.map((s) => s.tokenMint))
    const added = tierScores.filter((s) => !prevMints.has(s.tokenMint)).slice(0, 2)
    const dropped = (prevCycle?.scores ?? []).filter(
      (s) => !currentMints.has(s.tokenMint),
    ).slice(0, 2)

    // Top driver across this tier's scores (volume vs holder growth)
    const topByVolume = [...tierScores].sort(
      (a, b) => Number(b.volume24h) - Number(a.volume24h),
    )[0]
    const topByHolders = [...tierScores].sort(
      (a, b) => Number(b.holderGrowthPct) - Number(a.holderGrowthPct),
    )[0]
    const topDriver =
      Number(topByHolders.holderGrowthPct) > 25
        ? { factor: 'holder growth', symbol: topByHolders.tokenSymbol }
        : { factor: 'volume', symbol: topByVolume.tokenSymbol }

    const lines: string[] = [`${TIER_EMOJI[tier]} ${tier} index reshuffle`, '']
    lines.push(`Top: ${top3}`)
    const changes: string[] = []
    if (added.length) changes.push(...added.map((s) => `+${s.tokenSymbol}`))
    if (dropped.length) changes.push(...dropped.map((s) => `-${s.tokenSymbol}`))
    if (changes.length) lines.push(changes.join(' '))
    lines.push('')
    lines.push(`Driver: ${topDriver.symbol} on ${topDriver.factor}.`)

    let text = lines.join('\n')
    if (text.length > 275) text = text.slice(0, 272) + '…'

    console.log(`[rebalance-tweet] posting ${tier} (${text.length} chars)`)
    const twitterId = await postTweet(text)
    console.log(`[rebalance-tweet] tweet sent ${tier} id=${twitterId}`)
    await mirrorTweetToTelegram(text, twitterId)
    console.log(`[rebalance-tweet] posted ${tier} ${twitterId}`)
  } catch (err: any) {
    const detail = err?.data ? JSON.stringify(err.data) : err?.message ?? String(err)
    console.error(`[rebalance-tweet] failed: ${detail}`)
  }
}

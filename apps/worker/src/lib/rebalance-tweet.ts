import { db } from '@bags-index/db'
import { RISK_TIERS } from '@bags-index/shared'
import { postTweet } from './twitter.js'
import { mirrorTweetToTelegram } from './telegram.js'

const TIER_EMOJI: Record<string, string> = {
  CONSERVATIVE: '🟢',
  BALANCED: '🟡',
  DEGEN: '🔴',
}

/**
 * Build and post a tweet summarizing the latest rebalance:
 * - Top 3 selected tokens per tier
 * - Tokens added / dropped vs the previous completed cycle
 * - One-line reasoning (driven by composite score components)
 *
 * Mirrors to Telegram via the standard helper. Never throws — failure here
 * must not block the rebalance worker.
 */
export async function postRebalanceAnnouncement(scoringCycleId: string): Promise<void> {
  if (!process.env.TWITTER_API_KEY) return
  try {
    const cycle = await db.scoringCycle.findUnique({
      where: { id: scoringCycleId },
      include: {
        scores: {
          where: { isBlacklisted: false },
          orderBy: [{ riskTier: 'asc' }, { rank: 'asc' }],
        },
      },
    })
    if (!cycle) return

    const prevCycle = await db.scoringCycle.findFirst({
      where: { status: 'COMPLETED', id: { not: cycle.id } },
      orderBy: { completedAt: 'desc' },
      include: {
        scores: {
          where: { isBlacklisted: false },
          orderBy: [{ riskTier: 'asc' }, { rank: 'asc' }],
        },
      },
    })

    const lines: string[] = ['🔁 Daily rebalance complete', '']

    // Find the top driver across the whole cycle for the reasoning footer
    const allScores = cycle.scores
    let topDriver: { factor: string; symbol: string } | null = null
    if (allScores.length) {
      const topByVolume = [...allScores].sort((a, b) => Number(b.volume24h) - Number(a.volume24h))[0]
      const topByHolders = [...allScores].sort((a, b) => Number(b.holderGrowthPct) - Number(a.holderGrowthPct))[0]
      topDriver =
        Number(topByHolders.holderGrowthPct) > 25
          ? { factor: 'holder growth', symbol: topByHolders.tokenSymbol }
          : { factor: 'volume', symbol: topByVolume.tokenSymbol }
    }

    for (const tier of RISK_TIERS) {
      const tierScores = cycle.scores
        .filter((s) => s.riskTier === tier && s.rank > 0)
        .sort((a, b) => a.rank - b.rank)
      if (tierScores.length === 0) continue

      const top3 = tierScores.slice(0, 3).map((s) => `$${s.tokenSymbol}`).join(' ')

      // Diff vs prev cycle
      const prevTier = (prevCycle?.scores || [])
        .filter((s) => s.riskTier === tier && s.rank > 0)
      const prevMints = new Set(prevTier.map((s) => s.tokenMint))
      const currentMints = new Set(tierScores.map((s) => s.tokenMint))
      const added = tierScores.filter((s) => !prevMints.has(s.tokenMint)).slice(0, 1)
      const dropped = prevTier
        .filter((s) => !currentMints.has(s.tokenMint))
        .slice(0, 1)

      let line = `${TIER_EMOJI[tier]} ${tier}: ${top3}`
      const changes: string[] = []
      if (added.length) changes.push(`+$${added[0].tokenSymbol}`)
      if (dropped.length) changes.push(`-$${dropped[0].tokenSymbol}`)
      if (changes.length) line += `  (${changes.join(' ')})`
      lines.push(line)
    }

    if (topDriver) {
      lines.push('')
      lines.push(
        `Top driver: $${topDriver.symbol} on ${topDriver.factor}. ` +
          `Composite score = 0.5·volume + 0.3·holder growth + 0.2·liquidity.`,
      )
    }

    let text = lines.join('\n')
    // Twitter hard cap is 280; trim if needed
    if (text.length > 275) text = text.slice(0, 272) + '…'

    const twitterId = await postTweet(text)
    await mirrorTweetToTelegram(text, twitterId)
    console.log(`[rebalance-tweet] posted ${twitterId}`)
  } catch (err) {
    console.error('[rebalance-tweet] failed:', err)
  }
}

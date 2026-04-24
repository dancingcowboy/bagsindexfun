import 'dotenv/config'
import { TwitterApi } from 'twitter-api-v2'

const tweets = [
  `How does @BagsIndexSol decide what to buy?

Every token in your vault is chosen by a multi-stage scoring pipeline — no human picks, no vibes. Here's the full breakdown. 🧵`,

  `Stage 1: Universe

The agent pulls every migrated DAMM v2 pool from Bags. Then it runs a prefilter via DexScreener — any token with no price data or under $5K liquidity is dropped immediately.

What survives goes to scoring.`,

  `Stage 2: Signals

For each token, the agent collects:
- 24h trading volume
- Holder count + growth rate vs. last cycle
- Liquidity depth (USD)
- Market cap (min $20K for all tiers)
- Token age in days

Raw on-chain data. No opinions.`,

  `Stage 3: Tier filters

Each tier has its own entry bar:

Conservative — $8K liq, 200 holders, 5+ days old
Balanced — $10K liq, 150 holders, 3+ days old
Degen — $5K liq, 50 holders, any age (but max 90 days — fresh tokens only)

Same universe, different cuts.`,

  `Stage 4: Composite score

Each tier weights the signals differently:

Conservative: 30% volume / 40% holder growth / 30% liquidity
Balanced: 50% volume / 30% holder growth / 20% liquidity
Degen: 35% volume / 55% holder growth / 10% liquidity

Degen hunts breakout growth. Conservative rewards deep liquidity and steady holder bases.`,

  `Stage 5: AI safety review

Every candidate goes through a Claude-powered safety layer. It only flags catastrophic risks — active exploits, confirmed drainers, single-holder tokens.

Everything else passes. Bags LP is structurally locked so rug-pulls aren't a vector.`,

  `Stage 6: Assignment + allocation

Top 10 tokens per tier, no overlap — each token lands in the tier where it scores highest. Weights use √score normalization so no single token dominates. Max 25% per position.

Then the rebalance worker executes: sells what dropped out, buys what scored in. Fully on-chain, fully non-custodial.`,
]

async function main() {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_SECRET!,
  })

  let lastId: string | undefined
  for (let i = 0; i < tweets.length; i++) {
    const opts: any = { text: tweets[i] }
    if (lastId) {
      opts.reply = { in_reply_to_tweet_id: lastId }
    }
    const result = await client.v2.tweet(opts)
    lastId = result.data.id
    console.log(`[${i + 1}/${tweets.length}] posted: ${lastId}`)
    // Small delay between tweets
    if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 2000))
  }
  console.log(`Thread posted. First tweet: https://x.com/BagsIndexSol/status/${tweets.length > 0 ? 'check above' : lastId}`)
}

main().catch((err) => {
  console.error('Failed to post thread:', err)
  process.exit(1)
})

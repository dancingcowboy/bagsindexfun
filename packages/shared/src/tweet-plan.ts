/**
 * Pre-written 14-day, 84-tweet launch campaign for @bagsIndexSol.
 *
 * Posted every 4 hours starting from launch time. Each entry has:
 *   - text: ≤ 280 chars (we keep them well under)
 *   - imageQuery: Unsplash search keyword used to prefill an image
 *
 * The admin UI lets you edit any tweet and swap the image before launch.
 */

export interface PlannedTweet {
  text: string
  imageQuery: string
}

const X = 'https://bagsindex.fun'

export const TWEET_PLAN: PlannedTweet[] = [
  // ─── Day 1 — Launch ────────────────────────────────────────────────────────
  { text: `gm. introducing @bagsIndexSol — the first auto-rebalancing index fund for the Bags ecosystem. one deposit. top tokens. zero work. ${X}`, imageQuery: 'sunrise mountain' },
  { text: `the pitch in one line:\n\nyou deposit SOL → we auto-allocate across the top Bags tokens → AI rebalances daily → you sleep.\n\nno picking. no charts. no FOMO.`, imageQuery: 'minimalist desk' },
  { text: `three tiers, three personalities:\n\n🟦 conservative — SOL anchored, mature tokens, 24h rebalance\n🟩 balanced — top performers, 12h rebalance\n🟧 degen — high momentum, 4h rebalance\n\npick your appetite.`, imageQuery: 'three doors' },
  { text: `every Bags token earns its place in the index by score, not vibes:\n\n• 24h volume\n• holder growth\n• liquidity depth\n\nthen an AI safety review removes anything that smells. fully transparent.`, imageQuery: 'data dashboard' },
  { text: `non-custodial by design.\n\nyour funds live in per-tier sub-wallets signed by Privy's HSM. we never touch a private key. you withdraw whenever you want.`, imageQuery: 'vault security' },
  { text: `2026 thesis: most people want exposure to Bags but don't have time to be a degen full-time.\n\nbags-index is the ETF for memes. set it. forget it. compound it. ${X}`, imageQuery: 'long road horizon' },

  // ─── Day 2 — How it works ─────────────────────────────────────────────────
  { text: `how the scoring works (1/3):\n\nevery 24h we pull every Bags token from the launch feed, grab volume + holders + liquidity from Helius, and compute a composite score.\n\ntop 9 by tier go in.`, imageQuery: 'algorithm code' },
  { text: `how the scoring works (2/3):\n\nthen Claude reviews the top candidates for rug patterns: dev concentration, top-10 holder %, sudden drops, impersonation, exploit chatter.\n\nit can ONLY remove tokens. it cannot add or reorder.`, imageQuery: 'AI brain network' },
  { text: `how the scoring works (3/3):\n\nremoved tokens get logged with a reason. you can read every Layer-A verdict on the landing page. no black boxes. ${X}`, imageQuery: 'transparent glass' },
  { text: `rebalance fairness: we don't always swap your wallet first.\n\na seeded Fisher-Yates shuffle randomizes execution order each cycle. historical weighting ensures no wallet gets the worst slippage twice in a row.`, imageQuery: 'shuffle cards' },
  { text: `wash-trade defense:\n\nif a token's volume-per-trader ratio is >10× the median, we apply a 0.25× score penalty.\n\nfake volume doesn't get into the index.`, imageQuery: 'magnifying glass detective' },
  { text: `min-rank-changes guard:\n\nwe don't rebalance for a single rank shuffle. need ≥2 ranking changes before triggering swaps.\n\nfewer trades. less fee bleed. better compounding.`, imageQuery: 'shield protection' },

  // ─── Day 3 — Tiers deep dive ──────────────────────────────────────────────
  { text: `the conservative tier 🟦\n\n• 20% SOL anchor\n• min $500k liquidity\n• min 1000 holders\n• min 30 days old\n• rebalances every 24h\n\nfor people who want Bags exposure without bleeding their face off.`, imageQuery: 'calm ocean' },
  { text: `the balanced tier 🟩\n\n• full top-9 weighting\n• min $200k liquidity\n• min 500 holders\n• rebalances every 12h\n\nthe sweet spot. growth tokens, real volume, twice-daily refresh.`, imageQuery: 'balance scale' },
  { text: `the degen tier 🟧\n\n• momentum-weighted\n• min $50k liquidity\n• 4h rebalance\n\nfor people who want to ride velocity without picking individual tokens.\n\nyes it will be volatile. that's the point.`, imageQuery: 'race car speed' },
  { text: `pro tip: you can hold all three tiers simultaneously.\n\neach tier has its own sub-wallet, its own holdings, its own rebalance cadence. they never mix.\n\ntreat them like portfolio sleeves.`, imageQuery: 'three glass jars' },
  { text: `which tier should you pick?\n\n• new to Bags → conservative\n• actively trading → balanced\n• already a degen → degen\n• can't decide → all three, split your stack\n\nno wrong answer.`, imageQuery: 'compass direction' },
  { text: `every tier runs the same scoring engine. only the weights and filters differ.\n\nso the conservative tier isn't a different product — it's the same engine, tuned for capital preservation. ${X}`, imageQuery: 'gears mechanism' },

  // ─── Day 4 — Trust & security ─────────────────────────────────────────────
  { text: `who holds your keys? not us.\n\nbags-index uses Privy server wallets. private keys live in Privy's HSM. we send them unsigned transactions, they sign, we broadcast.\n\nif we get hacked, your funds don't move.`, imageQuery: 'lock and key' },
  { text: `the rebalance worker is idempotent.\n\nif it crashes mid-cycle, it picks up exactly where it left off. no double-swaps, no missed swaps. BullMQ handles the recovery.`, imageQuery: 'circular loop' },
  { text: `5% max slippage cap on every swap. hardcoded. can't be raised by anyone — not even us — without a code change + redeploy.\n\nyou will never be sandwiched into oblivion by bags-index.`, imageQuery: 'safety net' },
  { text: `audit log is on-chain visible:\n\nevery scoring cycle, every rebalance, every swap signature is recorded in postgres + queryable via the API. transparency by default. ${X}`, imageQuery: 'open ledger book' },
  { text: `the 3% deposit fee and 2% withdrawal fee aren't going to a treasury wallet.\n\n60% gets routed to platform-token buybacks → burn.\n\nthe rest funds infrastructure. no team allocation, no insider unlocks.`, imageQuery: 'burning paper' },
  { text: `non-custodial doesn't mean trustless.\n\nyou trust Privy to sign correctly. you trust us to write a worker that swaps the right amounts. but you do NOT trust us with your keys, and you can withdraw any time.`, imageQuery: 'handshake trust' },

  // ─── Day 5 — The flywheel ─────────────────────────────────────────────────
  { text: `the deflationary flywheel:\n\n1. user deposits SOL\n2. 3% fee → buy $BAGSIDX\n3. 60% of bought tokens → burn\n4. supply ↓\n5. price discovery ↑\n6. more users notice\n7. goto 1`, imageQuery: 'flywheel mechanical' },
  { text: `every deposit and every withdrawal feeds the burn.\n\nmore users = more volume = more burns = tighter supply = stronger token = more users.\n\nthis is the only "tokenomics" we believe in.`, imageQuery: 'fire flame' },
  { text: `no airdrop teasing. no points farming. no "wen token."\n\nthe platform token will exist when it makes sense. until then, the product is the product. ${X}`, imageQuery: 'silence quiet' },
  { text: `unlike most DeFi tokens, $BAGSIDX has a real utility from day one:\n\nhold it → reduced fees on bags-index.\n\nthat's the only mechanic we'll launch with. the rest comes after we have users.`, imageQuery: 'discount coupon' },
  { text: `if you've watched a hundred DeFi launches die because the tokenomics ate the product, you know why we're doing it backwards.\n\nproduct first. token when revenue justifies it. ${X}`, imageQuery: 'puzzle pieces' },
  { text: `the index doesn't need a token to work. the token doesn't exist until the index has users.\n\nthat's the discipline. that's the bet.`, imageQuery: 'chess strategy' },

  // ─── Day 6 — For projects (Bags App) ──────────────────────────────────────
  { text: `quietly shipped: bags-index is also a Bags App.\n\nany token launching on Bags can route a slice of trading fees directly into a bags-index vault.\n\ninstant treasury diversification. set once at launch. ${X}/projects`, imageQuery: 'pipeline flow' },
  { text: `for project founders:\n\nstop holding 100% of your treasury in your own token.\n\nroute 5% of your trading fees into a bags-index vault. now your treasury is exposed to the whole ecosystem, on-chain, automatically.`, imageQuery: 'diversification portfolio' },
  { text: `already launched on Bags? no problem.\n\nyour fee admin can call /fee-share/admin/update-config any time to add a bags-index vault to your claimers.\n\nadoption isn't gated to launch day.`, imageQuery: 'door open' },
  { text: `the public projects leaderboard is live: ${X}/projects\n\ntracking every project that's routing fees into the index, the SOL flowing in, and the current vault value. real treasury commitment, ranked.`, imageQuery: 'leaderboard trophy' },
  { text: `30-day timelock on project vault withdrawals. proves real treasury commitment without locking funds forever.\n\nafter unlock, the owner wallet can withdraw any time. it's their money.`, imageQuery: 'hourglass time' },
  { text: `for the projects asking "what does my community get out of it":\n\npublic leaderboard credit, public proof of treasury diversification, and a vault that compounds passively. that's the pitch. ${X}/projects`, imageQuery: 'community group' },

  // ─── Day 7 — One week in ─────────────────────────────────────────────────
  { text: `one week of bags-index 🎉\n\nthe scoring engine runs daily. the AI safety review runs daily. the rebalances are firing.\n\nstill the most boring week of crypto i've had. that's the goal.`, imageQuery: 'calendar week' },
  { text: `week one observations:\n\n• degen tier has rotated 4 tokens\n• balanced tier has rotated 1\n• conservative tier hasn't moved\n\nthe min-rank-changes guard is working exactly as designed.`, imageQuery: 'graph chart' },
  { text: `things i was worried about that turned out fine:\n\n• gas spikes during rebalance — Jupiter's priority fee logic handles it\n• Layer-A reviewer hallucinating — strict PASS/REMOVED constraints work\n• wallet provisioning slowness — Privy is fast`, imageQuery: 'checkmark green' },
  { text: `things i'm still worried about:\n\n• Bags API rate limits at scale\n• image upload edge cases\n• withdraw partial-failure UX\n\nworking through them. shipping fixes daily.`, imageQuery: 'worried thinking' },
  { text: `the unexpected lesson from week 1:\n\nmost users don't care about the AI agent. they care that the chart goes up.\n\nshipping a one-click "compare tier returns" view next.`, imageQuery: 'lightbulb idea' },
  { text: `if you've been on the fence about depositing — the conservative tier has had zero rebalances in a week. it's literally the most boring product on Solana.\n\nthat's the entire feature. ${X}`, imageQuery: 'meditation calm' },

  // ─── Day 8 — Mechanics in plain english ──────────────────────────────────
  { text: `"how do you actually buy the tokens?"\n\nwe use Bags' native /trade/swap endpoint. it returns a base58 versioned tx. Privy signs it. we broadcast via Helius. that's the entire path.\n\nno DEX aggregator middleman.`, imageQuery: 'pipeline flow industrial' },
  { text: `"why per-tier sub-wallets and not a pooled vault?"\n\npooled vaults are honey for hackers and regulators.\n\nper-user, per-tier sub-wallets means a compromise of one is a compromise of one. blast radius minimized.`, imageQuery: 'isolation walls' },
  { text: `"what happens if a token gets rugged after the rebalance?"\n\nit drops to zero in your holdings. the next scoring cycle removes it. you eat the loss for that slice.\n\nthat's the cost of any index strategy. diversification limits the damage.`, imageQuery: 'broken glass' },
  { text: `"why not just buy SOL?"\n\nbecause SOL doesn't capture the upside of the next 1000× Bags meme. and individual memes are too risky to size into.\n\nan index is the bridge. you get exposure without the picking.`, imageQuery: 'bridge over water' },
  { text: `"what if i just want to copy the top trader?"\n\ngo do that. seriously. it's a different product.\n\nbags-index is for people who don't want to copy a trader. who want a basket. who want to set it and forget it.`, imageQuery: 'fork in road' },
  { text: `the quiet truth of indexing:\n\nyou will underperform the best individual token. you will outperform the average random pick. you will sleep better than every degen on your timeline. ${X}`, imageQuery: 'pillow sleep' },

  // ─── Day 9 — Deeper into the AI ──────────────────────────────────────────
  { text: `the AI safety reviewer runs Claude with a strict system prompt:\n\n"PASS or REMOVED. nothing else. no reordering. no additions. cite a specific reason for any removal."\n\nthat's it. no creativity allowed.`, imageQuery: 'robot strict' },
  { text: `things the AI looks for:\n\n• top-10 holder concentration > 60%\n• dev wallet > 20% supply\n• sudden 80% holder drop in 4h\n• name impersonating a major project\n• exploit chatter on the source contract`, imageQuery: 'detective magnifying glass' },
  { text: `what happens if Claude is unreachable?\n\nthe reviewer fails OPEN. tokens get a "PASS" with a "review unavailable" reason logged.\n\nbetter to score a token without review than to halt rebalances entirely.`, imageQuery: 'open door safety' },
  { text: `every Layer-A verdict goes into the audit log with the full reason text.\n\nhumans (mostly me, for now) can review the patterns and refine the system prompt. tighter every week.`, imageQuery: 'feedback loop' },
  { text: `the AI is NOT picking tokens. let me say it again because everyone misreads this:\n\nthe AI is a SAFETY FILTER. it can only remove. token selection is 100% quantitative (volume + holders + liquidity).`, imageQuery: 'filter coffee' },
  { text: `the reason for the strict separation:\n\nLLMs hallucinate. quantitative scores don't.\n\nso we let the LLM do what it's good at (pattern recognition for safety) and the math do what math is good at (ranking).`, imageQuery: 'math equations' },

  // ─── Day 10 — Comparison ─────────────────────────────────────────────────
  { text: `bags-index vs. holding individual memes:\n\n• fewer rugs (diversification + safety review)\n• fewer all-nighters (auto rebalance)\n• less FOMO (you already own the winners)\n• fewer 100×s (yes, real)\n\ntradeoff is real. choose accordingly.`, imageQuery: 'comparison scale' },
  { text: `bags-index vs. a centralized index fund:\n\n• your keys, not theirs\n• no withdraw windows\n• no minimums\n• 3% fee, not 2% annual + carry\n• fully on-chain audit trail`, imageQuery: 'chain links' },
  { text: `bags-index vs. a DEX aggregator:\n\naggregators give you the best price for ONE swap. we run dozens of swaps over time, weighted toward the strongest tokens.\n\ndifferent products. ours is for portfolio construction, not execution.`, imageQuery: 'puzzle different' },
  { text: `bags-index vs. a copy-trading bot:\n\ncopy-bots assume the trader is right. we assume the MARKET is right.\n\nmarket cap weighting + holder growth is harder to game than any single trader's PnL screenshot.`, imageQuery: 'mirror reflection' },
  { text: `bags-index vs. doing it yourself:\n\nDIY: you spend 2 hours a day picking tokens, executing swaps, watching charts.\nbags-index: you spend 30 seconds depositing.\n\nyour time has a cost. price it in.`, imageQuery: 'clock time' },
  { text: `the case for indexing in crypto isn't new. but the case for indexing memes specifically is:\n\nmemes have fat-tail returns. you can't pick the winner. you can OWN it via the basket. ${X}`, imageQuery: 'lottery tickets' },

  // ─── Day 11 — Power user features ────────────────────────────────────────
  { text: `power user feature: you can split deposits across tiers in one transaction.\n\nput 60% in conservative, 30% in balanced, 10% in degen. one click. one signature.\n\nshipping next week.`, imageQuery: 'split fork' },
  { text: `coming soon: SOL-denominated portfolio chart per tier.\n\nsee exactly how much each rebalance moved your stack, not just the dollar value.\n\ntracking what matters when SOL is your unit of account.`, imageQuery: 'line chart up' },
  { text: `coming soon: tier comparison view.\n\nside by side: 30-day return on conservative vs balanced vs degen, after fees, with rebalance counts.\n\nlet the data pick the tier for you.`, imageQuery: 'comparison side by side' },
  { text: `coming soon: API access for power users.\n\npull your portfolio, your rebalances, your fees — programmatically. integrate with your own dashboards.\n\nfor the people who want to plug bags-index into their own stack.`, imageQuery: 'api code terminal' },
  { text: `coming eventually: governance over scoring weights.\n\nwhen the platform token launches, holders can vote on whether volume should be 50% or 40% of the score. fully on-chain.\n\nuntil then, the formula is fixed.`, imageQuery: 'voting ballot' },
  { text: `coming when it's actually safe: on-chain rebalance receipts via the Solana Memo program.\n\nevery rebalance hash will be queryable from the chain, not just our DB. trust minimization continues. ${X}`, imageQuery: 'receipt paper' },

  // ─── Day 12 — Stories & vibes ────────────────────────────────────────────
  { text: `the reason this exists:\n\ni was tired of waking up at 3am to rebalance my Bags bag. i wanted an ETF for memes. nobody had built it. so i did.\n\nbest products come from your own annoyance.`, imageQuery: 'sunrise window' },
  { text: `the original prototype was a python script and a google sheet. it ran for 11 days before i noticed it had been buying the same token twice.\n\nthat's why we have BullMQ idempotency now. lessons.`, imageQuery: 'old computer' },
  { text: `the worst bug i shipped to prod:\n\nshuffle seed was the unix timestamp instead of the cycle ID. so two rebalances within the same second got the same execution order.\n\nfixed in 4 minutes. lost an hour to embarrassment.`, imageQuery: 'bug computer' },
  { text: `the first user (not me) deposited 0.5 SOL into the conservative tier yesterday.\n\nthat's the moment a side project becomes a thing other people are trusting you with. completely different stakes.`, imageQuery: 'first step footprint' },
  { text: `things i didn't expect from launching:\n\n• how much time goes into copywriting vs code\n• how many "is this a rug" DMs you get\n• how much explaining you do about Privy\n\ni love it though. would do it again.`, imageQuery: 'writer notebook' },
  { text: `if you're building in crypto and reading this — ship the boring version first.\n\nthe boring version is the version users actually want. the cool version is the version you want to BUILD. those are different. ${X}`, imageQuery: 'simple minimal' },

  // ─── Day 13 — The ask ────────────────────────────────────────────────────
  { text: `what we need from you, in order:\n\n1. try the conservative tier with whatever you'd spend on lunch\n2. tell us what's confusing\n3. tell a friend\n\nthat's it. the rest takes care of itself. ${X}`, imageQuery: 'three steps' },
  { text: `if you're a Bags project founder reading this — go to ${X}/projects and add a vault to your fee-share.\n\n5% of your trading fees, on-chain, into a diversified ecosystem vault. zero ongoing work.`, imageQuery: 'partnership handshake' },
  { text: `if you write about crypto and want to cover bags-index — DMs open. happy to walk through the architecture, the security model, the AI safety review, anything.\n\nno NDA. no embargo. just questions and answers.`, imageQuery: 'press microphone' },
  { text: `if you're a security researcher — there's no formal bug bounty yet, but report a real issue privately and you'll get the first slice of the platform token allocation when it launches. and a beer.`, imageQuery: 'shield security' },
  { text: `if you just want to lurk and watch — that's also fine. follow @bagsIndexSol, watch the leaderboard at ${X}/projects, see if the conservative tier ever has a red day.\n\nno pressure. it's a long road.`, imageQuery: 'observer telescope' },
  { text: `the ask isn't "deposit a million SOL." it's "try the boring version of crypto for once and see how it feels."\n\nif it doesn't feel right, withdraw. that's literally the design.`, imageQuery: 'comfortable chair' },

  // ─── Day 14 — Wrap & forward ─────────────────────────────────────────────
  { text: `two weeks of bags-index in public 🎉\n\n84 tweets, ~zero rugs in the index, three live tiers, AI safety review running clean.\n\nstill the most boring product i've ever shipped. still the proudest of it.`, imageQuery: 'celebration confetti' },
  { text: `what's next (in priority order):\n\n1. portfolio chart in SOL terms\n2. tier comparison view\n3. project leaderboard polish\n4. mobile-first dashboard\n5. real-time SSE updates\n\nshipping weekly.`, imageQuery: 'roadmap path' },
  { text: `the metric i actually care about, two weeks in:\n\nnot TVL. not deposits. not Twitter followers.\n\n"how many users came back for a second deposit." that's the only number that means the product works. ${X}`, imageQuery: 'returning home' },
  { text: `if the only thing you remember from this campaign is one thing, make it this:\n\nyou don't have to pick the winner. you can own the basket. you can sleep. that's it. that's the whole product.`, imageQuery: 'one bag basket' },
  { text: `the platform token will come when the product earns it. not before.\n\nuntil then, the only thing to "buy" is exposure to the index, and the only thing to hold is patience.`, imageQuery: 'patient waiting' },
  { text: `gm. day 14 of @bagsIndexSol in public.\n\nif you've been here from day 1 — thank you. if you just got here — welcome. either way, the index keeps running and the boring keeps compounding. ${X}`, imageQuery: 'thank you notes' },
]

/** 14 days × 6 tweets/day = 84 */
export const TWEET_PLAN_SIZE = TWEET_PLAN.length

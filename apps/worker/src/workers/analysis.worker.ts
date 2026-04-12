import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { getBagsPools, getTokenFeed } from '@bags-index/solana'
import { QUEUE_ANALYSIS, RISK_TIERS } from '@bags-index/shared'
import type { RiskTier } from '@bags-index/shared'
import type { AnalysisResult, TierAllocation } from '@bags-index/shared'
import { redis } from '../queue/redis.js'

/**
 * Call Claude via a self-hosted Max proxy (OpenAI-compatible endpoint).
 */
async function callClaude(systemPrompt: string, userPrompt: string): Promise<{
  content: string
  promptTokens: number
  outputTokens: number
}> {
  const baseUrl = process.env.CLAUDE_API_BASE_URL || 'http://localhost:3456'
  const apiKey = process.env.CLAUDE_API_KEY || 'no-key-needed'

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as any
  return {
    content: data.choices[0].message.content as string,
    promptTokens: (data.usage?.prompt_tokens as number) ?? 0,
    outputTokens: (data.usage?.completion_tokens as number) ?? 0,
  }
}

const CANDIDATES_PER_TIER = 20
const PICKS_PER_TIER = 10

const SYSTEM_PROMPT = `You are the Bags Index Analyst — an AI safety-review agent for the Bags Index on Solana.

The quant scoring engine has already ranked every tradeable Bags token by volume, holder growth, and liquidity. For each of THREE risk tiers it sends you the top ${CANDIDATES_PER_TIER} candidates, pre-ranked by composite score.

Your job is to NARROW each tier from ${CANDIDATES_PER_TIER} candidates down to ${PICKS_PER_TIER} picks, then assign allocation weights. You are the safety and judgment layer — the quant does the math, you catch what formulas can't:

1. **REVIEW** each candidate for rug signals: dev wallet concentration, unlocked LP, live mint authority, suspicious holder patterns, sudden liquidity drains
2. **REMOVE** the weakest ${CANDIDATES_PER_TIER - PICKS_PER_TIER} per tier — tokens with red flags, low conviction, or poor risk/reward
3. **WEIGHT** the surviving ${PICKS_PER_TIER} per tier (must sum to 100%). Be opinionated — concentrate on your highest-conviction picks
4. **EXPLAIN** every removal and every weight decision transparently — users see your full reasoning

## Risk Tiers

**CONSERVATIVE** — Deep liquidity, stable holder bases, proven track records. Safety first.
**BALANCED** — Mix of proven performers and emerging tokens. The default index experience.
**DEGEN** — Momentum plays, newer tokens, volume spikes. Maximum upside, higher risk tolerance.

Respond with valid JSON in this exact format:
{
  "summary": "2-3 sentence overview",
  "sentiment": "bullish|bearish|neutral|cautious",
  "keyInsights": ["insight 1", "insight 2", "insight 3", "insight 4"],
  "reasoning": "Full multi-paragraph reasoning. Cover: market conditions, tier strategy, why you removed each dropped token, per-pick analysis, risk assessment, cross-tier observations. Use markdown. Users see this as your thinking process.",
  "tiers": [
    {
      "tier": "CONSERVATIVE",
      "allocations": [
        {
          "tokenSymbol": "TOKEN",
          "tokenName": "Token Name",
          "tokenMint": "mint_address",
          "weightPct": 15.5,
          "reasoning": "1-2 sentence explanation",
          "confidence": "high|medium|low",
          "signals": ["signal_1", "signal_2"]
        }
      ]
    },
    { "tier": "BALANCED", "allocations": [...] },
    { "tier": "DEGEN", "allocations": [...] }
  ]
}

Each tier must include exactly ${PICKS_PER_TIER} tokens. Weights must sum to 100%. Tokens CAN appear in multiple tiers. The DEGEN tier should feel meaningfully different from CONSERVATIVE.`

/**
 * Analysis agent worker — runs daily via cron.
 * Fetches market data, calls Claude to analyze, stores results.
 */
async function processAnalysis(job: Job) {
  const logger = { info: console.log, error: console.error }
  logger.info(`[analysis] Starting AI analysis cycle (job: ${job.id})`)
  const startTime = Date.now()

  // Create cycle record
  const cycle = await db.analysisCycle.create({
    data: {
      status: 'RUNNING',
      reasoning: '',
      summary: '',
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    },
  })

  try {
    // 1. Pull top candidates from the latest scoring cycles (one per tier).
    //    The quant engine already ranked every Bags token by composite score
    //    (volume + holder growth + liquidity). We take the top CANDIDATES_PER_TIER
    //    per tier so Claude reviews double what it needs to keep.
    const tiers: RiskTier[] = ['CONSERVATIVE', 'BALANCED', 'DEGEN']
    const tierSections: string[] = []
    let totalCandidates = 0

    for (const tier of tiers) {
      const latestCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED', tier },
        orderBy: { completedAt: 'desc' },
        include: {
          scores: {
            where: { isBlacklisted: false, rank: { gt: 0 } },
            orderBy: { rank: 'asc' },
            take: CANDIDATES_PER_TIER,
          },
        },
      })
      if (!latestCycle || latestCycle.scores.length === 0) {
        logger.info(`[analysis] No scored tokens for ${tier} — skipping tier`)
        continue
      }
      const lines = latestCycle.scores.map((s, i) =>
        `${i + 1}. ${s.tokenSymbol} (${s.tokenName}) mint=${s.tokenMint} | score=${Number(s.compositeScore).toFixed(3)} | $${Number(s.priceUsd).toFixed(6)} price | $${Math.round(Number(s.liquidityUsd))} liq | $${Math.round(Number(s.volume24h))} vol24h | $${Math.round(Number(s.marketCapUsd))} mcap | ${s.holderCount} holders | ${Number(s.holderGrowthPct).toFixed(1)}% holder growth`
      )
      tierSections.push(`### ${tier} — top ${latestCycle.scores.length} candidates (pick ${PICKS_PER_TIER})\n${lines.join('\n')}`)
      totalCandidates += latestCycle.scores.length
    }

    if (totalCandidates === 0) {
      logger.info('[analysis] No scored tokens across any tier — skipping cycle')
      await db.analysisCycle.update({ where: { id: cycle.id }, data: { status: 'SKIPPED' } })
      return
    }
    logger.info(`[analysis] ${totalCandidates} candidates across ${tierSections.length} tiers`)

    // 2. Build prompt
    const userPrompt = `Today's date: ${new Date().toISOString().split('T')[0]}

The quant scoring engine ranked every tradeable Bags token. Below are the top ${CANDIDATES_PER_TIER} candidates per tier, pre-ranked by composite score. Your job: review each, drop ${CANDIDATES_PER_TIER - PICKS_PER_TIER} per tier, weight the ${PICKS_PER_TIER} survivors.

${tierSections.join('\n\n')}

For each tier: pick ${PICKS_PER_TIER}, drop ${CANDIDATES_PER_TIER - PICKS_PER_TIER}, assign weights summing to 100%. Explain every removal. Flag any risk concerns.`

    // 4. Call Claude
    logger.info('[analysis] Calling Claude for analysis...')
    const { content, promptTokens, outputTokens } = await callClaude(
      SYSTEM_PROMPT,
      userPrompt
    )

    // 5. Parse response
    let result: AnalysisResult
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonStr = content.includes('```json')
        ? content.split('```json')[1].split('```')[0]
        : content.includes('```')
        ? content.split('```')[1].split('```')[0]
        : content
      result = JSON.parse(jsonStr.trim())
    } catch (parseErr) {
      logger.error(`[analysis] Failed to parse Claude response: ${parseErr}`)
      logger.error(`[analysis] Raw response: ${content.slice(0, 500)}`)
      throw new Error('Failed to parse analysis response')
    }

    // 6. Store results
    const durationMs = Date.now() - startTime

    await db.analysisCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'COMPLETED',
        reasoning: result.reasoning,
        summary: result.summary,
        sentiment: result.sentiment,
        keyInsights: result.keyInsights,
        marketDataJson: tierSections as any,
        promptTokens,
        outputTokens,
        durationMs,
      },
    })

    // Store allocations per tier
    let totalAllocations = 0
    for (const tierData of result.tiers) {
      for (const alloc of tierData.allocations) {
        await db.analysisAllocation.create({
          data: {
            analysisCycleId: cycle.id,
            tier: tierData.tier as any,
            tokenMint: alloc.tokenMint,
            tokenSymbol: alloc.tokenSymbol,
            tokenName: alloc.tokenName,
            weightPct: alloc.weightPct,
            reasoning: alloc.reasoning,
            confidence: alloc.confidence,
            signals: alloc.signals,
          },
        })
        totalAllocations++
      }
    }

    logger.info(
      `[analysis] Cycle ${cycle.id} complete in ${durationMs}ms — ${totalAllocations} allocations across ${result.tiers.length} tiers, sentiment: ${result.sentiment}`
    )
  } catch (err) {
    logger.error(`[analysis] Cycle failed: ${err}`)
    await db.analysisCycle.update({
      where: { id: cycle.id },
      data: {
        status: 'FAILED',
        reasoning: `Analysis failed: ${err}`,
        summary: 'Analysis cycle failed',
      },
    })
    throw err
  }
}

export function createAnalysisWorker() {
  const worker = new Worker(QUEUE_ANALYSIS, processAnalysis, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    console.log(`[analysis] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[analysis] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

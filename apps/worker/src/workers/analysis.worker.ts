import { Worker, type Job } from 'bullmq'
import { db } from '@bags-index/db'
import { getTokenFeed, getHolderCount } from '@bags-index/solana'
import { QUEUE_ANALYSIS, RISK_TIERS } from '@bags-index/shared'
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

const SYSTEM_PROMPT = `You are the Bags Index Analyst — an AI agent that analyzes token performance data from the Bags ecosystem on Solana and decides optimal portfolio allocations across THREE risk tiers.

You will receive market data for tradeable tokens on Bags. Your job is to:

1. ANALYZE each token's metrics (holder count, holder growth, trading activity, liquidity)
2. ASSIGN tokens to risk tiers based on their profile
3. DECIDE allocation weights per tier (each tier must sum to 100%)
4. EXPLAIN your reasoning transparently — users will see your entire thought process

## Risk Tiers

**CONSERVATIVE** — Established tokens with deep liquidity, stable holder bases, and proven track records. Prioritize safety and stability. Avoid new launches. Favor tokens with >$100K liquidity and low holder churn.

**BALANCED** — Mix of proven performers and emerging tokens with solid fundamentals. The default index experience. Balance between growth potential and risk management.

**DEGEN** — High momentum plays, newer tokens, volume spikes, rapid holder growth. Maximum upside potential. Acceptable to include recent graduates, high-volatility tokens, and speculative plays. Higher concentration in top picks.

Your reasoning should cover:
- Market conditions and overall sentiment
- Tier strategy: what kind of tokens belong in each tier today
- Per-token analysis: why assigned to which tier, bullish/bearish signals
- Risk factors: rug indicators, concentration risk, liquidity concerns
- Cross-tier insights: tokens that moved between tiers and why

Respond with valid JSON in this exact format:
{
  "summary": "2-3 sentence overview of today's analysis",
  "sentiment": "bullish|bearish|neutral|cautious",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "reasoning": "Your full multi-paragraph reasoning process. Be detailed and transparent. Discuss market conditions, tier strategy, individual token analysis, risk assessment, and allocation decisions. This will be displayed to users as your 'thinking process'. Use markdown formatting.",
  "tiers": [
    {
      "tier": "CONSERVATIVE",
      "allocations": [
        {
          "tokenSymbol": "TOKEN",
          "tokenName": "Token Name",
          "tokenMint": "mint_address",
          "weightPct": 15.5,
          "reasoning": "1-2 sentence explanation for this specific allocation",
          "confidence": "high|medium|low",
          "signals": ["signal_type_1", "signal_type_2"]
        }
      ]
    },
    {
      "tier": "BALANCED",
      "allocations": [...]
    },
    {
      "tier": "DEGEN",
      "allocations": [...]
    }
  ]
}

Each tier must include exactly 10 tokens. Each tier's weights must sum to 100%. Tokens CAN appear in multiple tiers with different weights. Be opinionated — don't distribute equally unless truly warranted. The DEGEN tier should feel meaningfully different from CONSERVATIVE.`

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
    // 1. Fetch token data from Bags
    const feed = await getTokenFeed()
    const tradeable = feed.filter((t) => t.status === 'MIGRATED')
    logger.info(`[analysis] Found ${tradeable.length} tradeable tokens`)

    // 2. Enrich with holder data from Helius
    const tokenData = []
    for (const token of tradeable.slice(0, 30)) {
      try {
        const holderCount = await getHolderCount(token.tokenMint)

        // Get previous holder count for growth calculation
        const prevAllocation = await db.analysisAllocation.findFirst({
          where: { tokenMint: token.tokenMint },
          orderBy: { analysisCycle: { createdAt: 'desc' } },
        })

        tokenData.push({
          tokenMint: token.tokenMint,
          symbol: token.symbol,
          name: token.name,
          image: token.image,
          holderCount,
          prevHolderCount: prevAllocation ? undefined : holderCount,
          hasPool: !!token.dbcPoolKey || !!token.dammV2PoolKey,
          twitter: token.twitter,
          website: token.website,
        })
      } catch (err) {
        logger.error(`[analysis] Failed to enrich ${token.symbol}: ${err}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    // 3. Build prompt with market data
    const marketDataStr = tokenData
      .map(
        (t) =>
          `- ${t.symbol} (${t.name}): ${t.holderCount} holders, pool: ${t.hasPool ? 'yes' : 'no'}, twitter: ${t.twitter ?? 'none'}, website: ${t.website ?? 'none'}`
      )
      .join('\n')

    const userPrompt = `Today's date: ${new Date().toISOString().split('T')[0]}

Here are the current tradeable tokens on Bags with their data:

${marketDataStr}

Analyze these tokens and produce your index allocation for today. Remember:
- Select the top 10 for the index
- Assign weights summing to 100%
- Be transparent in your reasoning
- Flag any risk concerns`

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
        marketDataJson: tokenData as any,
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

import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import {
  RISK_TIERS,
  TIER_SCORING_CONFIG,
  BAGSX_MINT,
  BAGSX_WEIGHT_PCT,
} from '@bags-index/shared'

/**
 * Rescale scored allocations down by the fixed BAGSX + SOL anchor slice
 * and append pseudo-entries for BAGSX (every tier) and SOL (tiers with a
 * non-zero anchor). Keeps the allocation list honest: scored tokens shown
 * at their *vault* weight (not their sleeve weight) and the two fixed
 * sleeves visible with their real percentages.
 */
function formatAllocations(allocations: any[]) {
  const byTier: Record<string, any[]> = {}
  for (const a of allocations) {
    const tier = a.tier ?? 'BALANCED'
    if (!byTier[tier]) byTier[tier] = []
    byTier[tier].push({
      tokenMint: a.tokenMint,
      tokenSymbol: a.tokenSymbol,
      tokenName: a.tokenName,
      weightPct: Number(a.weightPct),
      reasoning: a.reasoning,
      confidence: a.confidence,
      signals: a.signals,
    })
  }

  for (const tier of Object.keys(byTier)) {
    const cfg = TIER_SCORING_CONFIG[tier as keyof typeof TIER_SCORING_CONFIG]
    const anchorPct = cfg?.solAnchorPct ?? 0
    const scoredScale = (100 - BAGSX_WEIGHT_PCT - anchorPct) / 100
    byTier[tier] = byTier[tier].map((a) => ({
      ...a,
      weightPct: Number((a.weightPct * scoredScale).toFixed(2)),
    }))
    byTier[tier].push({
      tokenMint: BAGSX_MINT,
      tokenSymbol: 'BAGSX',
      tokenName: 'Bags Index',
      weightPct: BAGSX_WEIGHT_PCT,
      reasoning: 'Fixed 8% platform-token slice held by every vault',
      confidence: 'high',
      signals: ['Platform Token', 'Fixed Allocation'],
    })
    if (anchorPct > 0) {
      byTier[tier].push({
        tokenMint: 'SOL',
        tokenSymbol: 'SOL',
        tokenName: 'Solana',
        weightPct: anchorPct,
        reasoning: `${anchorPct}% SOL anchor held natively in the vault`,
        confidence: 'high',
        signals: ['Anchor', 'Native'],
      })
    }
  }
  return byTier
}

/**
 * Public routes — AI analysis reasoning is fully transparent.
 */
export async function analysisRoutes(app: FastifyInstance) {
  /**
   * GET /analysis/latest?tier=CONSERVATIVE|BALANCED|DEGEN
   * Latest completed AI analysis with full reasoning and allocations.
   * Optional tier filter — if omitted, returns all tiers.
   */
  app.get('/latest', async (req, reply) => {
    try {
      const { tier } = req.query as { tier?: string }
      const tierFilter = tier && RISK_TIERS.includes(tier as any) ? tier : undefined

      const cycle = await db.analysisCycle.findFirst({
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        include: {
          allocations: {
            where: tierFilter ? { tier: tierFilter as any } : undefined,
            orderBy: { weightPct: 'desc' },
          },
        },
      })

      if (!cycle) {
        return { success: true, data: null }
      }

      return {
        success: true,
        data: {
          id: cycle.id,
          createdAt: cycle.createdAt,
          model: cycle.model,
          durationMs: cycle.durationMs,
          summary: cycle.summary,
          sentiment: cycle.sentiment,
          keyInsights: cycle.keyInsights,
          reasoning: cycle.reasoning,
          tiers: formatAllocations(cycle.allocations),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get latest analysis')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /analysis/history
   * List of past analysis cycles (without full reasoning, for performance).
   */
  app.get('/history', async (_req, reply) => {
    try {
      const cycles = await db.analysisCycle.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          id: true,
          createdAt: true,
          status: true,
          model: true,
          summary: true,
          sentiment: true,
          keyInsights: true,
          durationMs: true,
          allocations: {
            select: {
              tier: true,
              tokenSymbol: true,
              weightPct: true,
              confidence: true,
            },
            orderBy: { weightPct: 'desc' },
          },
        },
      })

      return {
        success: true,
        data: cycles.map((c) => ({
          ...c,
          tiers: formatAllocations(c.allocations),
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to get analysis history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /analysis/:id?tier=CONSERVATIVE|BALANCED|DEGEN
   * Full analysis cycle by ID.
   */
  app.get('/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string }
      const { tier } = req.query as { tier?: string }
      const tierFilter = tier && RISK_TIERS.includes(tier as any) ? tier : undefined

      const cycle = await db.analysisCycle.findUnique({
        where: { id },
        include: {
          allocations: {
            where: tierFilter ? { tier: tierFilter as any } : undefined,
            orderBy: { weightPct: 'desc' },
          },
        },
      })

      if (!cycle) return reply.status(404).send({ error: 'Analysis not found' })

      return {
        success: true,
        data: {
          id: cycle.id,
          createdAt: cycle.createdAt,
          status: cycle.status,
          model: cycle.model,
          durationMs: cycle.durationMs,
          promptTokens: cycle.promptTokens,
          outputTokens: cycle.outputTokens,
          summary: cycle.summary,
          sentiment: cycle.sentiment,
          keyInsights: cycle.keyInsights,
          reasoning: cycle.reasoning,
          tiers: formatAllocations(cycle.allocations),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get analysis')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

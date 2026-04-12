'use client'

import { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { useTier } from '@/lib/TierContext'
import { API_BASE } from '@/lib/api'

function CopyCAButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(mint)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [mint])
  return (
    <button
      onClick={(e) => { e.stopPropagation(); copy() }}
      className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
        copied
          ? 'border-[#00D62B]/50 text-[#00D62B]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]'
      }`}
      title="Copy contract address"
    >
      {copied ? 'copied' : 'ca'}
    </button>
  )
}
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  Zap,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Shield,
  BarChart3,
  Sparkles,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type RiskTier = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

interface Allocation {
  tokenSymbol: string
  tokenName: string
  tokenMint: string
  weightPct: number
  reasoning: string
  confidence: string
  signals: string[]
}

// ─── Tier config ─────────────────────────────────────────────────────────────

const TIER_CONFIG = {
  CONSERVATIVE: {
    label: 'Conservative',
    description: 'Established tokens, deep liquidity, stable holder bases',
    color: '#00b8ff',
    icon: Shield,
  },
  BALANCED: {
    label: 'Balanced',
    description: 'Proven performers mixed with emerging growth',
    color: '#00D62B',
    icon: BarChart3,
  },
  DEGEN: {
    label: 'Degen',
    description: 'High momentum, newer tokens, maximum upside',
    color: '#ff8c00',
    icon: Zap,
  },
} as const

// ─── Real allocations from scoring cycle cmnp0skxl ──────────────────────────

const MOCK_TIERS: Record<RiskTier, Allocation[]> = {
  CONSERVATIVE: [
    { tokenSymbol: 'GSD', tokenName: 'GSD', tokenMint: '8116V1BW9zaXUM6pVhWVaAduKrLcEBi3RGXedKTrBAGS', weightPct: 25, reasoning: 'Deepest liquidity in the Conservative universe and +8.7% on the week. Broad holder dispersion and stable ranks across cycles make it the natural anchor — capped at 25% so a single token never dominates.', confidence: 'high', signals: ['high_liquidity', 'stable_base', 'consistent_performer'] },
    { tokenSymbol: 'RAI', tokenName: 'RAI', tokenMint: 'BCQjsvdsoqaSKo8iwgmfnzMV5S2rC7XR3i2K7Ep8BAGS', weightPct: 12, reasoning: 'Quiet +14.5% uptrend with organic holder growth and locked LP. The kind of slow compounding Conservative is built for.', confidence: 'high', signals: ['steady_growth', 'stable_base'] },
    { tokenSymbol: 'RECAP', tokenName: 'RECAP', tokenMint: 'DF4zASfiDBr3uuAz4s2Sxtsjo7tDFZiQ2nLeKJGfBAGS', weightPct: 11, reasoning: 'Mint authority revoked, holder base holding steady despite a -28% week. Included for its structural safety, not its chart.', confidence: 'medium', signals: ['low_churn', 'stable_base'] },
    { tokenSymbol: 'SVM', tokenName: 'SVM', tokenMint: '7NX8vBJ5EBPP6Ke6SB9JF3rrLcgZ2EYv8d8bFNqaBAGS', weightPct: 10, reasoning: 'Established community and clean wallet clusters. Down hard this week (-52%), but passes every Layer-A safety check — a contrarian Conservative position.', confidence: 'medium', signals: ['stable_base', 'recovery'] },
    { tokenSymbol: 'HUBZZ', tokenName: 'HUBZZ', tokenMint: 'BHhYx1h3mwiQLcYdD2N9tG6nRFcn6pmwwtzS5XMvBAGS', weightPct: 9, reasoning: 'No suspicious concentration, active trading, minor -9% drawdown. Classic \"boring is good\" Conservative pick.', confidence: 'medium', signals: ['consistent_performer', 'low_churn'] },
    { tokenSymbol: 'PEPE', tokenName: 'PEPE', tokenMint: 'EkJuyYyD3to61CHVPJn6wHb7xANxvqApnVJ4o2SdBAGS', weightPct: 7, reasoning: 'Top-10 holder concentration within limits and flat on the week. Small diversifier.', confidence: 'medium', signals: ['stable_base'] },
    { tokenSymbol: 'TIWAIWAKA', tokenName: 'TIWAIWAKA', tokenMint: 'HjLt2fbdEpNJDGkPwq9Cjb6LDo8vjFSssnxJHFQnBAGS', weightPct: 7, reasoning: 'Organic holder growth and +7.6% on the week. LP healthy, no red flags.', confidence: 'high', signals: ['steady_growth', 'holder_surge'] },
    { tokenSymbol: 'UASG', tokenName: 'UASG', tokenMint: 'JC4BwbSuhvigKprGgAgpLBy29ruu8KapLAfXwkkvBAGS', weightPct: 7, reasoning: 'Best Conservative performer by far at +174% on the week. Kept modest because the move is extreme for this tier — the 25% cap prevents it from distorting risk.', confidence: 'high', signals: ['holder_surge', 'volume_surge', 'parabolic_growth'] },
    { tokenSymbol: 'PUBLIC', tokenName: 'PUBLIC', tokenMint: 'CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS', weightPct: 6, reasoning: 'Clean deployment, no rug signals. Tail position for narrative diversification.', confidence: 'medium', signals: ['stable_base'] },
    { tokenSymbol: 'STARCRAFT', tokenName: 'STARCRAFT', tokenMint: 'BGGFZLb29NZSqDz5T6K5Bj5VcwWM7YJc1XAKS8oSBAGS', weightPct: 6, reasoning: 'Stable liquidity, dev wallet <5%, +3.3% on the week. Steady small weight.', confidence: 'medium', signals: ['consistent_performer', 'stable_base'] },
  ],
  BALANCED: [
    { tokenSymbol: 'AEGIS', tokenName: 'AEGIS', tokenMint: '4qbCffZLLApr1bdstAaJcrhF8ZAACJFWS7bm4ycgBAGS', weightPct: 22, reasoning: 'Deepest liquidity on Bags and the broadest holder base in the Balanced universe. Capped at 22% after the 25% cap kicked in — prevents a single mover from dictating the tier.', confidence: 'high', signals: ['high_liquidity', 'stable_base', 'whale_accumulation'] },
    { tokenSymbol: 'NIKITA', tokenName: 'NIKITA', tokenMint: 'GJ9LEQZgoxW487LRaRnajr6DWzouswd29EruRqwZBAGS', weightPct: 19, reasoning: 'This week\'s top gainer at +36.8%. Organic holder growth, no concentration red flags — textbook momentum position.', confidence: 'high', signals: ['holder_surge', 'volume_surge', 'early_momentum'] },
    { tokenSymbol: 'PRIMIS', tokenName: 'PRIMIS', tokenMint: '2DfBjrPFZjDTiCY6pxchS6aSdUdEpkm7PdqpovHjBAGS', weightPct: 18, reasoning: '+26.6% with healthy dispersion. Strong second-tier momentum pick.', confidence: 'high', signals: ['steady_growth', 'holder_surge'] },
    { tokenSymbol: 'GODMODE', tokenName: 'GODMODE', tokenMint: 's64RinoknMmndiAMH2hcFC4yRJkT58VeMT93jJFBAGS', weightPct: 14, reasoning: '+59% on the week driven by narrative momentum. No concentration flags — the weighting engine liked this a lot.', confidence: 'high', signals: ['social_momentum', 'volume_surge', 'breakout_setup'] },
    { tokenSymbol: 'DOME', tokenName: 'DOME', tokenMint: '2xutLMhH41yWHhMiLijRGxuUTkYZd4zFQwQCw1niBAGS', weightPct: 14, reasoning: 'Breakout volume +54% on the week, LP locked, clean review. Balanced\'s growth engine.', confidence: 'high', signals: ['volume_surge', 'breakout_setup'] },
    { tokenSymbol: 'GAS', tokenName: 'GAS', tokenMint: '7pskt3A1Zsjhngazam7vHWjWHnfgiRump916Xj7ABAGS', weightPct: 4, reasoning: 'Utility narrative, mint authority revoked. Hard drawdown this week but included as a structurally safe low-weight position.', confidence: 'low', signals: ['stable_base', 'recovery'] },
    { tokenSymbol: 'OSHI', tokenName: 'OSHI', tokenMint: 'Dsv7aCFRw3fQqPcDDAak2rw7biF3EyzBx1bfp6BXBAGS', weightPct: 3, reasoning: 'Organic holder base, LP locked. Minor diversifier.', confidence: 'medium', signals: ['stable_base'] },
    { tokenSymbol: 'SKS', tokenName: 'SKS', tokenMint: '64Xtqbivo92rDWQ7RruN6c4VkkfD3pNoZTHjMjyNBAGS', weightPct: 2, reasoning: 'No suspicious wallet clusters. Tail allocation.', confidence: 'low', signals: ['stable_base'] },
    { tokenSymbol: 'RALPH', tokenName: 'RALPH', tokenMint: 'CxWPdDBqxVo3fnTMRTvNuSrd4gkp78udSrFvkVDBAGS', weightPct: 2, reasoning: 'Clean rug checks, passed all safety filters. Smallest reasonable weight.', confidence: 'low', signals: ['stable_base'] },
    { tokenSymbol: 'ELLIE', tokenName: 'ELLIE', tokenMint: '7pL98QbnrMZCe5FEKajSdTTgLn6Thf5CFaozLkayBAGS', weightPct: 2, reasoning: 'LP locked, dev wallet small. Lottery-ticket size position.', confidence: 'low', signals: ['stable_base', 'early_momentum'] },
  ],
  DEGEN: [
    { tokenSymbol: 'NIKITA', tokenName: 'NIKITA', tokenMint: 'GJ9LEQZgoxW487LRaRnajr6DWzouswd29EruRqwZBAGS', weightPct: 25, reasoning: '+36.8% on the week and the Degen scoring engine loved it. Capped at 25% — the cap is the only reason this isn\'t larger.', confidence: 'high', signals: ['holder_surge', 'early_momentum', 'parabolic_growth'] },
    { tokenSymbol: 'ORBIS', tokenName: 'ORBIS', tokenMint: 'ABadLP3asy88raGZciQf61Lb4ZWhVbdpptjnZ4JuBAGS', weightPct: 25, reasoning: 'Fresh launch that cleared Degen\'s 90-day max-age window. Momentum pick and Degen\'s second 25% cap position.', confidence: 'medium', signals: ['new_graduate', 'early_momentum', 'breakout_setup'] },
    { tokenSymbol: 'HDD', tokenName: 'HDD', tokenMint: '6ZKCEQPT7hULSD4iU9j4UXUA5gDbtuNLM93sXQx6BAGS', weightPct: 10, reasoning: 'Organic holder growth and a clean deploy. Small -7% drawdown — Degen will ride it.', confidence: 'medium', signals: ['steady_growth', 'new_graduate'] },
    { tokenSymbol: 'POLYBLOCK', tokenName: 'POLYBLOCK', tokenMint: 'EuCxMhKCTj3wDj3WuWtFj2U4vR5J5uiQPLU93BqcBAGS', weightPct: 8, reasoning: 'Narrative pick, holder dispersion acceptable. Heaviest drawdown in the tier at -58% — the bounce candidate.', confidence: 'low', signals: ['recovery', 'high_risk'] },
    { tokenSymbol: 'BLADE', tokenName: 'BLADE', tokenMint: '5PpuN3rdRCqetkXCnLAVXDr2L8NcHZmQ4kjqvoTMBAGS', weightPct: 7, reasoning: 'Volatile but clean — dev wallet <5%. Degen exposure to the kind of swings Conservative can\'t touch.', confidence: 'medium', signals: ['volume_potential', 'high_risk'] },
    { tokenSymbol: 'CJFT', tokenName: 'CJFT', tokenMint: '6WBynoJreWH4dfayG1Qzrq5PBUstDMUkR1c7mSemBAGS', weightPct: 6, reasoning: 'LP locked, no red flags. Medium-weight Degen slot.', confidence: 'medium', signals: ['stable_base'] },
    { tokenSymbol: '1LY', tokenName: '1LY', tokenMint: 'Aih3sbAbu39Yn7jB2Qf4btZ5eWtDGQJH2gMfC4qdBAGS', weightPct: 6, reasoning: 'Fresh launch, passed rug checks. Momentum call.', confidence: 'medium', signals: ['new_graduate', 'early_momentum'] },
    { tokenSymbol: 'GME', tokenName: 'GME', tokenMint: '3DpmH888HsxjC2V6QejWeEWa2MNLhQxQUovswBvvBAGS', weightPct: 5, reasoning: 'Narrative momentum, +12.8% on the week. Small but positive contributor.', confidence: 'medium', signals: ['social_momentum', 'meme_narrative'] },
    { tokenSymbol: 'NPM', tokenName: 'NPM', tokenMint: 'J948jWGHJsf13FWuZxWdajRuBXxPpgLy1hMCzisvBAGS', weightPct: 5, reasoning: 'Clean wallet clusters, within max-age window. Tail weight.', confidence: 'low', signals: ['new_graduate'] },
    { tokenSymbol: 'GOLEM', tokenName: 'GOLEM', tokenMint: 'Dq3Fwkvo9zC87RmZ6ZKEYiztnAyr6qX9wmYjHJgiBAGS', weightPct: 3, reasoning: 'LP locked, no concentration red flags. Smallest Degen position.', confidence: 'low', signals: ['stable_base'] },
  ],
}

const MOCK_ANALYSIS = {
  id: 'analysis-20260407',
  createdAt: new Date().toISOString(),
  model: 'claude-sonnet-4-20250514',
  durationMs: 18200,
  sentiment: 'neutral' as const,
  summary:
    'Scoring cycle cmnp0skxl surfaced 30 unique tokens across the three tiers. Balanced is the star at +17.4% on the week, led by NIKITA (+36.8%), PRIMIS (+26.6%), GODMODE (+59.3%) and DOME (+54.0%). Conservative is quietly green at +7.4% thanks to GSD, RAI and UASG. Degen edges positive at +0.3% — NIKITA and ORBIS carrying a basket with some heavy drawdowns.',
  keyInsights: [
    'NIKITA is the week\'s top performer at +36.8% — lands in both Balanced and Degen at the 25% cap',
    'UASG posted +174.6% in Conservative — extreme for the tier, kept at 6% so the 25% cap stops any single mover from distorting risk',
    'AEGIS (-14% this week) would have dominated Balanced at 67% without the cap — now a healthy 22%',
    'Degen runs with POLYBLOCK (-58%) and BLADE (-27%) as contrarian compression plays alongside NIKITA/ORBIS momentum',
  ],
  reasoning: `## Market Overview

The scoring engine pulled 30 unique tokens from the migrated Bags universe, scored each against all three tier weight schemes, and used greedy unique assignment so no token dominates multiple tiers. A hard 25% max-weight cap per token then redistributes any excess proportionally. The result: three tiers that actually look different from each other — and all three finished the week in the green.

## Tier Strategy

### Conservative — +7.4% / week
The weights lean on liquidity (30%), holder growth (40%) and volume (30%). GSD anchors at the 25% cap thanks to the deepest liquidity in the Conservative universe. RAI and UASG contribute the actual green (+14.5% and +174.6%). RECAP and SVM are the quiet drag — included for structural safety, not their week.

### Balanced — +17.4% / week
Balanced eats volume (50%), holder growth (30%), liquidity (20%). AEGIS is the liquidity anchor at the 22% cap. The real story is the four-way momentum stack: NIKITA +36.8%, PRIMIS +26.6%, GODMODE +59.3%, DOME +54.0%. Combined ~65% weight in a basket that ran hot — explains the +17.4%.

### Degen — +0.3% / week
Degen prizes holder growth (55%) over volume (35%) and liquidity (10%). NIKITA and ORBIS both hit the 25% cap — that 50% core carried a basket that included POLYBLOCK (-58.8%) and BLADE (-27.3%). Finishing positive at all on that mix is the cap doing its job.

## Cross-Tier Insights

- **NIKITA** is the only token that repeats across tiers (Balanced 19%, Degen 25%) — greedy assignment lets it land where its tier-specific score is highest
- **AEGIS** would have been ~67% of Balanced without the cap — now a responsible 22%
- **UASG** (+174.6% in Conservative) proves the weight cap earns its keep: at 6% it adds ~10.5pp to the tier without breaking the risk budget

## Risk Assessment

- **Conservative**: Low. GSD + RAI + UASG do the heavy lifting in green. Drawdowns are concentrated in RECAP/SVM, both passed Layer-A review.
- **Balanced**: Moderate. Four momentum names doing 65% of the work — if any two reverse hard, the tier turns. AEGIS anchor softens that.
- **Degen**: High. The cap is what made this tier positive. Without NIKITA + ORBIS at the cap, POLYBLOCK and BLADE would have dragged it negative.`,
}

const SENTIMENT_CONFIG = {
  bullish: { color: '#00D62B', icon: TrendingUp, label: 'Bullish' },
  bearish: { color: '#ff4444', icon: TrendingDown, label: 'Bearish' },
  neutral: { color: '#a0a0a0', icon: BarChart3, label: 'Neutral' },
  cautious: { color: '#ffd000', icon: AlertTriangle, label: 'Cautious' },
}

const CONFIDENCE_COLORS = {
  high: '#00D62B',
  medium: '#ffd000',
  low: '#ff8c00',
}

const SIGNAL_LABELS: Record<string, string> = {
  holder_surge: 'Holder Surge',
  high_liquidity: 'Deep Liquidity',
  community_growth: 'Community',
  volume_surge: 'Volume Spike',
  whale_accumulation: 'Whale Activity',
  high_retention: 'High Retention',
  steady_growth: 'Steady Growth',
  early_momentum: 'Early Momentum',
  new_graduate: 'New Graduate',
  stable_base: 'Stable Base',
  low_churn: 'Low Churn',
  quiet_accumulation: 'Accumulating',
  divergence: 'Divergence',
  consistent_performer: 'Consistent',
  recovery: 'Recovery',
  liquidity_watch: 'Liq. Watch',
  consolidation: 'Consolidation',
  liquidity_decline: 'Liq. Decline',
  removed: 'Removed',
  meme_narrative: 'Meme Play',
  volume_potential: 'Vol. Potential',
  breakout_setup: 'Breakout Setup',
  high_risk: 'High Risk',
  social_momentum: 'Social Buzz',
  parabolic_growth: 'Parabolic',
  low_liquidity: 'Low Liquidity',
  low_volume: 'Low Volume',
}

const CHART_COLORS = [
  '#00D62B', '#00b8ff', '#ff8c00', '#ff69b4', '#ffd000',
  '#a855f7', '#14b8a6', '#f43f5e', '#6366f1', '#84cc16',
]

// ─── Component ───────────────────────────────────────────────────────────────

interface AnalysisApiResponse {
  data: {
    id: string
    createdAt: string
    model: string
    durationMs: number
    summary: string
    sentiment: string
    keyInsights: string[]
    reasoning: string
    tiers: Record<string, {
      tokenMint: string
      tokenSymbol: string
      tokenName: string
      weightPct: number
      reasoning: string
      confidence: string
      signals: string[]
    }[]>
  } | null
}

export function AgentAnalysis() {
  const { tier: activeTier, setTier: setActiveTier } = useTier()
  const [showFullReasoning, setShowFullReasoning] = useState(false)
  const [expandedToken, setExpandedToken] = useState<string | null>(null)

  // Fetch latest AI analysis (reasoning, sentiment, per-token insights)
  const analysisQ = useQuery({
    queryKey: ['analysis-latest'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/analysis/latest`)
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as AnalysisApiResponse
    },
    refetchInterval: 10 * 60_000,
  })

  const analysis = useMemo(() => {
    const d = analysisQ.data?.data
    if (!d) return MOCK_ANALYSIS
    return {
      id: d.id,
      createdAt: d.createdAt,
      model: d.model,
      durationMs: d.durationMs,
      sentiment: (d.sentiment || 'neutral') as keyof typeof SENTIMENT_CONFIG,
      summary: d.summary || MOCK_ANALYSIS.summary,
      keyInsights: d.keyInsights?.length ? d.keyInsights : MOCK_ANALYSIS.keyInsights,
      reasoning: d.reasoning || MOCK_ANALYSIS.reasoning,
    }
  }, [analysisQ.data])

  // Fetch live index data from the API for the active tier
  const liveQ = useQuery({
    queryKey: ['index-current', activeTier],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/index/current?tier=${activeTier}`)
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as {
        data: {
          tokens: {
            tokenMint: string
            tokenSymbol: string
            tokenName: string
            marketCapUsd: number
            compositeScore: number
            weightPct: string
            rank: number
          }[]
        }
      }
    },
    refetchInterval: 5 * 60_000,
  })

  // Build allocations: live index weights + analysis reasoning per token
  const allocations: (Allocation & { marketCapUsd?: number })[] = useMemo(() => {
    const analysisTier = analysisQ.data?.data?.tiers?.[activeTier] ?? []
    const reasoningByMint = new Map(
      analysisTier.map((a) => [a.tokenMint, { reasoning: a.reasoning, confidence: a.confidence, signals: a.signals }])
    )

    const liveTokens = liveQ.data?.data?.tokens
    if (!liveTokens?.length) {
      if (analysisTier.length) {
        return analysisTier.map((a) => ({
          tokenSymbol: a.tokenSymbol,
          tokenName: a.tokenName,
          tokenMint: a.tokenMint,
          weightPct: a.weightPct,
          reasoning: a.reasoning,
          confidence: a.confidence,
          signals: a.signals,
        }))
      }
      return MOCK_TIERS[activeTier]
    }
    return liveTokens.map((t) => {
      const r = reasoningByMint.get(t.tokenMint)
      return {
        tokenSymbol: t.tokenSymbol,
        tokenName: t.tokenName,
        tokenMint: t.tokenMint,
        weightPct: Number(t.weightPct),
        marketCapUsd: t.marketCapUsd,
        reasoning: r?.reasoning ?? '',
        confidence: r?.confidence ?? 'medium',
        signals: r?.signals ?? [],
      }
    })
  }, [liveQ.data, analysisQ.data, activeTier])

  const sentimentCfg = SENTIMENT_CONFIG[analysis.sentiment]
  const SentimentIcon = sentimentCfg.icon
  const activeAllocations = allocations.filter((a) => a.weightPct > 0)
  const tierCfg = TIER_CONFIG[activeTier]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ backgroundColor: 'rgba(0,214,43,0.12)' }}
            >
              <Brain className="h-5 w-5" style={{ color: '#00D62B' }} />
            </div>
            <div>
              <h3 className="text-lg font-bold">AI Analyst</h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                {analysis.model} · {(analysis.durationMs / 1000).toFixed(1)}s · 3 tiers
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
            style={{
              backgroundColor: `${sentimentCfg.color}18`,
              color: sentimentCfg.color,
            }}
          >
            <SentimentIcon className="h-3.5 w-3.5" />
            {sentimentCfg.label}
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
            <Clock className="h-3.5 w-3.5" />
            {new Date(analysis.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-xl bg-[var(--color-bg-secondary)] p-4">
        <p className="text-sm leading-relaxed">{analysis.summary}</p>
      </div>

      {/* Key Insights */}
      <div className="grid gap-2">
        {analysis.keyInsights.map((insight, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.08 }}
            className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-secondary)] px-4 py-3 text-sm"
          >
            <Sparkles className="h-4 w-4 mt-0.5 shrink-0" style={{ color: '#00D62B' }} />
            <span className="text-[var(--color-text-secondary)]">{insight}</span>
          </motion.div>
        ))}
      </div>

      {/* ─── Tier Selector ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const).map((tier) => {
          const cfg = TIER_CONFIG[tier]
          const TierIcon = cfg.icon
          const isActive = activeTier === tier
          return (
            <button
              key={tier}
              onClick={() => {
                setActiveTier(tier)
                setExpandedToken(null)
              }}
              className={`relative rounded-xl border p-4 text-left transition-all ${
                isActive
                  ? 'border-transparent'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-hover)] bg-[var(--color-bg-card)]'
              }`}
              style={
                isActive
                  ? {
                      borderColor: cfg.color,
                      backgroundColor: `${cfg.color}0a`,
                      boxShadow: `0 0 20px ${cfg.color}15`,
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-2 mb-1.5">
                <TierIcon
                  className="h-4 w-4"
                  style={{ color: isActive ? cfg.color : 'var(--color-text-muted)' }}
                />
                <span
                  className="text-sm font-bold"
                  style={{ color: isActive ? cfg.color : 'var(--color-text-primary)' }}
                >
                  {cfg.label}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] leading-snug hidden sm:block">
                {cfg.description}
              </p>
              {isActive && (
                <motion.div
                  layoutId="tier-indicator"
                  className="absolute -bottom-px left-4 right-4 h-0.5 rounded-full"
                  style={{ backgroundColor: cfg.color }}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* ─── Allocations for active tier ───────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTier}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25 }}
        >
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
              {tierCfg.label} Allocations
            </h4>
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ backgroundColor: `${tierCfg.color}18`, color: tierCfg.color }}
            >
              {activeAllocations.length} tokens
            </span>
          </div>

          <div className="space-y-2">
            {allocations.map((alloc, i) => {
              const isExpanded = expandedToken === `${activeTier}-${alloc.tokenSymbol}`
              const isRemoved = alloc.weightPct === 0
              return (
                <motion.div
                  key={`${activeTier}-${alloc.tokenSymbol}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={`rounded-xl border transition-colors ${
                    isRemoved
                      ? 'border-[var(--color-red)]/20 bg-[var(--color-red-subtle)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg-card)]'
                  }`}
                >
                  <button
                    className="flex w-full items-center gap-4 p-4 text-left"
                    onClick={() =>
                      setExpandedToken(
                        isExpanded ? null : `${activeTier}-${alloc.tokenSymbol}`
                      )
                    }
                  >
                    <span className="w-6 text-center text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
                      {isRemoved ? '—' : `#${i + 1}`}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">
                          {alloc.tokenSymbol}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)] hidden sm:inline">
                          {alloc.tokenName}
                        </span>
                      </div>
                    </div>

                    <div className="w-16 text-right font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                      {(() => {
                        const mc = (alloc as any).marketCapUsd
                        if (!mc || mc <= 0) return '—'
                        return mc >= 1_000_000
                          ? `$${(mc / 1_000_000).toFixed(1)}M`
                          : mc >= 1_000
                            ? `$${(mc / 1_000).toFixed(0)}K`
                            : `$${mc.toFixed(0)}`
                      })()}
                    </div>

                    <div className="hidden sm:flex items-center gap-1.5">
                      {alloc.signals.slice(0, 2).map((s) => (
                        <span
                          key={s}
                          className="rounded-full bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                        >
                          {SIGNAL_LABELS[s] ?? s}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1">
                      <a
                        href={`https://dexscreener.com/solana/${alloc.tokenMint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors"
                      >
                        dex
                      </a>
                      <CopyCAButton mint={alloc.tokenMint} />
                    </div>

                    <div
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor:
                          CONFIDENCE_COLORS[
                            alloc.confidence as keyof typeof CONFIDENCE_COLORS
                          ],
                      }}
                      title={`${alloc.confidence} confidence`}
                    />

                    <div className="w-16 text-right">
                      {isRemoved ? (
                        <span className="text-sm font-bold text-[var(--color-red)]">
                          OUT
                        </span>
                      ) : (
                        <span
                          className="text-sm font-bold font-[family-name:var(--font-mono)]"
                          style={{ color: tierCfg.color }}
                        >
                          {alloc.weightPct}%
                        </span>
                      )}
                    </div>

                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-[var(--color-text-muted)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
                    )}
                  </button>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-[var(--color-border-subtle)] px-4 py-3">
                          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                            {alloc.reasoning}
                          </p>
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            {alloc.signals.map((s) => (
                              <span
                                key={s}
                                className="rounded-full bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]"
                              >
                                {SIGNAL_LABELS[s] ?? s}
                              </span>
                            ))}
                            <span
                              className="ml-auto rounded-full px-2.5 py-1 text-[10px] font-semibold"
                              style={{
                                backgroundColor: `${
                                  CONFIDENCE_COLORS[
                                    alloc.confidence as keyof typeof CONFIDENCE_COLORS
                                  ]
                                }18`,
                                color:
                                  CONFIDENCE_COLORS[
                                    alloc.confidence as keyof typeof CONFIDENCE_COLORS
                                  ],
                              }}
                            >
                              {alloc.confidence} confidence
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )
            })}
          </div>

          {/* Weight bar visualization */}
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
            {activeAllocations.map((alloc, i) => (
              <motion.div
                key={`${activeTier}-bar-${alloc.tokenSymbol}`}
                initial={{ width: 0 }}
                animate={{ width: `${alloc.weightPct}%` }}
                transition={{ delay: 0.3 + i * 0.05, duration: 0.5 }}
                className="h-full"
                style={{ backgroundColor: CHART_COLORS[i] }}
                title={`${alloc.tokenSymbol}: ${alloc.weightPct}%`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {activeAllocations.map((alloc, i) => (
              <span
                key={`${activeTier}-legend-${alloc.tokenSymbol}`}
                className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: CHART_COLORS[i] }}
                />
                {alloc.tokenSymbol} {alloc.weightPct}%
              </span>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Full Reasoning Toggle */}
      <div>
        <button
          onClick={() => setShowFullReasoning(!showFullReasoning)}
          className="flex w-full items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] px-5 py-4 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
        >
          <div className="flex items-center gap-3">
            <Brain className="h-4 w-4" style={{ color: '#00D62B' }} />
            <span className="text-sm font-semibold">Full Reasoning Process</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-text-muted)]">
              {showFullReasoning ? 'Collapse' : 'Expand'}
            </span>
            {showFullReasoning ? (
              <ChevronDown className="h-4 w-4 text-[var(--color-text-muted)]" />
            ) : (
              <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
            )}
          </div>
        </button>

        <AnimatePresence>
          {showFullReasoning && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-6">
                <div className="prose prose-invert prose-sm max-w-none">
                  {analysis.reasoning.split('\n\n').map((paragraph, i) => {
                    if (paragraph.startsWith('## ')) {
                      return (
                        <h2
                          key={i}
                          className="text-base font-bold mt-6 mb-3 first:mt-0"
                          style={{ color: '#00D62B' }}
                        >
                          {paragraph.replace('## ', '')}
                        </h2>
                      )
                    }
                    if (paragraph.startsWith('### ')) {
                      return (
                        <h3 key={i} className="text-sm font-bold mt-4 mb-2">
                          {paragraph.replace('### ', '')}
                        </h3>
                      )
                    }
                    const parts = paragraph.split(/(\*\*.*?\*\*)/g)
                    return (
                      <p
                        key={i}
                        className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-3"
                      >
                        {parts.map((part, j) => {
                          if (part.startsWith('**') && part.endsWith('**')) {
                            const text = part.slice(2, -2)
                            return (
                              <strong
                                key={j}
                                className="text-[var(--color-text-primary)] font-semibold"
                              >
                                {text}
                              </strong>
                            )
                          }
                          return <span key={j}>{part}</span>
                        })}
                      </p>
                    )
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

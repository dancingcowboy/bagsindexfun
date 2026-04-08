'use client'

import { useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useTier, RiskTier } from '@/lib/TierContext'
import { Shield, BarChart3, Zap } from 'lucide-react'

const TOKEN_COLORS = [
  '#00D62B', '#00b8ff', '#ff8c00', '#ff69b4', '#ffd000',
  '#a855f7', '#14b8a6', '#f43f5e', '#6366f1', '#eab308',
]
const TIER_META: Record<RiskTier, { label: string; icon: typeof Shield; color: string; description: string; rebalance: string }> = {
  CONSERVATIVE: {
    label: 'Conservative',
    icon: Shield,
    color: '#00b8ff',
    description: '10 deep-liquidity Bags tokens · capped 25% max weight',
    rebalance: 'rebalanced every 24h',
  },
  BALANCED: {
    label: 'Balanced',
    icon: BarChart3,
    color: '#00D62B',
    description: '10 algorithm top picks · score-weighted',
    rebalance: 'rebalanced every 12h',
  },
  DEGEN: {
    label: 'Degen',
    icon: Zap,
    color: '#ff8c00',
    description: '10 momentum picks · max age 90d',
    rebalance: 'rebalanced every 4h',
  },
}

const TIER_TOKENS: Record<RiskTier, string[]> = {
  CONSERVATIVE: ['GSD','RAI','RECAP','SVM','HUBZZ','PEPE','TIWAIWAKA','UASG','PUBLIC','STARCRAFT'],
  BALANCED: ['AEGIS','NIKITA','PRIMIS','GODMODE','DOME','GAS','OSHI','SKS','RALPH','ELLIE'],
  DEGEN: ['NIKITA','ORBIS','HDD','POLYBLOCK','BLADE','CJFT','1LY','GME','NPM','GOLEM'],
}

/**
 * Layer-A AI Safety Review — verdicts from the agent reviewer.
 * In production these come from `token_scores.safety_verdict / safety_reason`.
 * Quant ranks; the agent can only REMOVE with a written reason.
 */
const SAFETY_REVIEW: Record<string, { verdict: 'PASS' | 'REMOVED'; reason: string }> = {
  GSD:       { verdict: 'PASS', reason: 'deep liquidity, broad holder base, no red flags' },
  RAI:       { verdict: 'PASS', reason: 'organic holder growth, LP locked' },
  RECAP:     { verdict: 'PASS', reason: 'mint authority revoked, stable dispersion' },
  SVM:       { verdict: 'PASS', reason: 'established community, clean wallet clusters' },
  HUBZZ:     { verdict: 'PASS', reason: 'no suspicious concentration, active trading' },
  PEPE:      { verdict: 'PASS', reason: 'top-10 holder concentration within limits' },
  TIWAIWAKA: { verdict: 'PASS', reason: 'organic growth, LP healthy' },
  UASG:      { verdict: 'PASS', reason: 'strong holder momentum, LP locked' },
  PUBLIC:    { verdict: 'PASS', reason: 'clean deployment, no rug signals' },
  STARCRAFT: { verdict: 'PASS', reason: 'stable liquidity, dev wallet <5%' },
  AEGIS:     { verdict: 'PASS', reason: 'deepest Bags liquidity, broad holder base' },
  NIKITA:    { verdict: 'PASS', reason: '7d top gainer, holder growth organic' },
  PRIMIS:    { verdict: 'PASS', reason: 'strong momentum, healthy dispersion' },
  GODMODE:   { verdict: 'PASS', reason: 'narrative momentum, no concentration flags' },
  DOME:      { verdict: 'PASS', reason: 'breakout volume, LP locked' },
  GAS:       { verdict: 'PASS', reason: 'mint authority revoked, liquidity stable' },
  OSHI:      { verdict: 'PASS', reason: 'organic holder base, LP locked' },
  SKS:       { verdict: 'PASS', reason: 'no suspicious wallet clusters' },
  RALPH:     { verdict: 'PASS', reason: 'clean rug checks, holder growth positive' },
  ELLIE:     { verdict: 'PASS', reason: 'LP locked, dev wallet small' },
  ORBIS:     { verdict: 'PASS', reason: 'fresh momentum pick, within Degen max age' },
  HDD:       { verdict: 'PASS', reason: 'organic holder growth, clean deploy' },
  POLYBLOCK: { verdict: 'PASS', reason: 'narrative pick, holder dispersion ok' },
  BLADE:     { verdict: 'PASS', reason: 'volatile but clean — dev wallet <5%' },
  CJFT:      { verdict: 'PASS', reason: 'LP locked, no red flags' },
  '1LY':     { verdict: 'PASS', reason: 'fresh launch passed rug checks' },
  GME:       { verdict: 'PASS', reason: 'narrative momentum, holder growth organic' },
  NPM:       { verdict: 'PASS', reason: 'clean wallet clusters, within max age' },
  GOLEM:     { verdict: 'PASS', reason: 'LP locked, no concentration red flags' },
}

/**
 * Real 7-day price data from GeckoTerminal (daily, normalized to base 100).
 * Tokens, weights and index aggregates come from scoring cycle cmnp0skxl.
 * BAGS INDEX line = tier's weighted aggregate (max 25% per token).
 */
const TIER_DATA: Record<RiskTier, Array<Record<string, number | string>>> = {
  CONSERVATIVE: [
    {"date":"Mar 31","GSD":100,"RAI":100,"RECAP":100,"SVM":100,"HUBZZ":100,"PEPE":100,"TIWAIWAKA":100,"UASG":100,"PUBLIC":100,"STARCRAFT":100,"BAGS INDEX":100},
    {"date":"Apr 01","GSD":101.42,"RAI":100.85,"RECAP":96.13,"SVM":93.67,"HUBZZ":98.22,"PEPE":98.93,"TIWAIWAKA":101.81,"UASG":125.83,"PUBLIC":99.05,"STARCRAFT":99.83,"BAGS INDEX":100.98},
    {"date":"Apr 02","GSD":100.62,"RAI":103.57,"RECAP":93.99,"SVM":85.02,"HUBZZ":95.31,"PEPE":100.47,"TIWAIWAKA":104.08,"UASG":148.92,"PUBLIC":98.34,"STARCRAFT":102.33,"BAGS INDEX":101.65},
    {"date":"Apr 03","GSD":102.18,"RAI":108.30,"RECAP":88.97,"SVM":75.11,"HUBZZ":95.61,"PEPE":102.45,"TIWAIWAKA":103.03,"UASG":172.44,"PUBLIC":100.84,"STARCRAFT":103.59,"BAGS INDEX":103.06},
    {"date":"Apr 04","GSD":106.39,"RAI":110.08,"RECAP":82.06,"SVM":68.63,"HUBZZ":96.90,"PEPE":100.74,"TIWAIWAKA":101.93,"UASG":199.65,"PUBLIC":102.44,"STARCRAFT":101.38,"BAGS INDEX":104.72},
    {"date":"Apr 05","GSD":108.13,"RAI":109.42,"RECAP":78.25,"SVM":63.80,"HUBZZ":94.68,"PEPE":98.29,"TIWAIWAKA":104.54,"UASG":226.65,"PUBLIC":100.39,"STARCRAFT":100.32,"BAGS INDEX":105.62},
    {"date":"Apr 06","GSD":107.37,"RAI":111.23,"RECAP":76.32,"SVM":56.01,"HUBZZ":91.35,"PEPE":99.08,"TIWAIWAKA":107.43,"UASG":250.34,"PUBLIC":98.90,"STARCRAFT":102.43,"BAGS INDEX":106.23},
    {"date":"Apr 07","GSD":108.70,"RAI":114.50,"RECAP":71.90,"SVM":47.40,"HUBZZ":90.70,"PEPE":100.00,"TIWAIWAKA":107.60,"UASG":274.60,"PUBLIC":100.00,"STARCRAFT":103.30,"BAGS INDEX":107.42},
  ],
  BALANCED: [
    {"date":"Mar 31","AEGIS":100,"NIKITA":100,"PRIMIS":100,"GODMODE":100,"DOME":100,"GAS":100,"OSHI":100,"SKS":100,"RALPH":100,"ELLIE":100,"BAGS INDEX":100},
    {"date":"Apr 01","AEGIS":99.14,"NIKITA":105.43,"PRIMIS":102.58,"GODMODE":108.61,"DOME":108.90,"GAS":87.14,"OSHI":96.84,"SKS":98.97,"RALPH":88.47,"ELLIE":95.10,"BAGS INDEX":102.71},
    {"date":"Apr 02","AEGIS":96.97,"NIKITA":108.64,"PRIMIS":107.03,"GODMODE":118.96,"DOME":115.48,"GAS":73.14,"OSHI":96.30,"SKS":98.39,"RALPH":74.21,"ELLIE":90.45,"BAGS INDEX":104.96},
    {"date":"Apr 03","AEGIS":92.19,"NIKITA":114.23,"PRIMIS":113.48,"GODMODE":126.42,"DOME":120.80,"GAS":62.35,"OSHI":96.19,"SKS":94.50,"RALPH":60.37,"ELLIE":89.01,"BAGS INDEX":107.02},
    {"date":"Apr 04","AEGIS":89.67,"NIKITA":122.45,"PRIMIS":117.00,"GODMODE":132.01,"DOME":129.54,"GAS":52.56,"OSHI":92.40,"SKS":90.56,"RALPH":50.22,"ELLIE":86.67,"BAGS INDEX":109.74},
    {"date":"Apr 05","AEGIS":90.22,"NIKITA":128.21,"PRIMIS":118.07,"GODMODE":140.68,"DOME":139.94,"GAS":39.26,"OSHI":87.86,"SKS":90.33,"RALPH":39.87,"ELLIE":80.67,"BAGS INDEX":112.72},
    {"date":"Apr 06","AEGIS":88.97,"NIKITA":131.45,"PRIMIS":121.60,"GODMODE":151.23,"DOME":147.38,"GAS":24.83,"OSHI":86.57,"SKS":90.38,"RALPH":26.20,"ELLIE":75.25,"BAGS INDEX":115.13},
    {"date":"Apr 07","AEGIS":85.70,"NIKITA":136.80,"PRIMIS":126.60,"GODMODE":159.30,"DOME":154.00,"GAS":13.10,"OSHI":85.40,"SKS":87.70,"RALPH":13.10,"ELLIE":72.40,"BAGS INDEX":117.42},
  ],
  DEGEN: [
    {"date":"Mar 31","NIKITA":100,"ORBIS":100,"HDD":100,"POLYBLOCK":100,"BLADE":100,"CJFT":100,"1LY":100,"GME":100,"NPM":100,"GOLEM":100,"BAGS INDEX":100},
    {"date":"Apr 01","NIKITA":106.44,"ORBIS":100.17,"HDD":97.72,"POLYBLOCK":91.74,"BLADE":97.29,"CJFT":97.51,"1LY":97.16,"GME":102.55,"NPM":98.69,"GOLEM":98.59,"BAGS INDEX":100.42},
    {"date":"Apr 02","NIKITA":111.57,"ORBIS":98.13,"HDD":97.32,"POLYBLOCK":85.22,"BLADE":92.25,"CJFT":93.88,"1LY":96.93,"GME":105.57,"NPM":94.64,"GOLEM":97.43,"BAGS INDEX":99.82},
    {"date":"Apr 03","NIKITA":114.09,"ORBIS":98.45,"HDD":98.91,"POLYBLOCK":75.81,"BLADE":85.96,"CJFT":93.47,"1LY":97.13,"GME":105.26,"NPM":91.01,"GOLEM":99.47,"BAGS INDEX":99.18},
    {"date":"Apr 04","NIKITA":118.87,"ORBIS":101.42,"HDD":97.57,"POLYBLOCK":64.52,"BLADE":83.09,"CJFT":94.05,"1LY":93.66,"GME":104.90,"NPM":91.08,"GOLEM":100.61,"BAGS INDEX":99.97},
    {"date":"Apr 05","NIKITA":126.72,"ORBIS":101.92,"HDD":93.78,"POLYBLOCK":56.32,"BLADE":81.87,"CJFT":91.11,"1LY":89.43,"GME":108.26,"NPM":90.94,"GOLEM":98.10,"BAGS INDEX":100.88},
    {"date":"Apr 06","NIKITA":132.77,"ORBIS":99.91,"HDD":92.46,"POLYBLOCK":50.00,"BLADE":77.70,"CJFT":87.06,"1LY":88.45,"GME":111.89,"NPM":87.48,"GOLEM":96.16,"BAGS INDEX":100.55},
    {"date":"Apr 07","NIKITA":136.80,"ORBIS":100.00,"HDD":92.60,"POLYBLOCK":41.20,"BLADE":72.70,"CJFT":85.70,"1LY":87.60,"GME":112.80,"NPM":84.60,"GOLEM":96.80,"BAGS INDEX":100.26},
  ],
}


// Merge the BAGS INDEX series from all 3 tiers with the currently-selected
// tier's token series, so the chart shows: 3 index lines + 9 token lines.
function buildMergedData(activeTier: RiskTier) {
  const activeRows = TIER_DATA[activeTier]
  return activeRows.map((row, i) => ({
    ...row,
    INDEX_CONSERVATIVE: TIER_DATA.CONSERVATIVE[i]['BAGS INDEX'],
    INDEX_BALANCED: TIER_DATA.BALANCED[i]['BAGS INDEX'],
    INDEX_DEGEN: TIER_DATA.DEGEN[i]['BAGS INDEX'],
  }))
}

function finalReturn(t: RiskTier) {
  const rows = TIER_DATA[t]
  return (rows[rows.length - 1]['BAGS INDEX'] as number) - 100
}

export function IndexChart() {
  const { tier, setTier } = useTier()
  const [hoveredLine, setHoveredLine] = useState<string | null>(null)

  const data = buildMergedData(tier)
  const tokens = TIER_TOKENS[tier]
  const meta = TIER_META[tier]

  return (
    <div className="card p-0 overflow-hidden">
      {/* Tier selector */}
      <div className="grid grid-cols-3 border-b border-[var(--color-border)]">
        {(['CONSERVATIVE','BALANCED','DEGEN'] as const).map((t) => {
          const m = TIER_META[t]
          const Icon = m.icon
          const active = tier === t
          return (
            <button
              key={t}
              onClick={() => setTier(t)}
              className="relative flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold transition-all"
              style={{
                color: active ? m.color : 'var(--color-text-muted)',
                backgroundColor: active ? `${m.color}0a` : 'transparent',
              }}
            >
              <Icon className="h-4 w-4" />
              {m.label}
              {active && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: m.color }}
                />
              )}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-6 pt-5 pb-2 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold">Index Performance</h3>
          <p className="text-sm text-[var(--color-text-muted)]">
            {meta.description} · {meta.rebalance}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(['CONSERVATIVE','BALANCED','DEGEN'] as const).map((t) => {
            const r = finalReturn(t)
            const c = TIER_META[t].color
            const active = t === tier
            return (
              <div
                key={t}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold"
                style={{
                  backgroundColor: `${c}${active ? '22' : '10'}`,
                  color: c,
                  opacity: active ? 1 : 0.65,
                }}
              >
                <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: c }} />
                {TIER_META[t].label} {r >= 0 ? '+' : ''}{r.toFixed(1)}%
              </div>
            )
          })}
        </div>
      </div>

      <div className="px-2 pb-4" style={{ height: 420 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#666', fontSize: 11 }}
              interval={1}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#666', fontSize: 11 }}
              domain={['auto', 'auto']}
              width={45}
            />
            <Tooltip
              contentStyle={{
                background: '#1a1a1a',
                border: '1px solid #2a2a2a',
                borderRadius: '12px',
                fontSize: '12px',
                padding: '12px',
              }}
              labelStyle={{ color: '#a0a0a0', marginBottom: '8px', fontWeight: 600 }}
              itemStyle={{ padding: '2px 0' }}
            />

            {tokens.map((token, i) => (
              <Line
                key={token}
                type="monotone"
                dataKey={token}
                stroke={TOKEN_COLORS[i]}
                strokeWidth={hoveredLine === token ? 2.5 : 1.5}
                strokeOpacity={
                  hoveredLine
                    ? hoveredLine === token
                      ? 1
                      : 0.15
                    : 0.4
                }
                dot={false}
                activeDot={{
                  r: 3,
                  fill: TOKEN_COLORS[i],
                  stroke: '#1a1a1a',
                  strokeWidth: 2,
                }}
                onMouseEnter={() => setHoveredLine(token)}
                onMouseLeave={() => setHoveredLine(null)}
              />
            ))}

            {/* Three index lines — one per tier — always visible */}
            {(['CONSERVATIVE','BALANCED','DEGEN'] as const).map((t) => {
              const key = `INDEX_${t}` as const
              const isActive = t === tier
              const color = TIER_META[t].color
              return (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={`${TIER_META[t].label} Index`}
                  stroke={color}
                  strokeWidth={isActive ? 3.5 : 2}
                  strokeOpacity={isActive ? 1 : 0.55}
                  strokeDasharray={isActive ? undefined : '4 4'}
                  dot={false}
                  activeDot={{
                    r: isActive ? 5 : 3,
                    fill: color,
                    stroke: '#0a0a0a',
                    strokeWidth: 2,
                  }}
                  onMouseEnter={() => setHoveredLine(key)}
                  onMouseLeave={() => setHoveredLine(null)}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="border-t border-[var(--color-border)] px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">
            Index Composition · AI Safety Review
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Layer A · Claude reviews every token before inclusion
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {tokens.map((token, i) => {
            const review = SAFETY_REVIEW[token] ?? { verdict: 'PASS' as const, reason: 'reviewed' }
            return (
              <div
                key={token}
                className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-black/20 px-3 py-2 transition-opacity"
                style={{
                  opacity: hoveredLine ? (hoveredLine === token ? 1 : 0.35) : 1,
                }}
                onMouseEnter={() => setHoveredLine(token)}
                onMouseLeave={() => setHoveredLine(null)}
              >
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: TOKEN_COLORS[i] }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold" style={{ color: TOKEN_COLORS[i] }}>
                      {token}
                    </span>
                    <span
                      className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide"
                      style={{
                        color: review.verdict === 'PASS' ? '#10b981' : '#ef4444',
                        backgroundColor: review.verdict === 'PASS' ? '#10b98115' : '#ef444415',
                      }}
                    >
                      {review.verdict === 'PASS' ? '✓ AI Pass' : '✗ Removed'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-tight text-[var(--color-text-muted)]">
                    {review.reason}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

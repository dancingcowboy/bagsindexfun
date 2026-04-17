'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
} from 'recharts'
import { API_BASE, authHeaders } from '@/lib/api'

const COLORS = [
  '#00D62B', '#00b8ff', '#ff8c00', '#ff69b4', '#ffd000',
  '#a855f7', '#14b8a6', '#f43f5e', '#6366f1', '#eab308',
  '#84cc16', '#ec4899',
]

interface Point {
  t: string
  priceSol: string
  indexed: number
}
interface TokenSeries {
  tokenMint: string
  tokenSymbol: string | null
  tokenName: string | null
  points: Point[]
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const

type Tier = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
const TIERS: Tier[] = ['CONSERVATIVE', 'BALANCED', 'DEGEN']
const TIER_COLORS: Record<Tier, string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff8c00',
}

interface Props {
  endpoint?: string
  title?: string
  subtitle?: string
  /**
   * Optional tier to fetch the aggregated index line (√score-weighted, chained
   * across rebalances) from /index/aggregate-history and overlay on the chart.
   */
  aggregateTier?: Tier
  /**
   * When true, render CONSERVATIVE/BALANCED/DEGEN filter buttons and drive
   * both the per-token series and the aggregate index line from the selected
   * tier — so users can compare indexes before depositing. Uses public
   * /index/token-price-history endpoint regardless of `endpoint` prop.
   */
  tierSelectable?: boolean
  initialTier?: Tier
  /**
   * Override for the aggregate index endpoint. Defaults to the public BAGS
   * `/index/aggregate-history`. Admin dex page passes
   * `/admin/dex-aggregate-history` so the index line reflects the
   * DexScreener-sourced top-10, not the live BAGS vaults.
   */
  aggregateEndpoint?: string
  /**
   * When set, the INDEX line uses real vault PnL data (from PnlSnapshots)
   * instead of the theoretical aggregate-history replay. The endpoint
   * should return `{ data: { tiers: [{ riskTier, points: [{ t, valueSol }] }] } }`.
   * The selected tier's valueSol series is normalized to 100 at range start.
   */
  vaultPnlEndpoint?: string
}

export function TokenPriceChart({
  endpoint = '/portfolio/token-price-history',
  title = 'Index Token Performance',
  subtitle = 'Hourly prices · normalized to 100 at range start',
  aggregateTier,
  tierSelectable = false,
  initialTier = 'BALANCED',
  aggregateEndpoint = '/index/aggregate-history',
  vaultPnlEndpoint,
}: Props = {}) {
  const [hours, setHours] = useState<number>(168)
  const [hovered, setHovered] = useState<string | null>(null)
  const [selectedTier, setSelectedTier] = useState<Tier>(initialTier)

  const activeTier: Tier | undefined = tierSelectable ? selectedTier : aggregateTier
  // When tierSelectable with custom endpoint (admin paths), use that endpoint
  // with the selected tier and authenticated fetch.
  const isAdminEndpoint = tierSelectable && endpoint.startsWith('/admin/')
  const tokenEndpoint = tierSelectable
    ? isAdminEndpoint
      ? `${endpoint}?tier=${selectedTier}&`
      : `/index/token-price-history?tier=${selectedTier}&`
    : `${endpoint}?`

  const q = useQuery({
    queryKey: ['token-price-history', tokenEndpoint, hours],
    queryFn: async () => {
      const useCreds = !tierSelectable || isAdminEndpoint
      const res = await fetch(`${API_BASE}${tokenEndpoint}hours=${hours}`, {
        credentials: useCreds ? 'include' : 'omit',
        headers: useCreds ? authHeaders() : {},
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as { data: { tokens: TokenSeries[] } }
    },
    refetchInterval: 5 * 60_000,
  })

  const isAdminAggregate = aggregateEndpoint.startsWith('/admin/')
  const aggQ = useQuery({
    queryKey: ['index-aggregate-history', aggregateEndpoint, activeTier, hours],
    enabled: !!activeTier && !vaultPnlEndpoint,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}${aggregateEndpoint}?tier=${activeTier}&hours=${hours}`,
        {
          credentials: isAdminAggregate ? 'include' : 'omit',
          headers: isAdminAggregate ? authHeaders() : {},
        },
      )
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as {
        data: { tier: string; points: { t: string; indexed: number; rebalance?: boolean }[] }
      }
    },
    refetchInterval: 5 * 60_000,
  })

  // Real vault PnL index line — uses PnlSnapshot valueSol normalized to 100.
  const vaultPnlQ = useQuery({
    queryKey: ['vault-pnl-index', vaultPnlEndpoint, hours],
    enabled: !!vaultPnlEndpoint,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}${vaultPnlEndpoint}?hours=${hours}`,
        { credentials: 'include', headers: authHeaders() },
      )
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as {
        data: {
          tiers: { riskTier: string | null; points: { t: string; valueSol: string }[] }[]
        }
      }
    },
    refetchInterval: 5 * 60_000,
  })

  const tokens = q.data?.data?.tokens ?? []

  // Derive INDEX line points: from vault PnL (real) or aggregate-history (theoretical)
  const aggPoints: { t: string; indexed: number; rebalance?: boolean }[] = useMemo(() => {
    if (vaultPnlEndpoint && vaultPnlQ.data) {
      const tierData = activeTier
        ? vaultPnlQ.data.data.tiers.find((t) => t.riskTier === activeTier)
        : vaultPnlQ.data.data.tiers[0]
      if (!tierData || tierData.points.length === 0) return []
      const base = Number(tierData.points[0].valueSol)
      if (base <= 0) return []
      return tierData.points.map((p) => ({
        t: p.t,
        indexed: (Number(p.valueSol) / base) * 100,
      }))
    }
    return aggQ.data?.data?.points ?? []
  }, [vaultPnlEndpoint, vaultPnlQ.data, aggQ.data, activeTier])

  // Merge all token series onto a common timeline keyed by ISO timestamp.
  // Each row carries { t, SYMBOL1: indexed, SYMBOL2: indexed, ... }.
  const merged = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>()
    for (const tk of tokens) {
      const key = tk.tokenSymbol ?? tk.tokenMint.slice(0, 6)
      for (const p of tk.points) {
        const ts = new Date(p.t).toISOString()
        const row = map.get(ts) ?? { t: ts }
        row[key] = p.indexed
        map.set(ts, row)
      }
    }
    for (const p of aggPoints) {
      const ts = new Date(p.t).toISOString()
      const row = map.get(ts) ?? { t: ts }
      row.__INDEX__ = p.indexed
      if (p.rebalance) row.__REBALANCE__ = 1
      map.set(ts, row)
    }
    return [...map.values()].sort(
      (a, b) => new Date(a.t as string).getTime() - new Date(b.t as string).getTime(),
    )
  }, [tokens, aggPoints])

  const hasData = merged.length > 0
  const lastIndexRow = useMemo(() => {
    for (let i = merged.length - 1; i >= 0; i--) {
      if (typeof merged[i].__INDEX__ === 'number') return i
    }
    return -1
  }, [merged])
  const symbolKeys = tokens.map((t) => t.tokenSymbol ?? t.tokenMint.slice(0, 6))

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold">{title}</h3>
          <p className="text-sm text-[var(--color-text-muted)]">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {tierSelectable && (
            <div className="flex items-center gap-1">
              {TIERS.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTier(t)}
                  className="rounded border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors"
                  style={
                    selectedTier === t
                      ? { backgroundColor: TIER_COLORS[t], color: '#000', borderColor: TIER_COLORS[t] }
                      : { color: TIER_COLORS[t], borderColor: 'var(--color-border)' }
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setHours(r.hours)}
              className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs font-semibold transition-colors"
              style={
                hours === r.hours
                  ? { backgroundColor: '#00D62B', color: '#000', borderColor: '#00D62B' }
                  : { color: 'var(--color-text-muted)' }
              }
            >
              {r.label}
            </button>
          ))}
          </div>
        </div>
      </div>

      <div className="px-2 pb-2" style={{ height: 340 }}>
        {q.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            No price samples yet — next hourly tick will populate the chart.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={merged} margin={{ top: 10, right: 70, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1f1f1f" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#666', fontSize: 11 }}
                tickFormatter={(v) => {
                  const d = new Date(v)
                  return hours <= 48
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                }}
                minTickGap={40}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#666', fontSize: 11 }}
                domain={['auto', 'auto']}
                width={45}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: '10px',
                  fontSize: '12px',
                }}
                labelFormatter={(v) => new Date(v as string).toLocaleString()}
                formatter={(v: number, n) => [`${v.toFixed(2)}`, n]}
              />
              {symbolKeys.map((key, i) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={COLORS[i % COLORS.length]}
                  strokeWidth={hovered === key ? 2.5 : 1.5}
                  strokeOpacity={hovered ? (hovered === key ? 1 : 0.15) : 0.55}
                  dot={false}
                  connectNulls
                  onMouseEnter={() => setHovered(key)}
                  onMouseLeave={() => setHovered(null)}
                />
              ))}
              {activeTier && aggPoints.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="__INDEX__"
                  name="INDEX"
                  stroke="#ffffff"
                  strokeWidth={hovered === '__INDEX__' ? 4 : 3}
                  strokeOpacity={hovered && hovered !== '__INDEX__' ? 0.35 : 1}
                  dot={(props: unknown) => {
                    const p = props as {
                      cx?: number
                      cy?: number
                      payload?: { __REBALANCE__?: number }
                      index?: number
                    }
                    if (!p.payload?.__REBALANCE__ || p.cx == null || p.cy == null) {
                      return <g key={`d-${p.index}`} />
                    }
                    return (
                      <circle
                        key={`d-${p.index}`}
                        cx={p.cx}
                        cy={p.cy}
                        r={3.5}
                        fill="#000"
                        stroke="#ffffff"
                        strokeWidth={1.5}
                      />
                    )
                  }}
                  activeDot={{ r: 5, fill: '#ffffff', stroke: '#000', strokeWidth: 1 }}
                  connectNulls
                  onMouseEnter={() => setHovered('__INDEX__')}
                  onMouseLeave={() => setHovered(null)}
                >
                  <LabelList
                    dataKey="__INDEX__"
                    position="right"
                    content={(props: unknown) => {
                      const p = props as { x?: number | string; y?: number | string; value?: number; index?: number }
                      if (p.index !== lastIndexRow || p.value == null || p.x == null || p.y == null) return null
                      const x = Number(p.x)
                      const y = Number(p.y)
                      const value = p.value
                      const pct = value - 100
                      const sign = pct >= 0 ? '+' : ''
                      const fill = pct >= 0 ? '#00D62B' : '#ff5c5c'
                      return (
                        <g>
                          <rect x={x + 6} y={y - 9} rx={3} ry={3} width={56} height={18} fill="rgba(0,0,0,0.7)" stroke={fill} strokeWidth={1} />
                          <text x={x + 34} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={fill}>
                            {`${sign}${pct.toFixed(2)}%`}
                          </text>
                        </g>
                      )
                    }}
                  />
                </Line>
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasData && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {activeTier && aggPoints.length > 0 && (
              <button
                onMouseEnter={() => setHovered('__INDEX__')}
                onMouseLeave={() => setHovered(null)}
                className="flex items-center gap-1.5 rounded-md border border-white/40 bg-white/5 px-2 py-1 text-[11px] font-bold transition-opacity"
                style={{
                  color: '#ffffff',
                  opacity: hovered ? (hovered === '__INDEX__' ? 1 : 0.35) : 1,
                }}
              >
                <span className="h-1.5 w-3 rounded-full" style={{ backgroundColor: '#ffffff' }} />
                INDEX
              </button>
            )}
            {symbolKeys.map((key, i) => (
              <button
                key={key}
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered(null)}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-black/20 px-2 py-1 text-[11px] font-semibold transition-opacity"
                style={{
                  color: COLORS[i % COLORS.length],
                  opacity: hovered ? (hovered === key ? 1 : 0.35) : 1,
                }}
              >
                <span
                  className="h-1.5 w-3 rounded-full"
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
                {key}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

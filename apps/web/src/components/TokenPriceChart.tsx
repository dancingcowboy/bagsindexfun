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

interface Props {
  endpoint?: string
  title?: string
  subtitle?: string
}

export function TokenPriceChart({
  endpoint = '/portfolio/token-price-history',
  title = 'Index Token Performance',
  subtitle = 'Hourly prices · normalized to 100 at range start',
}: Props = {}) {
  const [hours, setHours] = useState<number>(168)
  const [hovered, setHovered] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['token-price-history', endpoint, hours],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}${endpoint}?hours=${hours}`, {
        credentials: 'include',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as { data: { tokens: TokenSeries[] } }
    },
    refetchInterval: 5 * 60_000,
  })

  const tokens = q.data?.data?.tokens ?? []

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
    return [...map.values()].sort(
      (a, b) => new Date(a.t as string).getTime() - new Date(b.t as string).getTime(),
    )
  }, [tokens])

  const hasData = merged.length > 0
  const symbolKeys = tokens.map((t) => t.tokenSymbol ?? t.tokenMint.slice(0, 6))

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold">{title}</h3>
          <p className="text-sm text-[var(--color-text-muted)]">{subtitle}</p>
        </div>
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
            <LineChart data={merged} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
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
                  strokeOpacity={hovered ? (hovered === key ? 1 : 0.15) : 0.75}
                  dot={false}
                  connectNulls
                  onMouseEnter={() => setHovered(key)}
                  onMouseLeave={() => setHovered(null)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasData && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <div className="flex flex-wrap gap-2">
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

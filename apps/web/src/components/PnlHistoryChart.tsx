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

const TIER_COLOR: Record<string, string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff8c00',
}

interface Point {
  t: string
  valueSol: string
  costSol: string
  unrealizedSol: string
  realizedSol: string
}
interface TierHistory {
  riskTier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
  walletAddress: string
  points: Point[]
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: '90d', hours: 2160 },
] as const

export function PnlHistoryChart() {
  const [hours, setHours] = useState<number>(168)

  const q = useQuery({
    queryKey: ['pnl-history', hours],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/portfolio/pnl-history?hours=${hours}`, {
        credentials: 'include',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as { data: { tiers: TierHistory[] } }
    },
    refetchInterval: 5 * 60_000,
  })

  // Merge all tier points onto a common timeline keyed by ISO timestamp
  const merged = useMemo(() => {
    const tiers = q.data?.data?.tiers ?? []
    const map = new Map<string, Record<string, number | string>>()
    for (const t of tiers) {
      for (const p of t.points) {
        const key = new Date(p.t).toISOString()
        const row = map.get(key) ?? { t: key }
        row[t.riskTier] = Number(p.valueSol)
        map.set(key, row)
      }
    }
    return [...map.values()].sort(
      (a, b) => new Date(a.t as string).getTime() - new Date(b.t as string).getTime(),
    )
  }, [q.data])

  const tiers = q.data?.data?.tiers ?? []
  const hasData = merged.length > 0

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold">Vault PnL History</h3>
          <p className="text-sm text-[var(--color-text-muted)]">
            Hourly snapshots · value in SOL per tier
          </p>
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

      <div className="px-2 pb-4" style={{ height: 320 }}>
        {q.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            No snapshots yet — first hourly tick will populate the chart.
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
                width={60}
                tickFormatter={(v: number) => `${v.toFixed(3)}`}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: '10px',
                  fontSize: '12px',
                }}
                labelFormatter={(v) => new Date(v as string).toLocaleString()}
                formatter={(v: number) => `${Number(v).toFixed(4)} SOL`}
              />
              {tiers.map((t) => (
                <Line
                  key={t.riskTier}
                  type="monotone"
                  dataKey={t.riskTier}
                  name={t.riskTier}
                  stroke={TIER_COLOR[t.riskTier] ?? '#888'}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

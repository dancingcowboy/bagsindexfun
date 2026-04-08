'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts'
import { API_BASE, authHeaders } from '@/lib/api'

interface TwrPoint {
  t: string
  twr: number
  valueSol: number
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const

/**
 * Time-weighted return chart for the protocol vault. Strips out fee-claim
 * cashflows so the line reflects pure price performance, not "the vault
 * grew because more fees came in." Index normalized to 100 at the start
 * of the selected range.
 */
export function VaultTwrChart() {
  const [hours, setHours] = useState<number>(168)

  const q = useQuery({
    queryKey: ['vault-twr-history', hours],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/admin/vault-twr-history?hours=${hours}`, {
        credentials: 'include',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as {
        data: { points: TwrPoint[]; cashflowCount: number }
      }
    },
    refetchInterval: 5 * 60_000,
  })

  const points = q.data?.data?.points ?? []
  const cashflowCount = q.data?.data?.cashflowCount ?? 0
  const last = points.at(-1)
  const pctMove = last ? (last.twr - 100).toFixed(2) : '0.00'
  const isUp = last ? last.twr >= 100 : true

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold">Vault Time-Weighted Return</h3>
          <p className="text-sm text-[var(--color-text-muted)]">
            Pure price performance · {cashflowCount} fee-claim cashflows neutralized · base 100
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div
            className="rounded-md border px-3 py-1 text-sm font-bold"
            style={{
              color: isUp ? '#00D62B' : '#ff5555',
              borderColor: isUp ? '#00D62B' : '#ff5555',
            }}
          >
            {isUp ? '+' : ''}
            {pctMove}%
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
      </div>

      <div className="px-2 pb-2" style={{ height: 280 }}>
        {q.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Loading…
          </div>
        ) : points.length < 2 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            Not enough snapshots yet — need ≥2 hourly samples to compute TWR.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
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
                formatter={(v: number, n) => {
                  if (n === 'twr') return [`${v.toFixed(2)}`, 'TWR']
                  if (n === 'valueSol') return [`${v.toFixed(4)} SOL`, 'Raw value']
                  return [v, n]
                }}
              />
              <ReferenceLine y={100} stroke="#444" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="twr"
                stroke="#00D62B"
                strokeWidth={2.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

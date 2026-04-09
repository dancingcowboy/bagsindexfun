'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { API_BASE } from '@/lib/api'

interface ScheduleRow {
  tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
  lastScoredAt: string | null
  nextScoringAt: string | null
  intervalMs: number
}

const TIER_COLOR: Record<string, string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff8c00',
}

function formatCountdown(target: string | null, nowMs: number) {
  if (!target) return '—'
  const diff = new Date(target).getTime() - nowMs
  if (diff <= 0) return 'due now'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  const s = Math.floor((diff % 60_000) / 1000)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Per-tier countdown to the next scoring cycle. Rebalance fires reactively
 * after scoring if the top-10 composition changed. Fetches /index/schedule
 * without credentials so it can render on the public landing page.
 */
export function NextCycleCountdown({ compact = false }: { compact?: boolean }) {
  const q = useQuery({
    queryKey: ['index-schedule'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/index/schedule`, { credentials: 'omit' })
      if (!res.ok) throw new Error(`${res.status}`)
      return (await res.json()) as { data: ScheduleRow[] }
    },
    refetchInterval: 60_000,
  })

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const rows = q.data?.data ?? []

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Clock className="h-5 w-5 text-[var(--color-text-muted)]" />
        <h2
          className={
            compact
              ? 'font-[family-name:var(--font-display)] text-xl font-bold'
              : 'font-[family-name:var(--font-display)] text-2xl font-bold'
          }
        >
          Next Cycle
        </h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const).map((tier) => {
          const row = rows.find((r) => r.tier === tier)
          return (
            <div key={tier} className="card">
              <div
                className="text-xs uppercase tracking-wider mb-1 font-semibold"
                style={{ color: TIER_COLOR[tier] }}
              >
                {tier}
              </div>
              <div className="font-mono text-2xl font-bold tabular-nums">
                {formatCountdown(row?.nextScoringAt ?? null, nowMs)}
              </div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
                {row?.lastScoredAt
                  ? `last ${new Date(row.lastScoredAt).toLocaleString()}`
                  : 'no cycle yet'}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mt-2">
        Rebalance fires after scoring if the top-10 composition changes.
      </p>
    </div>
  )
}

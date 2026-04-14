'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePrivy } from '@privy-io/react-auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  Flame,
  Play,
  Shield,
  Zap,
} from 'lucide-react'
import { LogoFull } from '@/components/Logo'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return (await res.json()) as T
}

type SortKey =
  | 'rank'
  | 'compositeScore'
  | 'volume24h'
  | 'marketCapUsd'
  | 'holderCount'
  | 'holderGrowthPct'
  | 'liquidityUsd'
  | 'priceUsd'
type SortDir = 'asc' | 'desc'
type TierFilter = 'ALL' | 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

const TIER_META = {
  CONSERVATIVE: { label: 'Conservative', color: '#00b8ff', icon: Shield },
  BALANCED: { label: 'Balanced', color: '#00D62B', icon: BarChart3 },
  DEGEN: { label: 'Degen', color: '#ff8c00', icon: Zap },
} as const

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.0001) return `$${n.toFixed(4)}`
  return `$${n.toExponential(2)}`
}

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function CopyMintButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(mint)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
      title="Copy contract address"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export default function AdminDexHotlistPage() {
  const router = useRouter()
  const { ready: privyReady, authenticated: privyAuth } = usePrivy()
  const qc = useQueryClient()

  const me = useQuery({
    queryKey: ['auth-me-dex'],
    queryFn: () =>
      fetchJson<{ data: { isAdmin?: boolean } }>('/auth/me'),
    enabled: privyReady && privyAuth,
    retry: false,
  })

  useEffect(() => {
    if (!privyReady) return
    if (!privyAuth) {
      router.push('/')
      return
    }
    if (me.isError || (me.data && !me.data.data?.isAdmin)) {
      router.push('/')
    }
  }, [privyReady, privyAuth, me.data, me.isError, router])

  const [tierFilter, setTierFilter] = useState<TierFilter>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('compositeScore')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-dex-hotlist'],
    queryFn: () => fetchJson<{ data: any[] }>('/admin/dex-hotlist'),
    enabled: Boolean(me.data?.data?.isAdmin),
    refetchInterval: 2 * 60 * 1000,
  })

  const trigger = useMutation({
    mutationFn: () =>
      fetchJson<{ data: { jobId: string } }>(
        '/admin/trigger-dex-scoring',
        { method: 'POST' },
      ),
    onSuccess: () => {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['admin-dex-hotlist'] })
        refetch()
      }, 2000)
    },
  })

  const tokens = useMemo(() => {
    if (!data?.data) return []
    const all: any[] = []
    for (const tierData of data.data) {
      for (const t of tierData.tokens) {
        all.push({ ...t, tier: tierData.tier, scoredAt: tierData.scoredAt })
      }
    }
    const byMint = new Map<string, any>()
    for (const t of all) {
      const existing = byMint.get(t.tokenMint)
      if (
        !existing ||
        (t.rank > 0 &&
          (existing.rank === 0 || t.compositeScore > existing.compositeScore))
      ) {
        byMint.set(t.tokenMint, { ...t, tiers: [t.tier] })
      }
      if (existing && !existing.tiers.includes(t.tier)) {
        existing.tiers.push(t.tier)
      }
    }
    let filtered = [...byMint.values()]
    if (tierFilter !== 'ALL') {
      filtered = filtered.filter((t) => t.tiers.includes(tierFilter))
    }
    filtered.sort((a, b) => {
      const aVal = a[sortKey] ?? 0
      const bVal = b[sortKey] ?? 0
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
    return filtered
  }, [data, tierFilter, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const SortHeader = ({
    label,
    field,
  }: {
    label: string
    field: SortKey
  }) => (
    <th
      className="px-3 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider cursor-pointer hover:text-[var(--color-text-primary)] transition-colors select-none"
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown
          size={12}
          className={
            sortKey === field ? 'text-[var(--color-accent)]' : 'opacity-30'
          }
        />
      </span>
    </th>
  )

  const latestScoredAt = data?.data
    ?.map((d: any) => d.scoredAt)
    .filter(Boolean)
    .sort()
    .pop()

  if (!privyReady || me.isLoading || !me.data?.data?.isAdmin) {
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)] flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <nav className="fixed top-0 z-50 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link href="/">
            <LogoFull />
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/admin"
              className="btn-ghost text-sm hidden sm:flex items-center gap-1"
            >
              <ArrowLeft size={14} /> Admin
            </Link>
            <Link href="/dashboard" className="btn-primary text-sm">
              Dashboard
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-24 pb-16">
        <div className="mb-8 flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Flame size={28} className="text-[var(--color-orange)]" />
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Admin — DexScreener Hotlist
              </h1>
              <span className="badge-red text-[10px] uppercase tracking-wider">
                Admin
              </span>
            </div>
            <p className="text-[var(--color-text-muted)] text-sm sm:text-base">
              Top Solana performers from DexScreener, scored through C/B/D risk
              lenses. Read-only intel feed — no trading, no rebalance.
            </p>
            {latestScoredAt && (
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                Last scored: {new Date(latestScoredAt).toLocaleString()}
              </p>
            )}
          </div>
          <button
            onClick={() => trigger.mutate()}
            disabled={trigger.isPending}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Play size={14} />
            {trigger.isPending ? 'Queuing…' : 'Run Now'}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          {(['ALL', 'CONSERVATIVE', 'BALANCED', 'DEGEN'] as const).map((t) => {
            const active = tierFilter === t
            const meta = t !== 'ALL' ? TIER_META[t] : null
            const Icon = meta?.icon
            return (
              <button
                key={t}
                onClick={() => setTierFilter(t)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all"
                style={{
                  background: active
                    ? meta
                      ? `${meta.color}20`
                      : 'var(--color-bg-elevated)'
                    : 'var(--color-bg-card)',
                  color: active
                    ? meta?.color ?? 'var(--color-text-primary)'
                    : 'var(--color-text-muted)',
                  border: `1px solid ${active ? meta?.color ?? 'var(--color-border)' : 'var(--color-border)'}`,
                }}
              >
                {Icon && <Icon size={14} />}
                {t === 'ALL' ? 'All Tiers' : meta?.label}
              </button>
            )
          })}
          <span className="ml-auto text-xs text-[var(--color-text-muted)] self-center">
            {tokens.length} tokens
          </span>
        </div>

        {isLoading && (
          <div className="card flex items-center justify-center py-20">
            <div className="h-8 w-8 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
          </div>
        )}

        {!isLoading && tokens.length > 0 && (
          <>
            <div className="hidden md:block card p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-[var(--color-border)]">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider w-[200px]">
                        Token
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                        Tier
                      </th>
                      <SortHeader label="Score" field="compositeScore" />
                      <SortHeader label="Price" field="priceUsd" />
                      <SortHeader label="MC" field="marketCapUsd" />
                      <SortHeader label="24h Vol" field="volume24h" />
                      <SortHeader label="Holders" field="holderCount" />
                      <SortHeader label="Growth" field="holderGrowthPct" />
                      <SortHeader label="Liquidity" field="liquidityUsd" />
                      <th className="px-3 py-3 text-left text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                        Links
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border-subtle)]">
                    {tokens.map((t) => (
                      <tr
                        key={t.tokenMint}
                        className="hover:bg-[var(--color-bg-hover)] transition-colors"
                        style={{ opacity: t.isBlacklisted ? 0.4 : 1 }}
                      >
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <div>
                              <span className="font-semibold text-sm">
                                {t.tokenSymbol ?? t.tokenMint.slice(0, 6)}
                              </span>
                              {t.rank > 0 && (
                                <span className="ml-1.5 text-[10px] font-mono text-[var(--color-text-muted)]">
                                  #{t.rank}
                                </span>
                              )}
                              {t.isBlacklisted && (
                                <span className="ml-1.5 badge-red text-[10px]">
                                  removed
                                </span>
                              )}
                            </div>
                            <CopyMintButton mint={t.tokenMint} />
                          </div>
                          {t.tokenName && (
                            <div className="text-[11px] text-[var(--color-text-muted)] truncate max-w-[180px]">
                              {t.tokenName}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(t.tiers ?? [t.tier]).map((tier: string) => {
                              const m =
                                TIER_META[tier as keyof typeof TIER_META]
                              return (
                                <span
                                  key={tier}
                                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                  style={{
                                    background: `${m.color}18`,
                                    color: m.color,
                                  }}
                                >
                                  {m.label}
                                </span>
                              )
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {t.compositeScore > 0
                            ? t.compositeScore.toFixed(4)
                            : '—'}
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {formatUsd(t.priceUsd)}
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {formatUsd(t.marketCapUsd)}
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {formatUsd(t.volume24h)}
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {formatNum(t.holderCount)}
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          <span
                            style={{
                              color:
                                t.holderGrowthPct > 0
                                  ? 'var(--color-green)'
                                  : t.holderGrowthPct < 0
                                    ? 'var(--color-red)'
                                    : 'var(--color-text-muted)',
                            }}
                          >
                            {t.holderGrowthPct > 0 ? '+' : ''}
                            {t.holderGrowthPct.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-3 py-3 font-mono text-sm">
                          {formatUsd(t.liquidityUsd)}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex gap-2">
                            <a
                              href={`https://dexscreener.com/solana/${t.tokenMint}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                              title="View on DexScreener"
                            >
                              <ExternalLink size={14} />
                            </a>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="md:hidden flex flex-col gap-3">
              {tokens.map((t) => (
                <div
                  key={t.tokenMint}
                  className="card"
                  style={{ opacity: t.isBlacklisted ? 0.4 : 1 }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">
                          {t.tokenSymbol ?? t.tokenMint.slice(0, 6)}
                        </span>
                        {t.rank > 0 && (
                          <span className="text-xs font-mono text-[var(--color-text-muted)]">
                            #{t.rank}
                          </span>
                        )}
                        {t.isBlacklisted && (
                          <span className="badge-red text-[10px]">removed</span>
                        )}
                        <CopyMintButton mint={t.tokenMint} />
                      </div>
                      {t.tokenName && (
                        <div className="text-xs text-[var(--color-text-muted)]">
                          {t.tokenName}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {(t.tiers ?? [t.tier]).map((tier: string) => {
                        const m = TIER_META[tier as keyof typeof TIER_META]
                        return (
                          <span
                            key={tier}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{
                              background: `${m.color}18`,
                              color: m.color,
                            }}
                          >
                            {m.label}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Price
                      </span>
                      <div className="font-mono">{formatUsd(t.priceUsd)}</div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Market Cap
                      </span>
                      <div className="font-mono">
                        {formatUsd(t.marketCapUsd)}
                      </div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        24h Volume
                      </span>
                      <div className="font-mono">
                        {formatUsd(t.volume24h)}
                      </div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Holders
                      </span>
                      <div className="font-mono">
                        {formatNum(t.holderCount)}
                      </div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Holder Growth
                      </span>
                      <div
                        className="font-mono"
                        style={{
                          color:
                            t.holderGrowthPct > 0
                              ? 'var(--color-green)'
                              : t.holderGrowthPct < 0
                                ? 'var(--color-red)'
                                : 'var(--color-text-muted)',
                        }}
                      >
                        {t.holderGrowthPct > 0 ? '+' : ''}
                        {t.holderGrowthPct.toFixed(1)}%
                      </div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Liquidity
                      </span>
                      <div className="font-mono">
                        {formatUsd(t.liquidityUsd)}
                      </div>
                    </div>
                    <div>
                      <span className="text-[var(--color-text-muted)] text-xs">
                        Score
                      </span>
                      <div className="font-mono">
                        {t.compositeScore > 0
                          ? t.compositeScore.toFixed(4)
                          : '—'}
                      </div>
                    </div>
                    <div className="flex items-end">
                      <a
                        href={`https://dexscreener.com/solana/${t.tokenMint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[var(--color-accent)] flex items-center gap-1"
                      >
                        Dex <ExternalLink size={12} />
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {!isLoading && tokens.length === 0 && (
          <div className="card flex flex-col items-center justify-center py-20 text-center">
            <Flame
              size={40}
              className="text-[var(--color-text-muted)] mb-4"
            />
            <p className="text-[var(--color-text-muted)]">
              No DexScreener cycles yet. Click "Run Now" above to populate.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

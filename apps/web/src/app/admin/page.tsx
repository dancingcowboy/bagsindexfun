'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePrivy } from '@privy-io/react-auth'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, RefreshCw, Play, Users, Coins, Flame, Shield, Activity, Twitter, Image as ImageIcon, Trash2, Send } from 'lucide-react'
import { LogoFull } from '@/components/Logo'
import { PnlHistoryChart } from '@/components/PnlHistoryChart'
import { TokenPriceChart } from '@/components/TokenPriceChart'
import { VaultTwrChart } from '@/components/VaultTwrChart'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

// Auth is cookie-based (HttpOnly bags_jwt, set server-side on /auth/login).
// Every request must pass `credentials: 'include'` so the cookie rides along.
function authHeaders(): Record<string, string> {
  return {}
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
  if (!res.ok) throw new Error(`${res.status}`)
  return (await res.json()) as T
}

interface Overview {
  data: {
    users: { total: number; new24h: number; new7d: number; subWallets: number }
    deposits: {
      total: number
      totalSol: string
      totalFeeSol: string
      count24h: number
      sol24h: string
      tierBreakdown: { tier: string; deposits: number; totalSol: string; feeSol: string }[]
    }
    withdrawals: { total: number; totalSol: string; totalFeeSol: string }
    burns: { total: number; solSpent: string }
    projectVaults: { total: number; totalSolReceived: string; currentValueSol: string }
    blacklist: { count: number }
    capacity: {
      tier: string
      current: number
      max: number
      pct: number
      intervalHours: number
      batchSize: number
      batchIntervalHours: number
    }[]
    scoring: {
      latestCycle: { id: string; status: string; startedAt: string; completedAt: string | null; tokenCount: number } | null
      queueWaiting: number
      queueActive: number
    }
    rebalance: {
      recent: {
        id: string; tier: string; status: string; startedAt: string; completedAt: string | null
        walletsTotal: number; walletsComplete: number; walletsFailed: number
      }[]
      queueWaiting: number
      queueActive: number
    }
    generatedAt: string
  }
}

interface UsersResp {
  data: {
    id: string; walletAddress: string; createdAt: string; lastSeenAt: string
    tiers: string[]; depositCount: number; withdrawalCount: number; totalDepositedSol: string
  }[]
}

const TIER_COLOR: Record<string, string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff8c00',
}

function fmt(n: string | number, dp = 3) {
  const v = typeof n === 'string' ? Number(n) : n
  if (!isFinite(v)) return '0'
  return v.toFixed(dp)
}
function shortAddr(a: string | null | undefined) {
  if (!a) return '—'
  if (a.length <= 12) return a
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}
function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

interface Tweet {
  id: string
  text: string
  imageUrl: string | null
  imageAlt: string | null
  scheduledAt: string
  status: 'DRAFT' | 'ACTIVE' | 'SENT' | 'FAILED'
  twitterId: string | null
  sentAt: string | null
  errorMessage: string | null
}

interface VaultData {
  walletAddress: string
  subWallets: {
    riskTier: string
    address: string
    holdings: { tokenMint: string; tokenSymbol: string | null; tokenName: string | null; amount: string; valueSolEst: string }[]
  }[]
  totals: {
    totalValueSol: string
    tokenValueSol?: string
    nativeSol?: string
    totalClaimedSol: string
    totalBurnedSol: string
    claimCount: number
  }
  recentClaims: {
    id: string
    amountSol: string
    feeSol: string
    createdAt: string
    status: string
  }[]
}

const TWEET_STATUS_COLOR: Record<string, string> = {
  DRAFT: '#888',
  ACTIVE: '#00D62B',
  SENT: '#00b8ff',
  FAILED: '#ff5555',
}

export default function AdminPage() {
  const router = useRouter()
  // Gate the entire page on /auth/me → isAdmin. Until the check resolves we
  // render nothing so non-admins never see the layout flash. If the user is
  // not an admin (or not authenticated), bounce silently to the landing page —
  // no "admin only" message, no invitation to poke.
  const { ready: privyReady, authenticated: privyAuth } = usePrivy()
  // Wait for Privy to finish hydrating AND for the AuthBridge to have had a
  // chance to set the bags_jwt cookie before we hit /auth/me — otherwise the
  // query races the login bridge, gets a 401, and silently bounces the admin
  // to the landing page.
  const me = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => fetchJson<{ data: { isAdmin?: boolean } }>('/auth/me'),
    enabled: privyReady && privyAuth,
    retry: 3,
    retryDelay: (attempt) => 500 * (attempt + 1),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!privyReady) return
    if (!privyAuth) {
      router.replace('/')
      return
    }
    if (me.isLoading || me.isFetching) return
    if (me.isError || !me.data?.data?.isAdmin) {
      router.replace('/')
    }
  }, [privyReady, privyAuth, me.isLoading, me.isFetching, me.isError, me.data, router])

  const [tab, setTab] = useState<'overview' | 'users' | 'pnl' | 'audit' | 'campaign' | 'vault'>('overview')

  const [vaultLive, setVaultLive] = useState(false)
  const vault = useQuery({
    queryKey: ['admin-vault', vaultLive],
    queryFn: () =>
      fetchJson<{ data: VaultData | null }>(
        `/admin/vault${vaultLive ? '?live=1' : ''}`,
      ),
    enabled: tab === 'vault',
    refetchInterval: tab === 'vault' ? 20_000 : false,
  })

  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => fetchJson<Overview>('/admin/overview'),
    refetchInterval: 15_000,
  })

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => fetchJson<UsersResp>('/admin/users?limit=100'),
    enabled: tab === 'users',
  })

  const audit = useQuery({
    queryKey: ['admin-audit'],
    queryFn: () => fetchJson<{ data: { id: string; userId: string | null; action: string; resource: string; ipAddress: string | null; createdAt: string }[] }>('/admin/audit?limit=100'),
    enabled: tab === 'audit',
  })

  const queryClient = useQueryClient()
  const pnl = useQuery({
    queryKey: ['admin-pnl'],
    queryFn: () => fetchJson<{ data: { pools: any[]; tiers: any[] } }>('/admin/pnl'),
    enabled: tab === 'pnl',
    refetchInterval: tab === 'pnl' ? 30_000 : false,
  })

  const tweets = useQuery({
    queryKey: ['admin-tweets'],
    queryFn: () => fetchJson<{ data: Tweet[] }>('/admin/tweets'),
    enabled: tab === 'campaign',
    refetchInterval: tab === 'campaign' ? 10_000 : false,
  })

  const seedTweets = useMutation({
    mutationFn: () => fetch(`${API_BASE}/admin/tweets/seed`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tweets'] }),
  })
  const launchTweets = useMutation({
    mutationFn: () => fetch(`${API_BASE}/admin/tweets/launch`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tweets'] }),
  })
  const resetTweets = useMutation({
    mutationFn: () => fetch(`${API_BASE}/admin/tweets/reset`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tweets'] }),
  })
  const prefillImages = useMutation({
    mutationFn: () => fetch(`${API_BASE}/admin/tweets/prefill-images`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tweets'] }),
  })

  const triggerScoring = useMutation({
    mutationFn: () =>
      fetch(`${API_BASE}/admin/trigger-scoring`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => overview.refetch(),
  })

  const triggerRebalance = useMutation({
    mutationFn: () =>
      fetch(`${API_BASE}/admin/trigger-rebalance`, { method: 'POST', headers: authHeaders(), credentials: 'include' }).then((r) => r.json()),
    onSuccess: () => overview.refetch(),
  })

  // Hard gate: render nothing while we resolve identity OR while we're
  // bouncing a non-admin away. Non-admins never see any admin chrome.
  if (!privyReady || !privyAuth || me.isLoading || me.isFetching || !me.data?.data?.isAdmin) {
    return <div className="min-h-screen bg-[var(--color-bg-primary)]" />
  }

  const isForbidden = (overview.error as Error)?.message === '403'
  const isUnauthorized = (overview.error as Error)?.message === '401'

  if (isForbidden || isUnauthorized) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <Shield className="mx-auto mb-4 h-12 w-12 text-[var(--color-text-muted)]" />
          <h1 className="mb-2 text-2xl font-bold">Admin only</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {isUnauthorized
              ? 'Sign in with an admin wallet to access this page.'
              : 'Your wallet is not on the admin whitelist.'}
          </p>
          <Link href="/" className="btn-outline mt-6 inline-block px-5 py-2 text-sm">
            Back to home
          </Link>
        </div>
      </div>
    )
  }

  const o = overview.data?.data

  return (
    <div className="min-h-screen">
      <nav className="fixed top-0 z-50 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <LogoFull />
            <span className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Admin
            </span>
          </div>
          <Link href="/" className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-6 pt-24 pb-24">
        {/* Tabs */}
        <div className="mb-8 flex items-center gap-2 border-b border-[var(--color-border)]">
          {(['overview', 'users', 'pnl', 'audit', 'campaign', 'vault'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'border-b-2 text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
              style={tab === t ? { borderColor: '#00D62B', color: '#00D62B' } : undefined}
            >
              {t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => triggerScoring.mutate()}
              disabled={triggerScoring.isPending}
              className="btn-outline flex items-center gap-1.5 px-3 py-1.5 text-xs"
            >
              <Play className="h-3 w-3" /> Trigger Scoring
            </button>
            <button
              onClick={() => triggerRebalance.mutate()}
              disabled={triggerRebalance.isPending}
              className="btn-outline flex items-center gap-1.5 px-3 py-1.5 text-xs"
            >
              <Play className="h-3 w-3" /> Trigger Rebalance
            </button>
            <button
              onClick={() => overview.refetch()}
              className="rounded-lg border border-[var(--color-border)] p-1.5"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${overview.isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {tab === 'overview' && (
          <>
            {!o ? (
              <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
            ) : (
              <div className="space-y-6">
                {/* Top KPIs */}
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Stat icon={<Users className="h-4 w-4" />} label="Users" value={o.users.total.toString()} sub={`+${o.users.new24h} 24h · +${o.users.new7d} 7d`} />
                  <Stat icon={<Coins className="h-4 w-4" />} label="Total Deposited" value={`${fmt(o.deposits.totalSol)} SOL`} sub={`${o.deposits.total} deposits · ${o.deposits.count24h} in 24h`} />
                  <Stat icon={<Activity className="h-4 w-4" />} label="Fees Collected" value={`${fmt(Number(o.deposits.totalFeeSol) + Number(o.withdrawals.totalFeeSol))} SOL`} sub={`${fmt(o.deposits.totalFeeSol)} deposit · ${fmt(o.withdrawals.totalFeeSol)} withdrawal`} />
                  <Stat icon={<Flame className="h-4 w-4" />} label="Tokens Burned" value={`${fmt(o.burns.solSpent)} SOL`} sub={`${o.burns.total} burns`} />
                </div>

                {/* Per-tier capacity vs ceiling. Ceiling = batch_size × tier_interval_h.
                    When current/max approaches 100% we either bump batch size, shorten the
                    batch interval, or add another worker process. */}
                <Panel title="Tier Capacity (wallets / max per scoring interval)">
                  <div className="grid gap-3 md:grid-cols-3">
                    {o.capacity?.map((c) => {
                      const pct = c.pct
                      const tone = pct >= 90 ? '#ff5555' : pct >= 70 ? '#ff8c00' : '#00D62B'
                      return (
                        <div key={c.tier} className="rounded-lg border border-[var(--color-border-subtle)] p-3">
                          <div className="flex items-center justify-between">
                            <span
                              className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                              style={{ color: TIER_COLOR[c.tier], backgroundColor: `${TIER_COLOR[c.tier]}15` }}
                            >
                              {c.tier}
                            </span>
                            <span className="text-xs text-[var(--color-text-muted)]">
                              every {c.intervalHours}h
                            </span>
                          </div>
                          <div className="mt-2 flex items-baseline gap-1.5 font-[family-name:var(--font-mono)]">
                            <span className="text-xl font-bold" style={{ color: tone }}>
                              {c.current}
                            </span>
                            <span className="text-sm text-[var(--color-text-muted)]">/ {c.max}</span>
                          </div>
                          <div className="mt-2 h-1.5 rounded-full bg-[var(--color-border-subtle)]">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(100, pct)}%`, backgroundColor: tone }}
                            />
                          </div>
                          <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
                            {c.batchSize} wallets / {c.batchIntervalHours}h batch · {pct}% used
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </Panel>

                {/* Tier breakdown */}
                <Panel title="Deposits by Tier">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                        <th className="py-2">Tier</th>
                        <th className="py-2 text-right">Deposits</th>
                        <th className="py-2 text-right">Volume (SOL)</th>
                        <th className="py-2 text-right">Fees (SOL)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.deposits.tierBreakdown.map((t) => (
                        <tr key={t.tier} className="border-t border-[var(--color-border-subtle)]">
                          <td className="py-2.5">
                            <span
                              className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                              style={{ color: TIER_COLOR[t.tier], backgroundColor: `${TIER_COLOR[t.tier]}15` }}
                            >
                              {t.tier}
                            </span>
                          </td>
                          <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{t.deposits}</td>
                          <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{fmt(t.totalSol)}</td>
                          <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{fmt(t.feeSol)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>

                {/* Two-col: scoring + project vaults */}
                <div className="grid gap-6 md:grid-cols-2">
                  <Panel title="Latest Scoring Cycle">
                    {o.scoring.latestCycle ? (
                      <div className="space-y-2 text-sm">
                        <Row label="Status" value={o.scoring.latestCycle.status} />
                        <Row label="Tokens scored" value={o.scoring.latestCycle.tokenCount.toString()} />
                        <Row label="Started" value={timeAgo(o.scoring.latestCycle.startedAt)} />
                        <Row label="Completed" value={o.scoring.latestCycle.completedAt ? timeAgo(o.scoring.latestCycle.completedAt) : '—'} />
                        <Row label="Queue" value={`${o.scoring.queueActive} active · ${o.scoring.queueWaiting} waiting`} />
                      </div>
                    ) : (
                      <div className="text-sm text-[var(--color-text-muted)]">No scoring cycles yet</div>
                    )}
                  </Panel>

                  <Panel title="Project Vaults (Bags App)">
                    <div className="space-y-2 text-sm">
                      <Row label="Registered projects" value={o.projectVaults.total.toString()} />
                      <Row label="SOL routed in" value={`${fmt(o.projectVaults.totalSolReceived)} SOL`} />
                      <Row label="Aggregate value" value={`${fmt(o.projectVaults.currentValueSol)} SOL`} />
                      <Row label="Sub-wallets total" value={o.users.subWallets.toString()} />
                      <Row label="Blacklist" value={`${o.blacklist.count} tokens`} />
                    </div>
                  </Panel>
                </div>

                {/* Recent rebalances */}
                <Panel title="Recent Rebalances">
                  {o.rebalance.recent.length === 0 ? (
                    <div className="text-sm text-[var(--color-text-muted)]">No rebalance cycles yet</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                          <th className="py-2">Tier</th>
                          <th className="py-2">Status</th>
                          <th className="py-2">Started</th>
                          <th className="py-2 text-right">Wallets</th>
                          <th className="py-2 text-right">Failed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.rebalance.recent.map((r) => (
                          <tr key={r.id} className="border-t border-[var(--color-border-subtle)]">
                            <td className="py-2.5">
                              <span
                                className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase"
                                style={{ color: TIER_COLOR[r.tier], backgroundColor: `${TIER_COLOR[r.tier]}15` }}
                              >
                                {r.tier}
                              </span>
                            </td>
                            <td className="py-2.5 text-xs">{r.status}</td>
                            <td className="py-2.5 text-xs text-[var(--color-text-muted)]">{timeAgo(r.startedAt)}</td>
                            <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">
                              {r.walletsComplete}/{r.walletsTotal}
                            </td>
                            <td className="py-2.5 text-right font-[family-name:var(--font-mono)]" style={{ color: r.walletsFailed > 0 ? '#ff5555' : undefined }}>
                              {r.walletsFailed}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">
                    Queue: {o.rebalance.queueActive} active · {o.rebalance.queueWaiting} waiting
                  </div>
                </Panel>
              </div>
            )}
          </>
        )}

        {tab === 'users' && (
          <Panel title={`Users (${users.data?.data.length ?? 0})`}>
            {users.isLoading ? (
              <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    <th className="py-2">Wallet</th>
                    <th className="py-2">Tiers</th>
                    <th className="py-2 text-right">Deposits</th>
                    <th className="py-2 text-right">Withdrawals</th>
                    <th className="py-2 text-right">Total SOL</th>
                    <th className="py-2 text-right">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data?.data.map((u) => (
                    <tr key={u.id} className="border-t border-[var(--color-border-subtle)]">
                      <td className="py-2.5 font-[family-name:var(--font-mono)] text-xs">{shortAddr(u.walletAddress)}</td>
                      <td className="py-2.5">
                        <div className="flex gap-1">
                          {u.tiers.map((t) => (
                            <span
                              key={t}
                              className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                              style={{ color: TIER_COLOR[t], backgroundColor: `${TIER_COLOR[t]}15` }}
                            >
                              {t.slice(0, 4)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{u.depositCount}</td>
                      <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{u.withdrawalCount}</td>
                      <td className="py-2.5 text-right font-[family-name:var(--font-mono)]">{fmt(u.totalDepositedSol)}</td>
                      <td className="py-2.5 text-right text-xs text-[var(--color-text-muted)]">{timeAgo(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {tab === 'audit' && (
          <Panel title={`Audit Log (${audit.data?.data.length ?? 0})`}>
            {audit.isLoading ? (
              <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    <th className="py-2">When</th>
                    <th className="py-2">User</th>
                    <th className="py-2">Action</th>
                    <th className="py-2">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data?.data.map((l) => (
                    <tr key={l.id} className="border-t border-[var(--color-border-subtle)]">
                      <td className="py-2 text-xs text-[var(--color-text-muted)]">{timeAgo(l.createdAt)}</td>
                      <td className="py-2 font-[family-name:var(--font-mono)] text-xs">{shortAddr(l.userId)}</td>
                      <td className="py-2 font-[family-name:var(--font-mono)] text-xs">{l.action}</td>
                      <td className="py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">{l.ipAddress}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {tab === 'pnl' && (
          <div className="space-y-6">
            <Panel title="Tier Aggregates">
              {pnl.isLoading ? (
                <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {pnl.data?.data.tiers.map((t: any) => {
                    const v = Number(t.totalPnlSol)
                    const positive = v >= 0
                    return (
                      <div key={t.riskTier} className="rounded-lg border border-[var(--color-border-subtle)] p-4">
                        <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{t.riskTier}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">{t.pools} pools</div>
                        <div className={`mt-2 font-[family-name:var(--font-display)] text-2xl font-bold ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                          {positive ? '+' : ''}{v.toFixed(4)} SOL
                        </div>
                        <div className={`text-sm ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                          {positive ? '+' : ''}{Number(t.pnlPct).toFixed(2)}%
                        </div>
                        <div className="mt-3 text-[11px] text-[var(--color-text-muted)] space-y-0.5">
                          <div>Value: <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.currentValueSol).toFixed(4)}</span></div>
                          <div>Cost: <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.costBasisSol).toFixed(4)}</span></div>
                          <div>Realized: <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.realizedSol).toFixed(4)}</span></div>
                          <div>Unrealized: <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.unrealizedSol).toFixed(4)}</span></div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Panel>

            <Panel title={`All Pools (${pnl.data?.data.pools.length ?? 0})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <th className="py-2">Tier</th>
                      <th className="py-2">Owner</th>
                      <th className="py-2 text-right">Value</th>
                      <th className="py-2 text-right">Cost</th>
                      <th className="py-2 text-right">Realized</th>
                      <th className="py-2 text-right">Unrealized</th>
                      <th className="py-2 text-right">PnL</th>
                      <th className="py-2 text-right">PnL %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pnl.data?.data.pools.map((p: any) => {
                      const pnlVal = Number(p.totalPnlSol)
                      const positive = pnlVal >= 0
                      return (
                        <tr key={p.subWalletId} className="border-t border-[var(--color-border-subtle)]">
                          <td className="py-2 text-xs">{p.riskTier}</td>
                          <td className="py-2 font-[family-name:var(--font-mono)] text-xs">{shortAddr(p.ownerWallet)}</td>
                          <td className="py-2 text-right font-[family-name:var(--font-mono)] text-xs">{Number(p.currentValueSol).toFixed(4)}</td>
                          <td className="py-2 text-right font-[family-name:var(--font-mono)] text-xs">{Number(p.costBasisSol).toFixed(4)}</td>
                          <td className="py-2 text-right font-[family-name:var(--font-mono)] text-xs">{Number(p.realizedSol).toFixed(4)}</td>
                          <td className="py-2 text-right font-[family-name:var(--font-mono)] text-xs">{Number(p.unrealizedSol).toFixed(4)}</td>
                          <td className={`py-2 text-right font-[family-name:var(--font-mono)] text-xs ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                            {positive ? '+' : ''}{pnlVal.toFixed(4)}
                          </td>
                          <td className={`py-2 text-right font-[family-name:var(--font-mono)] text-xs ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                            {positive ? '+' : ''}{Number(p.pnlPct).toFixed(2)}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}

        {tab === 'campaign' && (
          <CampaignTab
            tweets={tweets.data?.data ?? []}
            isLoading={tweets.isLoading}
            onSeed={() => seedTweets.mutate()}
            onLaunch={() => launchTweets.mutate()}
            onReset={() => {
              if (confirm('Delete the entire tweet queue? This cannot be undone.')) resetTweets.mutate()
            }}
            onPrefillImages={() => prefillImages.mutate()}
            seeding={seedTweets.isPending}
            launching={launchTweets.isPending}
            resetting={resetTweets.isPending}
            prefilling={prefillImages.isPending}
            refetch={() => queryClient.invalidateQueries({ queryKey: ['admin-tweets'] })}
          />
        )}

        {tab === 'vault' && (
          <div className="space-y-6">
            {vault.isLoading ? (
              <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
            ) : !vault.data?.data ? (
              <Panel title="Protocol Vault">
                <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
                  No system:protocol-vault user found yet.
                </div>
              </Panel>
            ) : (
              <>
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setVaultLive(true)
                      setTimeout(() => vault.refetch(), 0)
                    }}
                    disabled={vault.isFetching}
                    className="rounded border border-[var(--color-border)] px-3 py-1 text-xs font-bold uppercase hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
                  >
                    {vault.isFetching ? 'Refreshing…' : vaultLive ? 'Refresh Holdings (live)' : 'Refresh Holdings'}
                  </button>
                </div>
                {(() => {
                  const t = vault.data.data.totals
                  const claimed = Number(t.totalClaimedSol)
                  const burned = Number(t.totalBurnedSol)
                  const current = Number(t.totalValueSol)
                  // Expected "retained" after buy-and-burn: claimed - burned.
                  // Anything below that is market drawdown on tier holdings;
                  // anything above is upside on tier holdings.
                  const retained = claimed - burned
                  const marketPnl = current - retained
                  const marketPnlPct = retained > 0 ? (marketPnl / retained) * 100 : 0
                  const pnlColor = marketPnl >= 0 ? '#00D62B' : '#ff5c5c'
                  return (
                    <>
                      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        <Stat icon={<Coins className="h-4 w-4" />} label="Vault Value" value={`${t.totalValueSol} SOL`} sub={t.tokenValueSol != null ? `tokens ${t.tokenValueSol} + native ${t.nativeSol}` : 'current holdings est.'} />
                        <Stat icon={<Activity className="h-4 w-4" />} label="Claimed (all time)" value={`${t.totalClaimedSol} SOL`} sub={`${t.claimCount} claims`} />
                        <Stat icon={<Flame className="h-4 w-4" />} label="Burned (fees)" value={`${t.totalBurnedSol} SOL`} sub="buyback + burn (permanent)" />
                        <Stat icon={<Shield className="h-4 w-4" />} label="Sub-wallets" value={vault.data.data.subWallets.length.toString()} sub="per risk tier" />
                      </div>
                      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 text-xs">
                        <div className="mb-2 font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
                          Vault PnL breakdown
                        </div>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                          <div>
                            <div className="text-[var(--color-text-muted)]">Claimed in</div>
                            <div className="font-mono">{claimed.toFixed(6)} SOL</div>
                          </div>
                          <div>
                            <div className="text-[var(--color-text-muted)]">− Burned (by design)</div>
                            <div className="font-mono">−{burned.toFixed(6)} SOL</div>
                          </div>
                          <div>
                            <div className="text-[var(--color-text-muted)]">= Retained cost basis</div>
                            <div className="font-mono">{retained.toFixed(6)} SOL</div>
                          </div>
                          <div>
                            <div className="text-[var(--color-text-muted)]">Market PnL vs basis</div>
                            <div className="font-mono font-bold" style={{ color: pnlColor }}>
                              {marketPnl >= 0 ? '+' : ''}
                              {marketPnl.toFixed(6)} SOL ({marketPnl >= 0 ? '+' : ''}
                              {marketPnlPct.toFixed(2)}%)
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 text-[var(--color-text-muted)]">
                          60% of every fee claim is permanently removed via buy-and-burn of the
                          platform token — that portion is <strong>not a loss</strong>, it's the
                          deflationary mechanic. The remaining ~40% is allocated into the vault's
                          tier holdings and moves with the market (that's the &quot;Market PnL&quot;
                          above).
                        </div>
                      </div>
                    </>
                  )
                })()}

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <PnlHistoryChart
                    endpoint="/admin/vault-pnl-history"
                    title="Protocol Vault PnL"
                    subtitle="Hourly snapshots of the system vault — value in SOL per tier"
                  />
                  <VaultTwrChart />
                </div>

                <TokenPriceChart
                  tierSelectable
                  initialTier={vault.data?.data?.subWallets[0]?.riskTier as 'CONSERVATIVE' | 'BALANCED' | 'DEGEN' | undefined}
                  title="Compare Indexes (Vault)"
                  subtitle="Top-10 token prices + weighted index line · switch tiers to compare before flipping vault"
                />

                <Panel title="Switch Vault Tier">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Current: <strong>{vault.data.data.subWallets[0]?.riskTier ?? '—'}</strong>
                    </span>
                    {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const).map((t) => {
                      const current = vault.data?.data?.subWallets[0]?.riskTier
                      const disabled = current === t
                      return (
                        <button
                          key={t}
                          disabled={disabled}
                          onClick={async () => {
                            if (!confirm(`Switch protocol vault → ${t}? This rebalances all vault holdings.`)) return
                            try {
                              const res = await fetch(`${API_BASE}/admin/vault/switch`, {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ toTier: t }),
                              })
                              if (!res.ok) throw new Error(`${res.status}`)
                              alert(`Vault switch to ${t} enqueued`)
                              vault.refetch()
                            } catch (e: any) {
                              alert(`Failed: ${e?.message ?? e}`)
                            }
                          }}
                          className="rounded border border-[var(--color-border)] px-3 py-1 text-xs font-bold uppercase disabled:opacity-30"
                        >
                          {t}
                        </button>
                      )
                    })}
                  </div>
                </Panel>

                <Panel title="Reconcile Holdings">
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Sync DB holdings to actual on-chain balances (Helius). Fixes drift from slippage / partial fills.
                    </span>
                    <button
                      onClick={async () => {
                        if (!confirm('Reconcile vault holdings to on-chain balances?')) return
                        try {
                          const res = await fetch(`${API_BASE}/admin/vault/reconcile`, {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json', ...authHeaders() },
                            body: '{}',
                          })
                          const body = await res.json()
                          if (!res.ok) throw new Error(body?.error || `${res.status}`)
                          alert(
                            `Reconciled: ${body.data.updated} updated, ${body.data.inserted} inserted, ${body.data.deleted} deleted (${body.data.onChainMints} on-chain mints)`,
                          )
                          vault.refetch()
                        } catch (e: any) {
                          alert(`Failed: ${e?.message ?? e}`)
                        }
                      }}
                      className="rounded border border-[#00D62B] bg-[#00D62B]/10 px-3 py-1 text-xs font-bold uppercase text-[#00D62B]"
                    >
                      Reconcile now
                    </button>
                  </div>
                </Panel>

                <Panel title="Vault Wallet">
                  <div className="p-4 font-mono text-xs break-all text-[var(--color-text-secondary)]">
                    {vault.data.data.walletAddress}
                  </div>
                </Panel>

                <Panel title="Sub-Wallets & Holdings">
                  <div className="divide-y divide-[var(--color-border-subtle)]">
                    {vault.data.data.subWallets.map((w) => (
                      <div key={w.address} className="p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-bold uppercase">{w.riskTier}</span>
                          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{w.address}</span>
                        </div>
                        {w.holdings.length === 0 ? (
                          <div className="text-xs text-[var(--color-text-muted)]">No holdings</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead className="text-left text-[var(--color-text-muted)]">
                              <tr><th className="py-1">Token</th><th className="py-1 text-right">Amount</th><th className="py-1 text-right">Value (SOL)</th></tr>
                            </thead>
                            <tbody>
                              {w.holdings.map((h) => (
                                <tr key={h.tokenMint} className="border-t border-[var(--color-border-subtle)]">
                                  <td className="py-1">
                                    <div className="font-semibold">{h.tokenSymbol ?? '—'}</div>
                                    <div className="font-mono text-[10px] text-[var(--color-text-muted)]">{h.tokenMint.slice(0, 6)}…{h.tokenMint.slice(-4)}</div>
                                  </td>
                                  <td className="py-1 text-right">{h.amount}</td>
                                  <td className="py-1 text-right">{Number(h.valueSolEst).toFixed(4)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    ))}
                  </div>
                </Panel>

                <Panel title="Recent Claims">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[var(--color-text-muted)]">
                      <tr><th className="p-3">When</th><th className="p-3 text-right">Amount (SOL)</th><th className="p-3 text-right">Fee (SOL)</th><th className="p-3 text-right">Status</th></tr>
                    </thead>
                    <tbody>
                      {vault.data.data.recentClaims.map((c) => (
                        <tr key={c.id} className="border-t border-[var(--color-border-subtle)]">
                          <td className="p-3 text-xs">{new Date(c.createdAt).toLocaleString()}</td>
                          <td className="p-3 text-right">{c.amountSol}</td>
                          <td className="p-3 text-right">{c.feeSol}</td>
                          <td className="p-3 text-right text-xs">{c.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function CampaignTab({
  tweets,
  isLoading,
  onSeed,
  onLaunch,
  onReset,
  onPrefillImages,
  seeding,
  launching,
  resetting,
  prefilling,
  refetch,
}: {
  tweets: Tweet[]
  isLoading: boolean
  onSeed: () => void
  onLaunch: () => void
  onReset: () => void
  onPrefillImages: () => void
  seeding: boolean
  launching: boolean
  resetting: boolean
  prefilling: boolean
  refetch: () => void
}) {
  const counts = {
    total: tweets.length,
    draft: tweets.filter((t) => t.status === 'DRAFT').length,
    active: tweets.filter((t) => t.status === 'ACTIVE').length,
    sent: tweets.filter((t) => t.status === 'SENT').length,
    failed: tweets.filter((t) => t.status === 'FAILED').length,
    withImage: tweets.filter((t) => t.imageUrl).length,
  }

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        <Stat icon={<Twitter className="h-4 w-4" />} label="Total" value={counts.total.toString()} />
        <Stat icon={<Twitter className="h-4 w-4" />} label="Draft" value={counts.draft.toString()} />
        <Stat icon={<Send className="h-4 w-4" />} label="Active" value={counts.active.toString()} />
        <Stat icon={<Send className="h-4 w-4" />} label="Sent" value={counts.sent.toString()} />
        <Stat icon={<Trash2 className="h-4 w-4" />} label="Failed" value={counts.failed.toString()} />
        <Stat icon={<ImageIcon className="h-4 w-4" />} label="With Image" value={`${counts.withImage}/${counts.total}`} />
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
        <button onClick={onSeed} disabled={seeding || counts.total > 0} className="btn-outline px-3 py-1.5 text-xs disabled:opacity-40">
          {seeding ? 'Seeding…' : 'Seed 84 Tweets'}
        </button>
        <button onClick={onPrefillImages} disabled={prefilling || counts.total === 0} className="btn-outline px-3 py-1.5 text-xs disabled:opacity-40">
          {prefilling ? 'Fetching from Unsplash…' : 'Prefill Images (Unsplash)'}
        </button>
        <button onClick={onLaunch} disabled={launching || counts.draft === 0 && counts.failed === 0} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40">
          {launching ? 'Launching…' : 'Launch Campaign (every 4h)'}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={refetch} className="rounded-lg border border-[var(--color-border)] p-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button onClick={onReset} disabled={resetting || counts.total === 0} className="btn-outline px-3 py-1.5 text-xs disabled:opacity-40" style={{ borderColor: '#ff5555', color: '#ff5555' }}>
            {resetting ? 'Resetting…' : 'Reset Queue'}
          </button>
        </div>
      </div>

      {/* Tweet list */}
      {isLoading ? (
        <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
      ) : tweets.length === 0 ? (
        <Panel title="No tweets yet">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Click <strong>Seed 84 Tweets</strong> to populate the queue from the launch campaign plan, then{' '}
            <strong>Prefill Images</strong> to grab one Unsplash photo per tweet, then <strong>Launch Campaign</strong>{' '}
            to schedule them every 4 hours starting now.
          </p>
        </Panel>
      ) : (
        <div className="space-y-3">
          {tweets.map((t, i) => (
            <TweetCard key={t.id} tweet={t} index={i} onUpdated={refetch} />
          ))}
        </div>
      )}
    </div>
  )
}

function TweetCard({ tweet, index, onUpdated }: { tweet: Tweet; index: number; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(tweet.text)
  const [scheduledAt, setScheduledAt] = useState(tweet.scheduledAt.slice(0, 16))
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [imageQuery, setImageQuery] = useState(tweet.imageAlt || '')
  const [searchResults, setSearchResults] = useState<{ id: string; url: string; thumb: string; alt: string | null; credit: string }[]>([])
  const [searching, setSearching] = useState(false)

  const save = async () => {
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ text, scheduledAt: new Date(scheduledAt).toISOString() }),
    })
    setEditing(false)
    onUpdated()
  }

  const approve = async () => {
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ status: 'ACTIVE' }),
    })
    onUpdated()
  }

  const unapprove = async () => {
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ status: 'DRAFT' }),
    })
    onUpdated()
  }

  const remove = async () => {
    if (!confirm('Delete this tweet?')) return
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, { method: 'DELETE', headers: authHeaders(), credentials: 'include' })
    onUpdated()
  }

  const removeImage = async () => {
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ imageUrl: null }),
    })
    onUpdated()
  }

  const searchUnsplash = async () => {
    if (!imageQuery) return
    setSearching(true)
    try {
      const res = await fetch(`${API_BASE}/admin/tweets/unsplash?q=${encodeURIComponent(imageQuery)}`, { headers: authHeaders(), credentials: 'include' })
      const data = await res.json()
      setSearchResults(data.data || [])
    } finally {
      setSearching(false)
    }
  }

  const uploadFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be ≤ 5 MB')
      return
    }
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const res = await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ imageUrl: dataUrl, imageAlt: file.name }),
    })
    if (!res.ok) {
      alert('Upload failed')
      return
    }
    setShowImagePicker(false)
    onUpdated()
  }

  const pickImage = async (url: string, alt: string) => {
    await fetch(`${API_BASE}/admin/tweets/${tweet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'include',
      body: JSON.stringify({ imageUrl: url, imageAlt: alt }),
    })
    setShowImagePicker(false)
    setSearchResults([])
    onUpdated()
  }

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-[var(--color-text-muted)]">#{index + 1}</span>
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{
              color: TWEET_STATUS_COLOR[tweet.status],
              backgroundColor: `${TWEET_STATUS_COLOR[tweet.status]}15`,
            }}
          >
            {tweet.status}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {new Date(tweet.scheduledAt).toLocaleString()}
          </span>
          {tweet.twitterId && (
            <a
              href={`https://x.com/bagsIndexSol/status/${tweet.twitterId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px]"
              style={{ color: '#00b8ff' }}
            >
              View on X →
            </a>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!editing && tweet.status === 'DRAFT' && (
            <button
              onClick={approve}
              className="rounded-md border border-[#00D62B]/40 px-2 py-0.5 text-[11px] font-bold text-[#00D62B] hover:bg-[#00D62B]/10"
            >
              Approve
            </button>
          )}
          {!editing && tweet.status === 'ACTIVE' && (
            <button
              onClick={unapprove}
              className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              Unapprove
            </button>
          )}
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              Edit
            </button>
          )}
          <button onClick={remove} className="ml-2 text-[var(--color-text-muted)] hover:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_180px]">
        <div>
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={280}
                rows={4}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3 text-sm"
              />
              <div className="flex items-center gap-2">
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs"
                />
                <span className="text-[11px] text-[var(--color-text-muted)]">{text.length}/280</span>
                <div className="ml-auto flex gap-1">
                  <button onClick={() => setEditing(false)} className="btn-outline px-3 py-1 text-xs">Cancel</button>
                  <button onClick={save} className="btn-primary px-3 py-1 text-xs">Save</button>
                </div>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-primary)]">
              {tweet.text}
            </p>
          )}
          {tweet.errorMessage && (
            <p className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-300">
              {tweet.errorMessage}
            </p>
          )}
        </div>

        <div>
          {tweet.imageUrl ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tweet.imageUrl} alt={tweet.imageAlt || ''} className="h-28 w-full rounded-lg object-cover" />
              <div className="mt-1 flex gap-1">
                <button onClick={() => setShowImagePicker(!showImagePicker)} className="flex-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                  Change
                </button>
                <button onClick={removeImage} className="text-[10px] text-[var(--color-text-muted)] hover:text-red-400">
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowImagePicker(!showImagePicker)}
              className="flex h-28 w-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]"
            >
              <ImageIcon className="mr-1 h-3.5 w-3.5" /> Add image
            </button>
          )}
        </div>
      </div>

      {showImagePicker && (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3">
          <div className="mb-2 flex gap-2">
            <input
              value={imageQuery}
              onChange={(e) => setImageQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchUnsplash()}
              placeholder="Search Unsplash…"
              className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-card)] px-2 py-1 text-xs"
            />
            <button onClick={searchUnsplash} disabled={searching} className="btn-outline px-3 py-1 text-xs">
              {searching ? '…' : 'Search'}
            </button>
            <label className="btn-outline cursor-pointer px-3 py-1 text-xs">
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) uploadFile(f)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          {searchResults.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => pickImage(r.url, r.alt || imageQuery)}
                  className="group relative overflow-hidden rounded border border-[var(--color-border)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.thumb} alt={r.alt || ''} className="h-16 w-full object-cover transition-transform group-hover:scale-105" />
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[8px] text-white">
                    {r.credit}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: 'rgba(0,214,43,0.12)', color: '#00D62B' }}>
        {icon}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      {sub && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      <div className="border-b border-[var(--color-border)] px-5 py-3">
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <span className="font-[family-name:var(--font-mono)] text-sm">{value}</span>
    </div>
  )
}

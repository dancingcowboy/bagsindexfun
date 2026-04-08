'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Coins, Lock, TrendingUp } from 'lucide-react'
import { LogoFull } from '@/components/Logo'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

interface ProjectVault {
  sourceTokenMint: string
  sourceSymbol: string
  sourceName: string
  sourceImageUrl: string | null
  vaultAddress: string
  feeShareBps: number
  feeSharePct: string
  riskTier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
  twitter: string | null
  website: string | null
  totalSolReceived: string
  currentValueSol: string
  unlocksAt: string
  createdAt: string
  lastFundedAt: string | null
}

const TIER_COLOR: Record<ProjectVault['riskTier'], string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff8c00',
}

export default function ProjectsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/projects`)
      if (!res.ok) throw new Error('Failed to fetch projects')
      return (await res.json()) as { data: ProjectVault[] }
    },
    refetchInterval: 60_000,
  })

  const projects = data?.data ?? []
  const totalSolRouted = projects.reduce((s, p) => s + Number(p.totalSolReceived), 0)
  const totalValueSol = projects.reduce((s, p) => s + Number(p.currentValueSol), 0)

  return (
    <div className="min-h-screen">
      <nav className="fixed top-0 z-50 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <LogoFull />
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-6 pt-28 pb-24">
        {/* Header */}
        <div className="mb-12 max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-1 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-[var(--color-text-secondary)]">Bags App · Treasury Primitive</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Project{' '}
            <span style={{ color: '#00D62B' }}>Vaults</span>
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-[var(--color-text-secondary)]">
            Tokens on Bags can route a slice of their trading fees directly into a Bags Index vault.
            Fees flow on-chain via the native Bags fee-share primitive — no middleman, no manual
            routing. Works for new launches <em>and</em> existing tokens: your fee admin can update
            the claimers list at any time. Projects diversify their treasury into the whole
            ecosystem automatically, perpetually.
          </p>
        </div>

        {/* How it works */}
        <div className="mb-12 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: <Coins className="h-5 w-5" />,
              title: '1. Add to your fee-share',
              body: 'New launch? Include a Bags Index vault in your initial claimersArray. Already live? Your fee admin can call /fee-share/admin/update-config to add the vault at any time. 1–100 claimers, BPS sum to 10000.',
            },
            {
              icon: <TrendingUp className="h-5 w-5" />,
              title: '2. Fees auto-allocate',
              body: 'Every trade on your token routes the slice to the vault. The allocation worker auto-buys the current top-10 in your chosen tier: Conservative, Balanced, or Degen.',
            },
            {
              icon: <Lock className="h-5 w-5" />,
              title: '3. 30-day timelock',
              body: 'Withdrawals are timelocked for 30 days after registration — proves treasury commitment without locking funds forever. After unlock, your owner wallet can withdraw anytime.',
            },
          ].map((step) => (
            <div
              key={step.title}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5"
            >
              <div
                className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg"
                style={{ backgroundColor: 'rgba(0,214,43,0.12)', color: '#00D62B' }}
              >
                {step.icon}
              </div>
              <h3 className="mb-1.5 font-bold">{step.title}</h3>
              <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
                {step.body}
              </p>
            </div>
          ))}
        </div>

        {/* Aggregate stats */}
        <div className="mb-8 grid grid-cols-3 gap-3">
          {[
            { label: 'Participating Projects', value: projects.length.toString() },
            { label: 'Total SOL Routed', value: totalSolRouted.toFixed(2) },
            { label: 'Aggregate Vault Value', value: totalValueSol.toFixed(2) + ' SOL' },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5"
            >
              <div className="text-2xl font-bold" style={{ color: '#00D62B' }}>
                {s.value}
              </div>
              <div className="mt-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* Leaderboard */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          <div className="border-b border-[var(--color-border)] px-6 py-4">
            <h2 className="text-lg font-bold">Leaderboard</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Ranked by current vault value</p>
          </div>

          {isLoading ? (
            <div className="px-6 py-16 text-center text-sm text-[var(--color-text-muted)]">
              Loading projects…
            </div>
          ) : projects.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[var(--color-text-secondary)]">
                No projects registered yet.
              </p>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Be the first — route fees from your Bags token into the index.
              </p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  {['#', 'Project', 'Fee Share', 'Tier', 'SOL Routed', 'Vault Value'].map((h, i) => (
                    <th
                      key={h}
                      className={`px-6 py-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)] ${
                        i < 2 ? 'text-left' : 'text-right'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map((p, i) => (
                  <tr
                    key={p.sourceTokenMint}
                    className="border-b border-[var(--color-border-subtle)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <td className="px-6 py-4 font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                      {i + 1}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {p.sourceImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.sourceImageUrl}
                            alt={p.sourceSymbol}
                            className="h-8 w-8 rounded-full border border-[var(--color-border)]"
                          />
                        ) : (
                          <div
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] font-bold"
                            style={{ color: '#00D62B' }}
                          >
                            {p.sourceSymbol.slice(0, 3)}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold">{p.sourceSymbol}</div>
                          <div className="truncate text-xs text-[var(--color-text-muted)]">
                            {p.sourceName}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-[family-name:var(--font-mono)] text-sm">
                      {p.feeSharePct}%
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span
                        className="rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider"
                        style={{
                          color: TIER_COLOR[p.riskTier],
                          backgroundColor: `${TIER_COLOR[p.riskTier]}15`,
                        }}
                      >
                        {p.riskTier}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-[family-name:var(--font-mono)] text-sm">
                      {Number(p.totalSolReceived).toFixed(3)}
                    </td>
                    <td
                      className="px-6 py-4 text-right font-[family-name:var(--font-mono)] text-sm font-bold"
                      style={{ color: '#00D62B' }}
                    >
                      {Number(p.currentValueSol).toFixed(3)} SOL
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* CTA */}
        <div className="mt-12 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-8 text-center">
          <h3 className="mb-2 text-xl font-bold">Launching a token on Bags?</h3>
          <p className="mx-auto mb-6 max-w-xl text-sm text-[var(--color-text-secondary)]">
            Route a slice of your fees into a diversified Bags Index vault. Public leaderboard
            credit, real treasury diversification, zero ongoing work. Set it once at launch and
            fees flow forever.
          </p>
          <a
            href="mailto:projects@bagsindex.fun"
            className="btn-primary inline-flex items-center gap-2 px-6 py-3 text-sm"
          >
            Get in Touch
          </a>
        </div>
      </main>
    </div>
  )
}

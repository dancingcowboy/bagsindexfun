'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  Shield,
  Shuffle,
  Flame,
  TrendingUp,
  BarChart3,
  Users,
  Lock,
  Zap,
  AlertTriangle,
} from 'lucide-react'
import { api, API_BASE } from '@/lib/api'
import { LogoFull } from '@/components/Logo'
import { TokenPriceChart } from '@/components/TokenPriceChart'
import { NextCycleCountdown } from '@/components/NextCycleCountdown'
import { AgentAnalysis } from '@/components/AgentAnalysis'
import { TierProvider } from '@/lib/TierContext'

import { usePrivy } from '@privy-io/react-auth'

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: [0.25, 0.4, 0.25, 1] },
  }),
}

export default function LandingPage() {
  const { login, authenticated, ready } = usePrivy()
  const router = useRouter()

  const handleCTA = () => {
    if (authenticated) {
      router.push('/dashboard')
      return
    }
    if (!ready) {
      // Privy SDK still initializing — try again in a moment
      setTimeout(() => login(), 250)
      return
    }
    login()
  }

  return (
    <TierProvider>
    <div className="min-h-screen">
      {/* ─── Nav ──────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 z-50 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <LogoFull />
          <div className="flex items-center gap-4">
            <a href="#how-it-works" className="btn-ghost text-sm hidden sm:block">
              How It Works
            </a>
            <a href="#chart" className="btn-ghost text-sm hidden sm:block">
              Performance
            </a>
            <a href="#analysis" className="btn-ghost text-sm hidden sm:block">
              AI Agent
            </a>
            <a href="/projects" className="btn-ghost text-sm hidden sm:block">
              For Projects
            </a>
            <button onClick={handleCTA} className="btn-primary text-sm">
              {authenticated ? 'Dashboard' : 'Launch App'}
            </button>
          </div>
        </div>
      </nav>

      {/* ─── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative flex min-h-[100vh] items-center justify-center overflow-hidden px-6 pt-16">
        {/* Radial glow */}
        <div
          className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: '800px',
            height: '800px',
            background: 'radial-gradient(circle, rgba(0,214,43,0.06) 0%, transparent 70%)',
          }}
        />

        <motion.div
          initial="hidden"
          animate="visible"
          className="relative z-10 mx-auto max-w-5xl text-center"
        >
          <motion.h1
            variants={fadeUp}
            custom={1}
            className="text-5xl font-bold leading-[1.1] tracking-tight sm:text-7xl"
          >
            The Index Fund
            <br />
            for{' '}
            <span
              className="relative"
              style={{
                color: '#00D62B',
                textShadow: '0 0 40px rgba(0,214,43,0.3)',
              }}
            >
              Bags
            </span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            custom={2}
            className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-[var(--color-text-secondary)]"
          >
            Deposit SOL. Auto-allocate across the top 10 performing tokens on
            Bags — scored daily by volume, holder growth, and liquidity. Every
            vault holds 10% $BAGSX.
          </motion.p>

          <motion.div
            variants={fadeUp}
            custom={3}
            className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <button
              onClick={handleCTA}
              className="btn-primary flex items-center gap-2 text-base px-8 py-4"
            >
              {authenticated ? 'Go to Dashboard' : 'Start Investing'}
              <ArrowRight className="h-4 w-4" />
            </button>
            <a href="#chart" className="btn-outline text-base px-8 py-4">
              View Performance
            </a>
          </motion.div>

          {/* Stats row */}
          <motion.div
            variants={fadeUp}
            custom={4}
            className="mt-20 grid grid-cols-2 sm:grid-cols-4 gap-6"
          >
            {[
              {
                label: '3 Risk Tiers',
                value: 'C / B / D',
                sub: 'Conservative, Balanced, Degen — pick your appetite',
              },
              {
                label: 'Top 10 by Tier',
                value: '10 Tokens',
                sub: 'AI-vetted Bags tokens, 25% max weight per token',
              },
              {
                label: 'Auto Rebalance',
                value: '4–24h',
                sub: 'Degen every 4h · Balanced 12h · Conservative 24h',
              },
              {
                label: 'Privy-Secured',
                value: 'HSM Signing',
                sub: 'Per-tier sub-wallets, withdraw anytime',
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-5 text-left"
              >
                <div className="text-2xl font-bold" style={{ color: '#00D62B' }}>
                  {stat.value}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  {stat.label}
                </div>
                <div className="mt-2 text-xs leading-snug text-[var(--color-text-secondary)]">
                  {stat.sub}
                </div>
              </div>
            ))}
          </motion.div>
        </motion.div>
      </section>

      {/* ─── Chart Section ────────────────────────────────────────────── */}
      <section id="chart" className="mx-auto max-w-7xl px-6 py-24">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold">
              10 Tokens.{' '}
              <span style={{ color: '#00D62B' }}>One Index.</span>
            </h2>
            <p className="mt-3 text-[var(--color-text-secondary)] max-w-xl mx-auto">
              Pick a risk tier — each runs the same scoring
              engine but with different weights, floors, and rebalance frequencies. The white line
              is the Bags Index for that tier. Diversification in action.
            </p>
          </div>
          <TokenPriceChart
            tierSelectable
            title="Live Tier Performance"
            subtitle="Top-10 token prices + weighted index line · switch tiers to compare"
          />

          <div className="mt-16">
            <NextCycleCountdown />
          </div>
        </motion.div>
      </section>

      {/* ─── AI Agent Analysis ─────────────────────────────────────────── */}
      <section id="analysis" className="mx-auto max-w-7xl px-6 py-24">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold">
              AI-Powered{' '}
              <span style={{ color: '#00D62B' }}>Analysis</span>
            </h2>
            <p className="mt-3 text-[var(--color-text-secondary)] max-w-xl mx-auto">
              Every day, our AI agent analyzes the entire Bags ecosystem — volume trends,
              holder growth, liquidity depth — and publishes its full reasoning transparently.
            </p>
          </div>
          <AgentAnalysis />
        </motion.div>
      </section>

      {/* ─── How It Works ─────────────────────────────────────────────── */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">How It Works</h2>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {[
            {
              step: '01',
              icon: <Zap className="h-5 w-5" />,
              title: 'Pick a Tier & Deposit',
              desc: 'Choose Conservative, Balanced, or Degen. Deposit SOL — 100% enters your vault, 10% of which is $BAGSX exposure.',
            },
            {
              step: '02',
              icon: <BarChart3 className="h-5 w-5" />,
              title: 'AI Allocates',
              desc: 'Our AI agent picks 10 tokens per tier, weighted by volume, holder growth, and liquidity. Each tier has a distinct risk profile.',
            },
            {
              step: '03',
              icon: <Shuffle className="h-5 w-5" />,
              title: 'Daily Rebalance',
              desc: 'The agent re-analyzes daily. Your portfolio rebalances in randomized order via Fisher-Yates shuffle. Provably fair.',
            },
          ].map((item, i) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
              className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-6 overflow-hidden"
            >
              <div className="absolute -right-3 -top-3 text-[72px] font-bold leading-none" style={{ color: 'rgba(0,214,43,0.05)' }}>
                {item.step}
              </div>
              <div
                className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl"
                style={{ backgroundColor: 'rgba(0,214,43,0.12)', color: '#00D62B' }}
              >
                {item.icon}
              </div>
              <h3 className="text-lg font-bold mb-2">{item.title}</h3>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {item.desc}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ─── For Projects (Bags App teaser) ────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 py-24">
        <div className="relative overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-10 sm:p-14">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 85% 20%, rgba(0,214,43,0.10), transparent 55%)',
            }}
          />
          <div className="relative grid gap-10 md:grid-cols-[1.3fr_1fr] items-center">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1 text-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-[var(--color-text-secondary)]">Bags App · Treasury Primitive</span>
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold leading-tight">
                Route your fees into the{' '}
                <span style={{ color: '#00D62B' }}>Index</span>
              </h2>
              <p className="mt-4 text-[var(--color-text-secondary)] leading-relaxed">
                Launching <em>or already live</em> on Bags? In the Bags{' '}
                <strong>Fee Share</strong> step, paste a Bags Index vault address as a
                claimer alongside your treasury and give it a small BPS slice. That's it
                — no contracts, no code. Existing tokens can do the same any time from
                the Bags fee admin dashboard. Trading fees flow on-chain into a
                diversified ecosystem vault — automatic treasury diversification, public
                leaderboard credit, zero ongoing work.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <a href="/projects" className="btn-primary text-sm px-6 py-3">
                  See Participating Projects
                </a>
                <a
                  href="https://docs.bags.fm/api-reference/create-fee-share-configuration"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-outline text-sm px-6 py-3"
                >
                  Bags Fee-Share Docs
                </a>
              </div>
            </div>

            {/* UI mock — what the Fee Share step looks like on bags.fm */}
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-5 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  bags.fm · Fee Share
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">Step 3 of 4</div>
              </div>

              <div className="mb-2 grid grid-cols-[1fr_auto] gap-2 px-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <div>Wallet</div>
                <div>Share</div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-6 w-6 rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold">Your Treasury</div>
                      <div className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                        7xKp...m4Qa
                      </div>
                    </div>
                  </div>
                  <div className="font-[family-name:var(--font-mono)] text-sm font-bold">95%</div>
                </div>

                <div
                  className="flex items-center justify-between rounded-lg border px-3 py-2.5"
                  style={{
                    borderColor: 'rgba(0,214,43,0.4)',
                    backgroundColor: 'rgba(0,214,43,0.06)',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                      style={{ backgroundColor: 'rgba(0,214,43,0.2)', color: '#00D62B' }}
                    >
                      IDX
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold" style={{ color: '#00D62B' }}>
                        Bags Index Vault
                      </div>
                      <div className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                        bagsIdx...vault
                      </div>
                    </div>
                  </div>
                  <div
                    className="font-[family-name:var(--font-mono)] text-sm font-bold"
                    style={{ color: '#00D62B' }}
                  >
                    5%
                  </div>
                </div>

                <button
                  type="button"
                  className="w-full rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]"
                >
                  + Add claimer
                </button>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-[10px]">
                <span className="text-[var(--color-text-muted)]">Total</span>
                <span className="font-[family-name:var(--font-mono)] font-bold text-[var(--color-text-primary)]">
                  10000 / 10000 BPS
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Fairness & Security ──────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 py-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold">Fairness & Security</h2>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          {[
            {
              icon: <Shuffle className="h-5 w-5" />,
              title: 'Fisher-Yates Fair Ordering',
              desc: 'Rebalance execution is randomized with a seeded shuffle. Historical weighting ensures no wallet is systematically disadvantaged. Every seed is logged.',
            },
            {
              icon: <Shield className="h-5 w-5" />,
              title: 'Privy-Secured Sub-Wallets',
              desc: 'Funds stay in your personal sub-wallet — never pooled with other users. HSM-backed signing via Privy Server Wallets. No private keys in our database. Withdraw anytime. A fully trust-minimized PDA escrow program is on the roadmap.',
            },
            {
              icon: <AlertTriangle className="h-5 w-5" />,
              title: 'Rug Protection',
              desc: 'Tokens losing >20% holders in 4 hours are auto-ejected. Minimum $50K liquidity. Manual blacklist for confirmed rugs.',
            },
            {
              icon: <Lock className="h-5 w-5" />,
              title: 'Full Transparency',
              desc: 'Every swap signature stored and visible on your dashboard. Execution order history is public. Scoring formula is open.',
            },
          ].map((item, i) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-6"
            >
              <div
                className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl"
                style={{ backgroundColor: 'rgba(0,214,43,0.12)', color: '#00D62B' }}
              >
                {item.icon}
              </div>
              <h3 className="font-bold mb-1.5">{item.title}</h3>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {item.desc}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ─── $BAGSX Exposure ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 py-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold">
            $BAGSX{' '}
            <span style={{ color: '#00D62B' }}>Exposure</span>
          </h2>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-md mx-auto">
            Every vault holds a fixed 10% slice of the platform token. No fees.
          </p>
        </div>

        <div className="mx-auto max-w-xl">
          {[
            { icon: <Users className="h-5 w-5" />, text: 'Users deposit SOL', color: '#00D62B' },
            { icon: <Flame className="h-5 w-5" />, text: 'Every vault holds 10% $BAGSX', color: '#ff4444' },
            { icon: <TrendingUp className="h-5 w-5" />, text: 'TVL grows → protocol accumulates more $BAGSX', color: '#00D62B' },
            { icon: <Zap className="h-5 w-5" />, text: 'No fees — 100% of every flow goes to users', color: '#ffd000' },
          ].map((step, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
              className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 mb-3"
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${step.color}18`, color: step.color }}
              >
                {step.icon}
              </div>
              <span className="font-medium text-sm">{step.text}</span>
              {i < 3 && (
                <ArrowRight className="ml-auto h-4 w-4 text-[var(--color-text-muted)]" />
              )}
            </motion.div>
          ))}
          <p className="text-center text-xs text-[var(--color-text-muted)] mt-4">
            Every user vault and the protocol vault alike hold 10% $BAGSX
          </p>
        </div>
      </section>

      {/* ─── Token Utility: Vault Auto-Claim ──────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 py-24">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold">
            $BAGSX <span style={{ color: '#00D62B' }}>Utility</span>
          </h2>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl mx-auto">
            Every $BAGSX trade earns fees on Bags. The protocol vault wallet
            collects its share, a worker <strong>auto-claims every 4 hours</strong>,
            and the SOL is deposited into the index vaults. The protocol vault
            holds 10% $BAGSX just like every user vault.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3 mb-8">
          {[
            {
              step: '1',
              title: 'Fees accrue',
              desc: 'Bags splits $BAGSX trading fees: 80% to the team treasury, 20% to the protocol vault wallet.',
            },
            {
              step: '2',
              title: 'Auto-claim every 4h',
              desc: 'A worker polls Bags, claims the vault\u2019s accrued SOL, and deposits it into the index vaults (a small SOL buffer stays behind to fund future claim txs).',
            },
            {
              step: '3',
              title: '10% $BAGSX slice',
              desc: 'Every vault — user and protocol — holds a fixed 10% exposure to $BAGSX. No fees.',
            },
          ].map((s) => (
            <div
              key={s.step}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5"
            >
              <div
                className="text-xs font-bold mb-2"
                style={{ color: '#00D62B' }}
              >
                STEP {s.step}
              </div>
              <div className="font-semibold mb-2">{s.title}</div>
              <div className="text-sm text-[var(--color-text-secondary)]">
                {s.desc}
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-[var(--color-text-muted)]">
          As TVL grows, the protocol accumulates more $BAGSX on every deposit and rebalance.
        </p>
      </section>

      {/* ─── Protocol Vault ──────────────────────────────────────────── */}
      <ProtocolVaultSection />

      {/* ─── Built With ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 py-24 text-center">
        <h2 className="text-3xl font-bold mb-4">Powered By</h2>
        <p className="text-[var(--color-text-secondary)] mb-10 text-sm">
          Best-in-class Solana infrastructure
        </p>
        <div className="flex flex-wrap items-center justify-center gap-6">
          {[
            {
              name: 'Bags',
              href: 'https://bags.fm',
              logo: (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/bags.png" alt="Bags" className="h-6 w-auto" />
              ),
            },
            {
              name: 'Solana',
              href: 'https://solana.com',
              logo: (
                <svg viewBox="0 0 397.7 311.7" className="h-5 w-auto">
                  <defs>
                    <linearGradient id="sol-a" x1="360.879" y1="351.455" x2="141.213" y2="-69.294" gradientUnits="userSpaceOnUse">
                      <stop offset="0" stopColor="#00FFA3" />
                      <stop offset="1" stopColor="#DC1FFF" />
                    </linearGradient>
                    <linearGradient id="sol-b" x1="264.829" y1="401.601" x2="45.163" y2="-19.147" gradientUnits="userSpaceOnUse">
                      <stop offset="0" stopColor="#00FFA3" />
                      <stop offset="1" stopColor="#DC1FFF" />
                    </linearGradient>
                    <linearGradient id="sol-c" x1="312.548" y1="376.688" x2="92.882" y2="-44.061" gradientUnits="userSpaceOnUse">
                      <stop offset="0" stopColor="#00FFA3" />
                      <stop offset="1" stopColor="#DC1FFF" />
                    </linearGradient>
                  </defs>
                  <path fill="url(#sol-a)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
                  <path fill="url(#sol-b)" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
                  <path fill="url(#sol-c)" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z" />
                </svg>
              ),
            },
            {
              name: 'Privy',
              href: 'https://privy.io',
              logo: (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/privy.svg" alt="Privy" className="h-5 w-auto" />
              ),
            },
            {
              name: 'Helius',
              href: 'https://helius.dev',
              logo: (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/helius.svg" alt="Helius" className="h-5 w-auto" />
              ),
            },
          ].map((b) => (
            <a
              key={b.name}
              href={b.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-card)] px-6 py-3 transition-colors hover:border-[var(--color-accent)]"
            >
              {b.logo}
            </a>
          ))}
        </div>
      </section>

      {/* ─── CTA ──────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 py-24 text-center">
        <div className="relative mx-auto max-w-2xl overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-12">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: 'radial-gradient(circle at 50% 0%, rgba(0,214,43,0.08), transparent 60%)',
            }}
          />
          <h2 className="relative text-3xl font-bold mb-3">
            Ready to index the best of{' '}
            <span style={{ color: '#00D62B' }}>Bags</span>?
          </h2>
          <p className="relative text-[var(--color-text-secondary)] mb-8">
            Connect your wallet. Deposit SOL. Let the index do the work.
          </p>
          <button onClick={handleCTA} className="relative btn-primary text-base px-10 py-4">
            {authenticated ? 'Go to Dashboard' : 'Launch App'}
          </button>
        </div>
      </section>

      {/* ─── Footer ───────────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--color-border-subtle)] py-8">
        <div className="mx-auto max-w-7xl px-6 flex items-center justify-between">
          <LogoFull />
          <div className="flex items-center gap-5">
            <a
              href="https://x.com/BagsIndexSol"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              aria-label="Twitter"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://t.me/Bagsindex"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              aria-label="Telegram"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
            </a>
            <a
              href="https://github.com/dancingcowboy/bagsindexfun"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              aria-label="GitHub"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </a>
            <span className="text-xs text-[var(--color-text-muted)]">
              Auto-rebalancing index vault on Solana
            </span>
          </div>
        </div>
      </footer>
    </div>
    </TierProvider>
  )
}

/* ─── Protocol Vault Card ─────────────────────────────────────────────────── */

function VaultCopyCAButton({ mint }: { mint: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(() => {
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

function formatMC(mc: number) {
  if (mc <= 0) return '—'
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`
  return `$${mc.toFixed(0)}`
}

function ProtocolVaultSection() {
  const vault = useQuery<any>({
    queryKey: ['protocol-vault'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/index/vault`)
      const json = await res.json()
      if (!json.success || !json.data) return null
      return json.data
    },
    staleTime: 60_000,
  })

  const data = vault.data
  if (!data) return null

  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-3xl font-bold text-center mb-3">Protocol Vault</h2>
        <p className="text-center text-[var(--color-text-secondary)] mb-10 text-sm max-w-xl mx-auto">
          Platform fees are auto-deposited into the Balanced index. This vault eats its own cooking.
        </p>

        <div className="mx-auto max-w-4xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] overflow-hidden">
          {/* Header stats */}
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Vault Value
              </div>
              <div className="text-2xl font-bold font-[family-name:var(--font-mono)]">
                {Number(data.totalValueSol).toFixed(4)}{' '}
                <span className="text-sm text-[var(--color-text-muted)]">SOL</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Fees Claimed
              </div>
              <div className="font-[family-name:var(--font-mono)] text-lg font-semibold">
                {Number(data.totalClaimedSol).toFixed(4)}{' '}
                <span className="text-sm text-[var(--color-text-muted)]">SOL</span>
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {data.claimCount} deposit{data.claimCount !== 1 ? 's' : ''}
              </div>
            </div>
          </div>

          {/* Holdings table — mirrors dashboard */}
          {data.holdings.length > 0 && (<>
            {/* Mobile card layout */}
            <div className="md:hidden divide-y divide-[var(--color-border)]">
              {data.holdings.map((h: any) => (
                <div key={`${h.tokenMint}:m`} className="px-4 py-3 space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{h.tokenSymbol}</span>
                        <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                          {formatMC(h.marketCapUsd)}
                        </span>
                      </div>
                      <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                        {h.tokenMint.slice(0, 6)}…{h.tokenMint.slice(-4)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-[family-name:var(--font-mono)] text-sm">
                        {Number(h.valueSolEst).toFixed(4)} SOL
                      </div>
                      <span className="font-[family-name:var(--font-mono)] text-xs" style={{ color: '#00D62B' }}>
                        {h.weightPct}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/30">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${h.weightPct}%`, background: '#00D62B' }}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <a
                        href={`https://dexscreener.com/solana/${h.tokenMint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors"
                      >
                        dex
                      </a>
                      <VaultCopyCAButton mint={h.tokenMint} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop table layout */}
            <table className="hidden md:table w-full">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th className="px-5 py-2 text-left font-medium">Token</th>
                  <th className="px-5 py-2 text-right font-medium">MC</th>
                  <th className="px-5 py-2 text-center font-medium">Links</th>
                  <th className="px-5 py-2 text-right font-medium">Amount</th>
                  <th className="px-5 py-2 text-right font-medium">Value (SOL)</th>
                  <th className="px-5 py-2 text-right font-medium">Allocation</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h: any) => (
                  <tr
                    key={h.tokenMint}
                    className="border-t border-[var(--color-border)] hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3 text-sm">
                      <div className="font-semibold">{h.tokenSymbol}</div>
                      <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                        {h.tokenMint.slice(0, 6)}…{h.tokenMint.slice(-4)}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                      {formatMC(h.marketCapUsd)}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <a
                          href={`https://dexscreener.com/solana/${h.tokenMint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors"
                        >
                          dex
                        </a>
                        <VaultCopyCAButton mint={h.tokenMint} />
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                      {Number(h.amount).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                      {Number(h.valueSolEst).toFixed(4)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-black/30">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${h.weightPct}%`,
                              background: '#00D62B',
                            }}
                          />
                        </div>
                        <span className="font-[family-name:var(--font-mono)] text-sm" style={{ color: '#00D62B' }}>
                          {h.weightPct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>)}

          {data.holdings.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-[var(--color-text-muted)]">
              No holdings yet — vault will populate after first fee claim.
            </div>
          )}
        </div>
      </motion.div>
    </section>
  )
}

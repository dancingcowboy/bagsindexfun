'use client'

import { useQuery } from '@tanstack/react-query'
import { usePrivy } from '@privy-io/react-auth'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  PieChart,
  History,
  RefreshCw,
  Shuffle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { LogoFull } from '@/components/Logo'
import { PnlHistoryChart } from '@/components/PnlHistoryChart'
import { TokenPriceChart } from '@/components/TokenPriceChart'
import { MoneyWeightedPnlChart } from '@/components/MoneyWeightedPnlChart'
import { SwitchIndexModal } from '@/components/SwitchIndexModal'
import { NextCycleCountdown } from '@/components/NextCycleCountdown'

export default function DashboardPage() {
  const { authenticated, ready, logout, user } = usePrivy()
  const router = useRouter()
  const [showDeposit, setShowDeposit] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [showSwitch, setShowSwitch] = useState(false)
  const [portfolioLive, setPortfolioLive] = useState(false)

  useEffect(() => {
    if (ready && !authenticated) router.push('/')
  }, [ready, authenticated, router])

  const { data: portfolio, refetch: refetchPortfolio, isFetching: portfolioFetching } = useQuery({
    queryKey: ['portfolio', portfolioLive],
    queryFn: () => api.getPortfolio(portfolioLive),
    enabled: authenticated,
    refetchInterval: 30_000,
  })

  const { data: deposits } = useQuery({
    queryKey: ['deposits'],
    queryFn: () => api.getDeposits(),
    enabled: authenticated,
  })

  const { data: withdrawals } = useQuery({
    queryKey: ['withdrawals'],
    queryFn: () => api.getWithdrawals(),
    enabled: authenticated,
  })

  const { data: indexData } = useQuery({
    queryKey: ['index-current'],
    queryFn: () => api.getIndexCurrent(),
    refetchInterval: 60_000,
  })

  const { data: pnlData } = useQuery({
    queryKey: ['pnl'],
    queryFn: () => api.getPnl(),
    enabled: authenticated,
    refetchInterval: 30_000,
  })


  const holdings = portfolio?.data?.holdings ?? []
  const totalValueSol = portfolio?.data?.totalValueSol ?? '0'
  const tokens = indexData?.data?.tokens ?? []

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount)
    if (!amount || amount <= 0) return
    try {
      const res = await api.createDeposit(amount)
      // TODO: Privy wallet sign SOL transfer to sub-wallet address
      // Then confirm: api.confirmDeposit(res.data.id, txSignature)
      alert(`Deposit created. Send ${amount} SOL to: ${res.data.subWalletAddress}`)
      setShowDeposit(false)
      setDepositAmount('')
    } catch (err: any) {
      alert(err.message)
    }
  }

  const handleWithdraw = async () => {
    if (withdrawing) return
    setWithdrawing(true)
    try {
      const res = await api.createWithdrawal()
      alert(`Withdrawal initiated. Estimated: ${res.data.netSol} SOL after fees.`)
      refetchPortfolio()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setWithdrawing(false)
    }
  }

  if (!ready || !authenticated) return null

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="sticky top-0 z-50 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <a href="/"><LogoFull /></a>
          <div className="flex items-center gap-4">
            <a href="/" className="btn-ghost text-sm hidden sm:block">Home</a>
            <span className="text-sm text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] hidden sm:inline">
              {user?.wallet?.address?.slice(0, 4)}…{user?.wallet?.address?.slice(-4)}
            </span>
            <button onClick={logout} className="btn-primary text-sm">
              Disconnect
            </button>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Portfolio Summary */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-6">
            <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold">
              Portfolio
            </h1>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeposit(true)}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                <ArrowDownToLine className="h-4 w-4" /> Deposit
              </button>
              <button
                onClick={() => setShowSwitch(true)}
                disabled={(pnlData?.data?.tiers ?? []).every((t: any) => parseFloat(t.currentValueSol ?? '0') <= 0)}
                className="btn-outline flex items-center gap-2 text-sm disabled:opacity-40"
                title="Move your position between indexes (1% flat fee)"
              >
                <Shuffle className="h-4 w-4" /> Switch Index
              </button>
              <button
                onClick={handleWithdraw}
                disabled={withdrawing || holdings.length === 0}
                className="btn-outline flex items-center gap-2 text-sm disabled:opacity-40"
              >
                <ArrowUpFromLine className="h-4 w-4" /> Withdraw All
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="card">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] mb-1">
                <Wallet className="h-4 w-4" /> Total Value
              </div>
              <div className="font-[family-name:var(--font-display)] text-2xl font-bold">
                {Number(totalValueSol).toFixed(4)} SOL
              </div>
            </div>
            <div className="card">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] mb-1">
                <PieChart className="h-4 w-4" /> Holdings
              </div>
              <div className="font-[family-name:var(--font-display)] text-2xl font-bold">
                {holdings.length}
              </div>
            </div>
            <div className="card">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] mb-1">
                <History className="h-4 w-4" /> Deposits
              </div>
              <div className="font-[family-name:var(--font-display)] text-2xl font-bold">
                {deposits?.data?.length ?? 0}
              </div>
            </div>
          </div>
        </motion.div>

        {/* Vault value + performance — side by side */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-8 grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          <PnlHistoryChart
            title="Vault Value"
            subtitle="SOL held per tier · hourly snapshots"
          />
          <MoneyWeightedPnlChart
            title="Your PnL"
            subtitle="Vault value minus net deposits · real SOL profit/loss per tier"
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="mb-8"
        >
          <TokenPriceChart tierSelectable title="Compare Indexes" subtitle="Top-10 token prices + weighted index line · switch tiers to compare" />
        </motion.div>

        {/* Pool PnL */}
        {pnlData?.data?.tiers && pnlData.data.tiers.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-8"
          >
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold mb-4">
              Pool PnL
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {pnlData.data.tiers.map((t: any) => {
                const pnl = Number(t.totalPnlSol)
                const pct = Number(t.pnlPct)
                const positive = pnl >= 0
                return (
                  <div key={t.riskTier} className="card">
                    <div className="text-sm text-[var(--color-text-muted)] mb-1">{t.riskTier}</div>
                    <div className={`font-[family-name:var(--font-display)] text-2xl font-bold ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                      {positive ? '+' : ''}{pnl.toFixed(4)} SOL
                    </div>
                    <div className={`text-sm ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                      {positive ? '+' : ''}{pct.toFixed(2)}%
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--color-text-muted)]">
                      <div>
                        <div>Value</div>
                        <div className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.currentValueSol).toFixed(4)}</div>
                      </div>
                      <div>
                        <div>Cost</div>
                        <div className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.costBasisSol).toFixed(4)}</div>
                      </div>
                      <div>
                        <div>Realized</div>
                        <div className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.realizedSol).toFixed(4)}</div>
                      </div>
                      <div>
                        <div>Unrealized</div>
                        <div className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">{Number(t.unrealizedSol).toFixed(4)}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}

        {/* Deposit Modal */}
        <SwitchIndexModal
          open={showSwitch}
          onClose={() => setShowSwitch(false)}
          tiers={(pnlData?.data?.tiers ?? []).map((t: any) => ({
            riskTier: t.riskTier,
            totalValueSol: t.currentValueSol ?? '0',
          }))}
          onSwitched={() => refetchPortfolio()}
        />

        {showDeposit && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="card w-full max-w-md"
            >
              <h2 className="font-[family-name:var(--font-display)] text-xl font-bold mb-4">
                Deposit SOL
              </h2>
              <div className="mb-4">
                <label className="block text-sm text-[var(--color-text-muted)] mb-2">
                  Amount (SOL)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 font-[family-name:var(--font-mono)] text-lg outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              {depositAmount && parseFloat(depositAmount) > 0 && (
                <div className="mb-4 rounded-lg bg-[var(--color-bg-secondary)] p-4 text-sm">
                  <div className="flex justify-between mb-1">
                    <span className="text-[var(--color-text-muted)]">Fee (3%)</span>
                    <span>{(parseFloat(depositAmount) * 0.03).toFixed(4)} SOL</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span className="text-[var(--color-text-muted)]">Net deposit</span>
                    <span className="text-[var(--color-green)]">
                      {(parseFloat(depositAmount) * 0.97).toFixed(4)} SOL
                    </span>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={handleDeposit} className="btn-primary flex-1">
                  Deposit
                </button>
                <button
                  onClick={() => {
                    setShowDeposit(false)
                    setDepositAmount('')
                  }}
                  className="btn-outline flex-1"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Holdings Table */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
              Holdings
            </h2>
            <button
              onClick={() => {
                setPortfolioLive(true)
                setTimeout(() => refetchPortfolio(), 0)
              }}
              disabled={portfolioFetching}
              className="flex items-center gap-2 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold uppercase hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${portfolioFetching ? 'animate-spin' : ''}`} />
              {portfolioFetching ? 'Refreshing…' : portfolioLive ? 'Refresh (live)' : 'Refresh Holdings'}
            </button>
          </div>
          <div className="card overflow-hidden p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Token
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Value (SOL)
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Allocation
                  </th>
                </tr>
              </thead>
              <tbody>
                {holdings.length > 0 ? (
                  holdings.map((h: any) => (
                    <tr
                      key={h.tokenMint}
                      className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-hover)]"
                    >
                      <td className="px-6 py-4 font-[family-name:var(--font-mono)] text-sm">
                        {h.tokenMint.slice(0, 8)}...
                      </td>
                      <td className="px-6 py-4 text-right font-[family-name:var(--font-mono)] text-sm">
                        {Number(h.amount).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-right font-[family-name:var(--font-mono)] text-sm">
                        {Number(h.valueSol).toFixed(4)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-2 w-16 rounded-full bg-[var(--color-bg-secondary)] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[var(--color-accent)]"
                              style={{ width: `${h.allocationPct}%` }}
                            />
                          </div>
                          <span className="font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                            {h.allocationPct}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-6 py-12 text-center text-[var(--color-text-muted)]"
                    >
                      No holdings yet — deposit SOL to start investing
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>

        {/* Next cycle countdown per tier */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mb-8"
        >
          <NextCycleCountdown compact />
        </motion.div>

        {/* Current Index */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center gap-2 mb-4">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
              Current Index
            </h2>
            <RefreshCw className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>
          <div className="card overflow-hidden p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    #
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Token
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Score
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Weight
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.length > 0 ? (
                  tokens.map((t: any) => (
                    <tr
                      key={t.tokenMint}
                      className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-hover)]"
                    >
                      <td className="px-6 py-3 font-[family-name:var(--font-mono)] text-sm">
                        {t.rank}
                      </td>
                      <td className="px-6 py-3 font-medium text-sm">
                        {t.tokenSymbol}
                      </td>
                      <td className="px-6 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                        {Number(t.compositeScore).toFixed(4)}
                      </td>
                      <td className="px-6 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-[var(--color-accent)]">
                        {t.weightPct}%
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-6 py-8 text-center text-[var(--color-text-muted)]"
                    >
                      Index initializing...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

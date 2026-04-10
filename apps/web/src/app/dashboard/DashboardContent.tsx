'use client'

import { useQuery } from '@tanstack/react-query'
import { usePrivy } from '@privy-io/react-auth'
import { useConnectedStandardWallets } from '@privy-io/react-auth/solana'
import { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import bs58 from 'bs58'
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
  Copy,
  Check,
} from 'lucide-react'

// Per-tier color tokens. Used to colour-code holdings by index and to
// theme the tier filter pills on the constituent table. Picked so they
// stay legible against the dark `--color-bg-primary` and don't collide
// with the green primary accent.
const TIER_COLORS: Record<string, { bg: string; border: string; text: string; chip: string }> = {
  CONSERVATIVE: {
    bg: 'rgba(56, 189, 248, 0.06)', // sky-400 wash
    border: 'rgba(56, 189, 248, 0.35)',
    text: '#7dd3fc',
    chip: '#0ea5e9',
  },
  BALANCED: {
    bg: 'rgba(168, 85, 247, 0.06)', // purple-500 wash
    border: 'rgba(168, 85, 247, 0.35)',
    text: '#c084fc',
    chip: '#a855f7',
  },
  DEGEN: {
    bg: 'rgba(244, 114, 182, 0.06)', // pink-400 wash
    border: 'rgba(244, 114, 182, 0.35)',
    text: '#f9a8d4',
    chip: '#ec4899',
  },
}
const TIER_LIST = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
import { api } from '@/lib/api'
import { LogoFull } from '@/components/Logo'
import { useCallback } from 'react'

function CopyCAButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
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
import { PnlHistoryChart } from '@/components/PnlHistoryChart'
import { TokenPriceChart } from '@/components/TokenPriceChart'
import { MoneyWeightedPnlChart } from '@/components/MoneyWeightedPnlChart'
import { SwitchIndexModal } from '@/components/SwitchIndexModal'
import { NextCycleCountdown } from '@/components/NextCycleCountdown'
import { Notice, type NoticeState } from '@/components/Notice'
import { AllocationProgressModal } from '@/components/AllocationProgressModal'
import { WithdrawalModal } from '@/components/WithdrawalModal'
import { API_BASE } from '@/lib/api'

const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || `${API_BASE}/solana/rpc`

export default function DashboardPage() {
  const { authenticated, ready, logout, user, connectWallet } = usePrivy()
  const { wallets: solanaWallets } = useConnectedStandardWallets()
  const router = useRouter()
  const [showDeposit, setShowDeposit] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositTier, setDepositTier] = useState<'CONSERVATIVE' | 'BALANCED' | 'DEGEN'>('BALANCED')
  const [depositing, setDepositing] = useState(false)
  const [depositStatus, setDepositStatus] = useState<string | null>(null)
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [showSwitch, setShowSwitch] = useState(false)
  // Default to live mode so totalValueSol includes the sub-wallet's native
  // SOL balance (unspent after liquidity-cap clamps) and uses current prices
  // instead of stale valueSolEst from DB.
  const [portfolioLive, setPortfolioLive] = useState(true)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [allocation, setAllocation] = useState<{
    depositId: string
    tier: string
    amountSol: number
  } | null>(null)
  // Filter for the "Current Index" constituent table at the bottom.
  // Lets users compare each tier's top-10 token weights side by side.
  const [indexTier, setIndexTier] = useState<'CONSERVATIVE' | 'BALANCED' | 'DEGEN'>('BALANCED')
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const copyAddr = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr)
      setCopiedAddr(addr)
      setTimeout(() => setCopiedAddr((cur) => (cur === addr ? null : cur)), 1500)
    } catch {}
  }

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
    queryKey: ['index-current', indexTier],
    queryFn: () => api.getIndexCurrent(indexTier),
    refetchInterval: 60_000,
  })

  const { data: pnlData } = useQuery({
    queryKey: ['pnl'],
    queryFn: () => api.getPnl(),
    enabled: authenticated,
    refetchInterval: 30_000,
  })


  // Portfolio API returns tiers[], each with its own holdings[]. Flatten
  // across tiers for the holdings table + "Holdings" count card.
  const portfolioTiers = (portfolio?.data as any)?.tiers ?? []
  const holdings = portfolioTiers.flatMap((t: any) =>
    (t.holdings ?? []).map((h: any) => ({ ...h, riskTier: t.riskTier })),
  )
  const totalValueSol = portfolio?.data?.totalValueSol ?? '0'
  const tokens = indexData?.data?.tokens ?? []

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount)
    if (!amount || amount <= 0) {
      setNotice({ kind: 'error', title: 'Invalid amount', message: 'Enter an amount greater than 0.' })
      return
    }
    const activeAddress = user?.wallet?.address
    const wallet =
      (activeAddress && solanaWallets.find((w) => w.address === activeAddress)) ||
      solanaWallets[0]
    if (!wallet) {
      // Privy keeps login-with-wallet and standard-wallet session separate.
      // Open the connect modal so the user can re-expose a Solana signer.
      try {
        connectWallet({ walletChainType: 'solana-only' as any })
      } catch {}
      setNotice({
        kind: 'info',
        title: 'Connect your Solana wallet',
        message:
          'Approve the wallet connection in the popup, then click Deposit again. This is a one-time reconnect so we can ask your wallet to sign the transfer.',
      })
      return
    }
    if (depositing) return
    setDepositing(true)
    setDepositStatus('Creating deposit intent…')
    try {
      const res = await api.createDeposit(amount, depositTier)
      const destination = res.data.subWalletAddress as string
      const depositId = res.data.id as string

      setDepositStatus('Building transaction…')
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
      const fromPubkey = new PublicKey(wallet.address)
      const toPubkey = new PublicKey(destination)
      const lamports = Math.round(amount * LAMPORTS_PER_SOL)

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight }).add(
        SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
      )
      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false })

      setDepositStatus('Waiting for wallet signature…')
      const { signature: sigBytes } = await wallet.signAndSendTransaction({
        transaction: new Uint8Array(serialized),
        chain: 'solana:mainnet',
      })
      const txSignature =
        typeof sigBytes === 'string'
          ? sigBytes
          : bs58.encode(sigBytes instanceof Uint8Array ? sigBytes : new Uint8Array(sigBytes as any))

      setDepositStatus('Confirming on-chain…')
      // HTTP-only confirmation: our RPC proxy has no websocket, so poll
      // getSignatureStatuses until the tx is confirmed or we time out.
      const deadline = Date.now() + 60_000
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value } = await connection.getSignatureStatuses([txSignature])
        const st = value[0]
        if (st?.err) throw new Error('Transaction failed on-chain')
        if (
          st?.confirmationStatus === 'confirmed' ||
          st?.confirmationStatus === 'finalized'
        ) break
        if (Date.now() > deadline) throw new Error('Timed out waiting for confirmation')
        await new Promise((r) => setTimeout(r, 1500))
      }

      setDepositStatus('Notifying backend…')
      await api.confirmDeposit(depositId, txSignature)

      setShowDeposit(false)
      setDepositAmount('')
      setDepositStatus(null)
      // Open the live allocation progress modal; it polls the worker and
      // refetches the portfolio once every swap has settled.
      setAllocation({ depositId, tier: depositTier, amountSol: amount })
    } catch (err: any) {
      setDepositStatus(null)
      setNotice({
        kind: 'error',
        title: 'Deposit failed',
        message: err?.message ?? 'Unknown error',
      })
    } finally {
      setDepositing(false)
    }
  }

  // Withdrawal is now handled by the WithdrawalModal component

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
                onClick={() => setShowWithdraw(true)}
                disabled={holdings.length === 0}
                className="btn-outline flex items-center gap-2 text-sm disabled:opacity-40"
              >
                <ArrowUpFromLine className="h-4 w-4" /> Withdraw
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
                  Index
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const).map((tier) => {
                    const active = depositTier === tier
                    return (
                      <button
                        key={tier}
                        type="button"
                        onClick={() => setDepositTier(tier)}
                        className="rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
                        style={
                          active
                            ? { background: '#00D62B', color: '#000', borderColor: '#00D62B' }
                            : { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }
                        }
                      >
                        {tier}
                      </button>
                    )
                  })}
                </div>
              </div>
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
              {depositStatus && (
                <div className="mb-3 rounded-md border border-[var(--color-border)] bg-black/20 px-3 py-2 text-xs text-[var(--color-text-muted)]">
                  {depositStatus}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={handleDeposit}
                  disabled={depositing}
                  className="btn-primary flex-1 disabled:opacity-50"
                >
                  {depositing ? 'Depositing…' : 'Deposit'}
                </button>
                <button
                  onClick={() => {
                    if (depositing) return
                    setShowDeposit(false)
                    setDepositAmount('')
                  }}
                  disabled={depositing}
                  className="btn-outline flex-1 disabled:opacity-50"
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
          {portfolioTiers.length === 0 || holdings.length === 0 ? (
            <div className="card p-12 text-center text-[var(--color-text-muted)]">
              No holdings yet — deposit SOL to start investing
            </div>
          ) : (
            <div className="space-y-4">
              {portfolioTiers
                .filter((t: any) => (t.holdings ?? []).length > 0)
                .map((t: any) => {
                  const c = TIER_COLORS[t.riskTier] ?? TIER_COLORS.BALANCED
                  const tierHoldings = t.holdings ?? []
                  const nativeSol = Number(t.nativeSol ?? 0)
                  const tierValue = Number(t.totalValueSol ?? 0)
                  const addr: string | undefined = t.walletAddress
                  return (
                    <div
                      key={t.riskTier}
                      className="overflow-hidden rounded-2xl border"
                      style={{ background: c.bg, borderColor: c.border }}
                    >
                      {/* Tier header strip with colour-coded label + sub-wallet CA */}
                      <div
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                        style={{ borderBottom: `1px solid ${c.border}` }}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
                            style={{ background: c.chip, color: '#0a0a0a' }}
                          >
                            {t.riskTier}
                          </span>
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {tierHoldings.length} holdings · {tierValue.toFixed(4)} SOL
                          </span>
                        </div>
                        {addr && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                              Sub-wallet
                            </span>
                            <a
                              href={`https://solscan.io/account/${addr}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-[family-name:var(--font-mono)] text-xs"
                              style={{ color: c.text }}
                              title="Open on Solscan"
                            >
                              {addr.slice(0, 6)}…{addr.slice(-6)}
                            </a>
                            <button
                              type="button"
                              onClick={() => copyAddr(addr)}
                              className="rounded p-1 hover:bg-white/5"
                              title="Copy full address — paste into Phantom or any wallet watcher"
                            >
                              {copiedAddr === addr ? (
                                <Check className="h-3 w-3" style={{ color: c.text }} />
                              ) : (
                                <Copy
                                  className="h-3 w-3 text-[var(--color-text-muted)]"
                                />
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      <table className="w-full">
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
                          {tierHoldings.map((h: any) => (
                            <tr
                              key={`${t.riskTier}:${h.tokenMint}`}
                              className="border-t hover:bg-white/[0.02]"
                              style={{ borderColor: c.border }}
                            >
                              <td className="px-5 py-3 text-sm">
                                <div className="font-semibold">{h.tokenSymbol ?? '—'}</div>
                                <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                                  {h.tokenMint.slice(0, 6)}…{h.tokenMint.slice(-4)}
                                </div>
                              </td>
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                                {h.marketCapUsd > 0 ? `$${(h.marketCapUsd >= 1_000_000 ? (h.marketCapUsd / 1_000_000).toFixed(1) + 'M' : h.marketCapUsd >= 1_000 ? (h.marketCapUsd / 1_000).toFixed(0) + 'K' : h.marketCapUsd.toFixed(0))}` : '—'}
                              </td>
                              <td className="px-5 py-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <a
                                    href={`https://dexscreener.com/solana/${h.tokenMint}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors"
                                  >
                                    dex
                                  </a>
                                  <CopyCAButton mint={h.tokenMint} />
                                </div>
                              </td>
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                                {Number(h.amount).toLocaleString()}
                              </td>
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                                {Number(h.valueSol).toFixed(4)}
                              </td>
                              <td className="px-5 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="h-2 w-16 overflow-hidden rounded-full bg-black/30">
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${h.allocationPct}%`,
                                        background: c.chip,
                                      }}
                                    />
                                  </div>
                                  <span
                                    className="font-[family-name:var(--font-mono)] text-sm"
                                    style={{ color: c.text }}
                                  >
                                    {h.allocationPct}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {nativeSol > 0.001 && (
                            <tr
                              className="border-t hover:bg-white/[0.02]"
                              style={{ borderColor: c.border }}
                            >
                              <td className="px-5 py-3 text-sm">
                                <div className="font-semibold text-[var(--color-text-muted)]">SOL</div>
                                <div className="text-[10px] text-[var(--color-text-muted)]">gas reserve</div>
                              </td>
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">—</td>
                              <td className="px-5 py-3" />
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                                {nativeSol.toFixed(4)}
                              </td>
                              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                                {nativeSol.toFixed(4)}
                              </td>
                              <td className="px-5 py-3" />
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
            </div>
          )}
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
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
                Current Index
              </h2>
              <RefreshCw className="h-4 w-4 text-[var(--color-text-muted)]" />
            </div>
            <div className="flex gap-2">
              {TIER_LIST.map((tier) => {
                const c = TIER_COLORS[tier]
                const active = indexTier === tier
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setIndexTier(tier)}
                    className="rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors"
                    style={
                      active
                        ? { background: c.chip, borderColor: c.chip, color: '#0a0a0a' }
                        : { background: 'transparent', borderColor: c.border, color: c.text }
                    }
                  >
                    {tier}
                  </button>
                )
              })}
            </div>
          </div>
          <div
            className="overflow-hidden rounded-2xl border p-0"
            style={{
              background: TIER_COLORS[indexTier].bg,
              borderColor: TIER_COLORS[indexTier].border,
            }}
          >
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
                    MC
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Links
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
                      className="border-t hover:bg-white/[0.02]"
                      style={{ borderColor: TIER_COLORS[indexTier].border }}
                    >
                      <td className="px-6 py-3 font-[family-name:var(--font-mono)] text-sm">
                        {t.rank}
                      </td>
                      <td className="px-6 py-3 font-medium text-sm">
                        {t.tokenSymbol}
                      </td>
                      <td className="px-6 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                        {t.marketCapUsd > 0 ? `$${(t.marketCapUsd >= 1_000_000 ? (t.marketCapUsd / 1_000_000).toFixed(1) + 'M' : t.marketCapUsd >= 1_000 ? (t.marketCapUsd / 1_000).toFixed(0) + 'K' : t.marketCapUsd.toFixed(0))}` : '—'}
                      </td>
                      <td className="px-6 py-3 text-center">
                        {t.tokenMint !== 'SOL' && (
                          <div className="flex items-center justify-center gap-1">
                            <a
                              href={`https://dexscreener.com/solana/${t.tokenMint}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] transition-colors"
                            >
                              dex
                            </a>
                            <CopyCAButton mint={t.tokenMint} />
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right font-[family-name:var(--font-mono)] text-sm">
                        {Number(t.compositeScore).toFixed(4)}
                      </td>
                      <td
                        className="px-6 py-3 text-right font-[family-name:var(--font-mono)] text-sm"
                        style={{ color: TIER_COLORS[indexTier].text }}
                      >
                        {t.weightPct}%
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={6}
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
      <WithdrawalModal
        open={showWithdraw}
        onClose={() => setShowWithdraw(false)}
        tiers={(pnlData?.data?.tiers ?? []).map((t: any) => ({
          riskTier: t.riskTier,
          currentValueSol: t.currentValueSol ?? '0',
        }))}
        onWithdrawn={() => {
          setShowWithdraw(false)
          refetchPortfolio()
          setNotice({
            kind: 'success',
            title: 'Withdrawal queued',
            message: 'Your holdings are being liquidated. SOL will arrive in your wallet shortly.',
          })
        }}
      />
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <AllocationProgressModal
        depositId={allocation?.depositId ?? null}
        tier={allocation?.tier ?? ''}
        amountSol={allocation?.amountSol ?? 0}
        onClose={() => setAllocation(null)}
        onDone={() => {
          setAllocation(null)
          refetchPortfolio()
          setNotice({
            kind: 'success',
            title: 'Allocation complete',
            message: 'Your deposit has been swapped into the vault basket.',
          })
        }}
      />
    </div>
  )
}

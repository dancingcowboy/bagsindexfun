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
  Copy,
  Check,
} from 'lucide-react'

// Per-tier color tokens are now shared with the admin vault view; they
// live alongside the reusable TierHoldingsCard so dashboard + vault never
// drift visually.
import { TierHoldingsCard, TIER_COLORS } from '@/components/TierHoldingsCard'
import { PersonalVaults } from './PersonalVaults'
const TIER_LIST = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
import { BAGSX_MINT } from '@bags-index/shared'
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
import { NextCycleCountdown } from '@/components/NextCycleCountdown'
import { Notice, type NoticeState } from '@/components/Notice'
import { AllocationProgressModal } from '@/components/AllocationProgressModal'
import { WithdrawalModal } from '@/components/WithdrawalModal'
import { WithdrawalProgressModal } from '@/components/WithdrawalProgressModal'
import { ChatWidget } from '@/components/ChatWidget'
import { API_BASE } from '@/lib/api'

const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || `${API_BASE}/solana/rpc`

/**
 * Opt-in Telegram DM notifications. User clicks "Link Telegram" to
 * generate a 6-digit code + deep link to @bagsindexbot. After they
 * `/start` the bot, the webhook binds their chat id and this card polls
 * `/user/telegram/status` every 3s until it flips to linked.
 */
function TelegramNotificationsCard() {
  const [linked, setLinked] = useState<boolean | null>(null)
  const [enabled, setEnabled] = useState<boolean>(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [deepLink, setDeepLink] = useState<string | null>(null)
  const [codeExpires, setCodeExpires] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const refresh = useCallback(async () => {
    try {
      const res = await api.getTelegramStatus()
      setLinked(res.data.linked)
      setEnabled(res.data.enabled)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load status')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll every 3s while the linking modal is open, stopping as soon as
  // Telegram confirms the bind (so the user sees instant feedback after
  // they send /start CODE to the bot).
  useEffect(() => {
    if (!modalOpen || linked) return
    const iv = setInterval(async () => {
      try {
        const res = await api.getTelegramStatus()
        if (res.data.linked) {
          setLinked(true)
          setEnabled(res.data.enabled)
          setModalOpen(false)
        }
      } catch {
        /* ignore transient errors while polling */
      }
    }, 3000)
    return () => clearInterval(iv)
  }, [modalOpen, linked])

  // Tick every second so the countdown re-renders.
  useEffect(() => {
    if (!modalOpen || !codeExpires) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [modalOpen, codeExpires])

  async function startLink() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.createTelegramLinkCode()
      setCode(res.data.code)
      setDeepLink(res.data.deepLink)
      setCodeExpires(new Date(res.data.expiresAt).getTime())
      setModalOpen(true)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to start link')
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled() {
    setBusy(true)
    try {
      const res = await api.setTelegramEnabled(!enabled)
      setEnabled(res.data.enabled)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update')
    } finally {
      setBusy(false)
    }
  }

  async function unlink() {
    if (!confirm('Unlink Telegram? You will stop receiving DMs.')) return
    setBusy(true)
    try {
      await api.unlinkTelegram()
      setLinked(false)
      setEnabled(false)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to unlink')
    } finally {
      setBusy(false)
    }
  }

  function copyCode() {
    if (!code) return
    navigator.clipboard.writeText(code)
  }

  const remaining = codeExpires ? Math.max(0, codeExpires - now) : 0
  const mm = Math.floor(remaining / 60000)
  const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0')

  return (
    <div className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-semibold">Telegram notifications</div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {linked
            ? enabled
              ? 'DMs from @bagsindexbot on every trade.'
              : 'Linked — DMs currently paused.'
            : 'Get DMs when your vaults trade, deposit, or withdraw.'}
        </div>
        {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
      </div>
      <div className="flex items-center gap-2">
        {linked ? (
          <>
            <button
              onClick={toggleEnabled}
              disabled={busy}
              className="rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
              style={{
                borderColor: enabled ? '#00D62B' : 'var(--color-border)',
                color: enabled ? '#00D62B' : 'var(--color-text-muted)',
                backgroundColor: enabled ? 'rgba(0,214,43,0.08)' : 'transparent',
              }}
            >
              {enabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={unlink}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-white disabled:opacity-40"
            >
              Unlink
            </button>
          </>
        ) : (
          <button
            onClick={startLink}
            disabled={busy}
            className="btn-outline text-xs disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Link Telegram'}
          </button>
        )}
      </div>

      {modalOpen && code && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="card w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-1">Link Telegram</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Open @bagsindexbot and send <code>/start {code}</code> — or just send the code.
            </p>
            <button
              onClick={copyCode}
              className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-black/30 py-4 font-[family-name:var(--font-mono)] text-3xl font-bold tracking-[0.4em] hover:bg-black/40"
            >
              {code}
            </button>
            {deepLink && (
              <a
                href={deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mb-3 block w-full rounded-md bg-[#00D62B] py-2 text-center text-sm font-bold text-black hover:opacity-90"
              >
                Open @{deepLink.split('/').pop()?.split('?')[0] || 'bagsindexbot'}
              </a>
            )}
            <div className="mb-3 text-center text-xs text-[var(--color-text-muted)]">
              Code expires in {mm}:{ss}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const { authenticated, ready, logout, user, connectWallet } = usePrivy()
  const { wallets: solanaWallets } = useConnectedStandardWallets()
  const router = useRouter()
  const [showDeposit, setShowDeposit] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositTier, setDepositTier] = useState<'CONSERVATIVE' | 'BALANCED' | 'DEGEN'>('BALANCED')
  // 'single' = deposit all SOL into one tier (classic flow).
  // 'split'  = split the total equally across all three vaults in one
  //            signed transaction, then queue 3 allocation progress modals.
  const [depositMode, setDepositMode] = useState<'single' | 'split' | 'vault'>('single')
  const [depositVaultId, setDepositVaultId] = useState<string | null>(null)
  const [depositing, setDepositing] = useState(false)
  const [depositStatus, setDepositStatus] = useState<string | null>(null)
  const [showWithdraw, setShowWithdraw] = useState(false)
  // Default to live mode so totalValueSol includes the sub-wallet's native
  // SOL balance (unspent native SOL) and uses current prices
  // instead of stale valueSolEst from DB.
  const [portfolioLive, setPortfolioLive] = useState(true)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [allocation, setAllocation] = useState<{
    depositId: string
    tier: string
    amountSol: number
  } | null>(null)
  // When a split deposit creates 3 deposits at once, we show the allocation
  // progress modal for the first and hold the rest here so we can pop the
  // next one as each tier finishes.
  const [allocationQueue, setAllocationQueue] = useState<Array<{
    depositId: string
    tier: string
    amountSol: number
  }>>([])
  const [liquidation, setLiquidation] = useState<{
    withdrawalId: string
    tier: string
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

  // Per-tier loading + transient message for "Force Reshuffle" buttons.
  const [reshufflingTier, setReshufflingTier] = useState<string | null>(null)
  const [reshuffleMsg, setReshuffleMsg] = useState<Record<string, string>>({})
  const handleForceReshuffle = async (
    tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN',
  ) => {
    if (
      !confirm(
        `Force reshuffle your ${tier} vault now?\n\nThis sells anything no longer in the top-10 and rebuys the current ranking. 1-hour cooldown after.`,
      )
    )
      return
    setReshufflingTier(tier)
    setReshuffleMsg((s) => ({ ...s, [tier]: '' }))
    try {
      await api.forceReshuffle(tier)
      setReshuffleMsg((s) => ({ ...s, [tier]: 'Queued — refresh in ~1 min' }))
      setTimeout(() => refetchPortfolio(), 60_000)
    } catch (e: any) {
      setReshuffleMsg((s) => ({ ...s, [tier]: e?.message || 'Failed' }))
    } finally {
      setReshufflingTier(null)
      setTimeout(
        () => setReshuffleMsg((s) => ({ ...s, [tier]: '' })),
        8000,
      )
    }
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

  const { data: pnlData, isLoading: pnlLoading, refetch: refetchPnl } = useQuery({
    queryKey: ['pnl'],
    queryFn: () => api.getPnl(),
    enabled: authenticated,
    refetchInterval: 30_000,
  })

  const { data: customVaultsRes } = useQuery({
    queryKey: ['custom-vaults'],
    queryFn: () => api.getCustomVaults(),
    enabled: authenticated,
  })
  const customVaults = customVaultsRes?.data ?? []

  // Per-tier auto-TP lookup (pct 0..100) sourced from /portfolio/pnl.
  const autoTpByTier: Record<string, number> = {}
  for (const pt of (pnlData?.data?.tiers as any[]) ?? []) {
    autoTpByTier[pt.riskTier] = Number(pt.autoTakeProfitPct ?? 0)
  }
  const [tpPending, setTpPending] = useState<string | null>(null)
  const handleSetAutoTp = async (
    tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN',
    pct: number,
  ) => {
    setTpPending(`${tier}:${pct}`)
    try {
      await api.setAutoTakeProfit(tier, pct)
      await refetchPnl()
    } catch (e: any) {
      alert(e?.message || 'Failed to update auto-TP')
    } finally {
      setTpPending(null)
    }
  }

  const [liquidatingMint, setLiquidatingMint] = useState<string | null>(null)
  const handleLiquidateHolding = async (
    mint: string,
    tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN',
    symbol: string | null,
    valueSol: number,
  ) => {
    if (
      !confirm(
        `Liquidate your ${symbol ?? 'position'} in ${tier}?\n\nThis sells only this one position (~${valueSol.toFixed(4)} SOL) and sends the proceeds to your connected wallet. The rest of the vault is untouched.`,
      )
    )
      return
    setLiquidatingMint(`${tier}:${mint}`)
    try {
      const res = await api.liquidateHolding(mint, tier)
      setLiquidation({ withdrawalId: res.data.id, tier })
    } catch (e: any) {
      alert(e?.message || 'Failed to liquidate position')
    } finally {
      setLiquidatingMint(null)
    }
  }


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
    try {
      // Personal vault deposit — separate flow (no Deposit row, just SOL transfer + rebalance)
      if (depositMode === 'vault') {
        if (!depositVaultId) {
          setNotice({ kind: 'error', title: 'No vault selected', message: 'Select a personal vault to deposit into.' })
          setDepositing(false)
          return
        }
        setDepositStatus('Creating deposit intent…')
        const intentRes = await api.depositCustomVault(depositVaultId, amount)
        const destination = intentRes.data.subWalletAddress

        setDepositStatus('Building transaction…')
        const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
        const fromPubkey = new PublicKey(wallet.address)
        const totalLamports = Math.round(amount * LAMPORTS_PER_SOL)

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight })
        tx.add(
          SystemProgram.transfer({
            fromPubkey,
            toPubkey: new PublicKey(destination),
            lamports: totalLamports,
          }),
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
        const deadline = Date.now() + 60_000
        while (true) {
          const { value } = await connection.getSignatureStatuses([txSignature])
          const st = value[0]
          if (st?.err) throw new Error('Transaction failed on-chain')
          if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break
          if (Date.now() > deadline) throw new Error('Timed out waiting for confirmation')
          await new Promise((r) => setTimeout(r, 1500))
        }

        setDepositStatus('Confirming deposit & triggering rebalance…')
        await api.confirmCustomVaultDeposit(depositVaultId, txSignature, amount)

        setShowDeposit(false)
        setDepositAmount('')
        setDepositStatus(null)
        setNotice({
          kind: 'success',
          title: 'Vault deposit confirmed',
          message: 'SOL sent to your personal vault. Rebalance triggered — tokens will be purchased shortly.',
        })
        setDepositing(false)
        return
      }

      // Build the list of legs: one for single-tier, three for split.
      // Split into equal integer lamport chunks and dump the rounding
      // dust onto the last leg so the lamport totals match `amount`.
      type Leg = { tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'; amountSol: number; lamports: number }
      const totalLamports = Math.round(amount * LAMPORTS_PER_SOL)
      let legs: Leg[]
      if (depositMode === 'split') {
        const per = Math.floor(totalLamports / 3)
        const remainder = totalLamports - per * 2 // last leg absorbs dust
        legs = [
          { tier: 'CONSERVATIVE', amountSol: per / LAMPORTS_PER_SOL, lamports: per },
          { tier: 'BALANCED', amountSol: per / LAMPORTS_PER_SOL, lamports: per },
          { tier: 'DEGEN', amountSol: remainder / LAMPORTS_PER_SOL, lamports: remainder },
        ]
      } else {
        legs = [{ tier: depositTier, amountSol: amount, lamports: totalLamports }]
      }

      setDepositStatus(
        legs.length > 1 ? 'Creating 3 deposit intents…' : 'Creating deposit intent…',
      )
      // Each tier has its own sub-wallet destination; create a Deposit row
      // per tier so the allocation worker picks them up independently.
      const createdLegs: Array<Leg & { depositId: string; destination: string }> = []
      for (const leg of legs) {
        const res = await api.createDeposit(leg.amountSol, leg.tier)
        createdLegs.push({
          ...leg,
          depositId: res.data.id as string,
          destination: res.data.subWalletAddress as string,
        })
      }

      setDepositStatus('Building transaction…')
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
      const fromPubkey = new PublicKey(wallet.address)

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight })
      for (const leg of createdLegs) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey,
            toPubkey: new PublicKey(leg.destination),
            lamports: leg.lamports,
          }),
        )
      }
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
      // Reuse the same signature across all 3 legs — /confirm doesn't
      // verify the tx contents, it just flips status and enqueues the job.
      for (const leg of createdLegs) {
        await api.confirmDeposit(leg.depositId, txSignature)
      }

      setShowDeposit(false)
      setDepositAmount('')
      setDepositStatus(null)
      // Open the live allocation progress modal for the first leg; the
      // rest go into the queue and pop when the current one finishes.
      const [first, ...rest] = createdLegs
      setAllocation({ depositId: first.depositId, tier: first.tier, amountSol: first.amountSol })
      setAllocationQueue(
        rest.map((r) => ({ depositId: r.depositId, tier: r.tier, amountSol: r.amountSol })),
      )
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
                onClick={() => {
                  setPortfolioLive(true)
                  setTimeout(() => refetchPortfolio(), 0)
                }}
                disabled={portfolioFetching}
                className="flex items-center gap-2 rounded-lg border border-amber-400/60 bg-amber-400/10 px-4 py-2 text-sm font-bold uppercase tracking-wide text-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.25)] transition hover:bg-amber-400/20 hover:shadow-[0_0_28px_rgba(251,191,36,0.4)] disabled:opacity-50"
                title="Fetch latest on-chain holdings"
              >
                <RefreshCw className={`h-4 w-4 ${portfolioFetching ? 'animate-spin' : ''}`} />
                {portfolioFetching ? 'Loading…' : 'Load Holdings'}
              </button>
              <button
                onClick={() => setShowDeposit(true)}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                <ArrowDownToLine className="h-4 w-4" /> Deposit
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

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04 }}
          className="mb-6"
        >
          <TelegramNotificationsCard />
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
          <TokenPriceChart tierSelectable vaultPnlEndpoint="/portfolio/pnl-history" title="Your Vault vs Tokens" subtitle="Top-10 token prices + your vault's actual SOL performance per tier" />
        </motion.div>

        {/* Pool PnL */}
        {(pnlLoading || (pnlData?.data?.tiers && pnlData.data.tiers.length > 0)) && (
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
              {pnlLoading && !pnlData ? (
                <>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="card animate-pulse">
                      <div className="h-4 w-24 rounded bg-white/10 mb-2" />
                      <div className="h-8 w-36 rounded bg-white/10 mb-1" />
                      <div className="h-4 w-16 rounded bg-white/10" />
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {[0, 1, 2, 3].map((j) => (
                          <div key={j}>
                            <div className="h-3 w-12 rounded bg-white/10 mb-1" />
                            <div className="h-4 w-16 rounded bg-white/10" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                pnlData?.data?.tiers?.map((t: any) => {
                  // Headline is TOTAL PnL (realized + unrealized) vs original
                  // deposited capital, not just open/unrealized. Realized cash
                  // already left the vault and still counts toward your score.
                  const totalPnl = Number(t.totalPnlSol)
                  const pct = Number(t.pnlPct)
                  const positive = totalPnl >= 0
                  return (
                    <div key={t.riskTier} className="card">
                      <div className="text-sm text-[var(--color-text-muted)] mb-1">{t.riskTier}</div>
                      <div className={`font-[family-name:var(--font-display)] text-2xl font-bold ${positive ? 'text-[var(--color-accent)]' : 'text-red-400'}`}>
                        {positive ? '+' : ''}{totalPnl.toFixed(4)} SOL
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
                })
              )}
            </div>
          </motion.div>
        )}

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
              {/* Mode toggle: single tier vs. split vs. personal vault. */}
              <div className="mb-4">
                <label className="block text-sm text-[var(--color-text-muted)] mb-2">
                  Mode
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { key: 'single', label: 'Single vault' },
                      { key: 'split', label: 'Split all 3' },
                      ...(customVaults.length > 0
                        ? [{ key: 'vault' as const, label: 'Personal' }]
                        : []),
                    ] as const
                  ).map((m) => {
                    const active = depositMode === m.key
                    return (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => {
                          setDepositMode(m.key as any)
                          if (m.key === 'vault' && customVaults.length > 0 && !depositVaultId) {
                            setDepositVaultId(customVaults[0].id)
                          }
                        }}
                        className="rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
                        style={
                          active
                            ? { background: '#00D62B', color: '#000', borderColor: '#00D62B' }
                            : { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }
                        }
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {depositMode === 'single' ? (
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
              ) : depositMode === 'vault' ? (
                <div className="mb-4">
                  <label className="block text-sm text-[var(--color-text-muted)] mb-2">
                    Vault
                  </label>
                  <div className="space-y-2">
                    {customVaults.map((v: any) => {
                      const active = depositVaultId === v.id
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => setDepositVaultId(v.id)}
                          className="w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold transition-colors"
                          style={
                            active
                              ? { background: '#00D62B', color: '#000', borderColor: '#00D62B' }
                              : { borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }
                          }
                        >
                          Vault {v.id.slice(0, 6)} · {v.tokenMints.length} tokens
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-black/20 p-3 text-xs text-[var(--color-text-muted)]">
                  Your total will be split equally across all three vaults
                  (~{(() => {
                    const n = parseFloat(depositAmount)
                    return Number.isFinite(n) && n > 0 ? (n / 3).toFixed(4) : '0.0000'
                  })()} SOL each) in a single signed transaction.
                </div>
              )}
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
                .map((t: any) => (
                  <TierHoldingsCard
                    key={t.riskTier}
                    tier={{
                      riskTier: t.riskTier,
                      walletAddress: t.walletAddress,
                      totalValueSol: t.totalValueSol,
                      nativeSol: t.nativeSol,
                      holdings: (t.holdings ?? []).map((h: any) => ({
                        tokenMint: h.tokenMint,
                        tokenSymbol: h.tokenSymbol,
                        amount: h.amount,
                        valueSol: h.valueSol,
                        allocationPct: h.allocationPct,
                        marketCapUsd: h.marketCapUsd,
                      })),
                    }}
                    forceReshuffle={{
                      onClick: (tier) => handleForceReshuffle(tier as any),
                      pending: reshufflingTier === t.riskTier,
                      message: reshuffleMsg[t.riskTier],
                    }}
                    autoTp={{
                      value: autoTpByTier[t.riskTier] ?? 0,
                      onChange: (tier, pct) => handleSetAutoTp(tier as any, pct),
                      pending: tpPending,
                    }}
                    onLiquidateHolding={(mint, tier, sym, val) => handleLiquidateHolding(mint, tier as any, sym, val)}
                    liquidatingKey={liquidatingMint}
                  />
                ))}
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

        {/* Personal Vaults */}
        <PersonalVaults />

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
        onProgress={(withdrawalId, tier) => {
          setShowWithdraw(false)
          setLiquidation({ withdrawalId, tier })
        }}
      />
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <AllocationProgressModal
        depositId={allocation?.depositId ?? null}
        tier={allocation?.tier ?? ''}
        amountSol={allocation?.amountSol ?? 0}
        onClose={() => {
          // Closing the modal mid-split dismisses the whole queue — the
          // worker keeps processing in the background either way.
          setAllocation(null)
          setAllocationQueue([])
        }}
        onDone={() => {
          refetchPortfolio()
          if (allocationQueue.length > 0) {
            // Pop the next leg of a split deposit and keep the modal open.
            const [next, ...rest] = allocationQueue
            setAllocation(next)
            setAllocationQueue(rest)
          } else {
            setAllocation(null)
            setNotice({
              kind: 'success',
              title: 'Allocation complete',
              message: 'Your deposit has been swapped into the vault basket.',
            })
          }
        }}
      />
      <WithdrawalProgressModal
        withdrawalId={liquidation?.withdrawalId ?? null}
        tier={liquidation?.tier ?? ''}
        onClose={() => setLiquidation(null)}
        onDone={() => {
          setLiquidation(null)
          refetchPortfolio()
          setNotice({
            kind: 'success',
            title: 'Withdrawal complete',
            message: 'Your holdings have been sold and SOL returned to your wallet.',
          })
        }}
      />
      {authenticated && <ChatWidget />}
    </div>
  )
}

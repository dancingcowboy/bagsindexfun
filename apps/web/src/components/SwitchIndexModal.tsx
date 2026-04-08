'use client'

import { useState, useMemo } from 'react'
import { ArrowRight, Shield, BarChart3, Flame, X, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'

type Tier = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

interface TierRow {
  riskTier: Tier
  totalValueSol: string
}

interface Props {
  open: boolean
  onClose: () => void
  tiers: TierRow[]
  onSwitched?: () => void
}

const TIER_META: Record<Tier, { label: string; color: string; icon: any; desc: string }> = {
  CONSERVATIVE: {
    label: 'Conservative',
    color: '#00b8ff',
    icon: Shield,
    desc: 'Deep liquidity, steady holders',
  },
  BALANCED: {
    label: 'Balanced',
    color: '#00D62B',
    icon: BarChart3,
    desc: 'The default index experience',
  },
  DEGEN: {
    label: 'Degen',
    color: '#ff8c00',
    icon: Flame,
    desc: 'Highest volume, newest tokens',
  },
}

export function SwitchIndexModal({ open, onClose, tiers, onSwitched }: Props) {
  const [fromTier, setFromTier] = useState<Tier | null>(null)
  const [toTier, setToTier] = useState<Tier | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const eligibleFrom = useMemo(
    () => tiers.filter((t) => parseFloat(t.totalValueSol) > 0),
    [tiers],
  )

  const fromValue = useMemo(() => {
    if (!fromTier) return 0
    return parseFloat(
      tiers.find((t) => t.riskTier === fromTier)?.totalValueSol ?? '0',
    )
  }, [tiers, fromTier])

  // Fee math (mirrors constants.ts: SWITCH 1%, naive WITHDRAW 2% + DEPOSIT 3%)
  const switchFee = fromValue * 0.01
  const naiveFee = fromValue * 0.05
  const savings = Math.max(0, naiveFee - switchFee)

  if (!open) return null

  const canSubmit = !!fromTier && !!toTier && fromTier !== toTier && fromValue > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit || !fromTier || !toTier) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.createSwitch(fromTier, toTier)
      alert(
        `Switch started.\n\n` +
          `From: ${fromTier}\n` +
          `To: ${toTier}\n` +
          `Source value: ${res.data.sourceValueSol} SOL\n` +
          `Fee: ${res.data.feeSol} SOL\n` +
          `Estimated savings vs withdraw+deposit: ${res.data.estimatedSavingsSol} SOL`,
      )
      onSwitched?.()
      onClose()
      setFromTier(null)
      setToTier(null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to switch')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-0 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#00D62B]" />
            <h3 className="font-[family-name:var(--font-display)] text-lg font-bold">
              Switch Index
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-sm text-[var(--color-text-muted)]">
            Move your position between indexes in a single on-chain operation.
            Overlap tokens aren&apos;t sold and rebought — just one 1% flat fee
            instead of the 5% withdraw+deposit round trip.
          </p>

          {/* From tier */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              From
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as Tier[]).map((t) => {
                const meta = TIER_META[t]
                const Icon = meta.icon
                const row = tiers.find((x) => x.riskTier === t)
                const val = parseFloat(row?.totalValueSol ?? '0')
                const disabled = val <= 0
                const selected = fromTier === t
                return (
                  <button
                    key={t}
                    disabled={disabled}
                    onClick={() => {
                      setFromTier(t)
                      if (toTier === t) setToTier(null)
                    }}
                    className="rounded-lg border p-3 text-left transition disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      borderColor: selected ? meta.color : 'var(--color-border)',
                      backgroundColor: selected ? `${meta.color}15` : 'transparent',
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
                      <span className="text-xs font-bold">{meta.label}</span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {val.toFixed(3)} SOL
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex justify-center">
            <ArrowRight className="h-4 w-4 text-[var(--color-text-muted)]" />
          </div>

          {/* To tier */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              To
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['CONSERVATIVE', 'BALANCED', 'DEGEN'] as Tier[]).map((t) => {
                const meta = TIER_META[t]
                const Icon = meta.icon
                const disabled = fromTier === t
                const selected = toTier === t
                return (
                  <button
                    key={t}
                    disabled={disabled}
                    onClick={() => setToTier(t)}
                    className="rounded-lg border p-3 text-left transition disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      borderColor: selected ? meta.color : 'var(--color-border)',
                      backgroundColor: selected ? `${meta.color}15` : 'transparent',
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
                      <span className="text-xs font-bold">{meta.label}</span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {meta.desc}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Fee breakdown */}
          {fromTier && toTier && (
            <div className="rounded-lg border border-[var(--color-border)] bg-black/20 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Source value</span>
                <span className="font-mono">{fromValue.toFixed(4)} SOL</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Switch fee (1%)</span>
                <span className="font-mono">{switchFee.toFixed(4)} SOL</span>
              </div>
              <div className="flex justify-between text-xs opacity-70">
                <span>Withdraw+deposit would cost</span>
                <span className="font-mono line-through">{naiveFee.toFixed(4)} SOL</span>
              </div>
              <div className="flex justify-between border-t border-[var(--color-border)] pt-2">
                <span className="text-[#00D62B]">Estimated savings</span>
                <span className="font-mono text-[#00D62B]">
                  +{savings.toFixed(4)} SOL
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="btn-outline flex-1 text-sm"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="btn-primary flex-1 text-sm disabled:opacity-40"
            >
              {submitting ? 'Switching…' : 'Switch index'}
            </button>
          </div>

          {eligibleFrom.length === 0 && (
            <p className="text-center text-xs text-[var(--color-text-muted)]">
              You don&apos;t have any holdings to switch yet. Deposit into a tier
              first.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

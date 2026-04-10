'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpFromLine, X, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

const TIER_COLORS: Record<string, { chip: string; text: string; border: string }> = {
  CONSERVATIVE: { chip: '#0ea5e9', text: '#7dd3fc', border: 'rgba(56, 189, 248, 0.35)' },
  BALANCED: { chip: '#a855f7', text: '#c084fc', border: 'rgba(168, 85, 247, 0.35)' },
  DEGEN: { chip: '#ec4899', text: '#f9a8d4', border: 'rgba(244, 114, 182, 0.35)' },
}

interface TierInfo {
  riskTier: string
  currentValueSol: string | number
}

interface Props {
  open: boolean
  onClose: () => void
  tiers: TierInfo[]
  onWithdrawn: () => void
}

export function WithdrawalModal({ open, onClose, tiers, onWithdrawn }: Props) {
  // Per-tier percentage selections
  const [pcts, setPcts] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [results, setResults] = useState<Array<{ tier: string; ok: boolean; msg: string }>>([])

  const activeTiers = tiers.filter((t) => Number(t.currentValueSol) > 0)

  const getPct = (tier: string) => pcts[tier] ?? 100
  const setPct = (tier: string, val: number) =>
    setPcts((prev) => ({ ...prev, [tier]: Math.max(1, Math.min(100, val)) }))

  const handleWithdraw = async (tierList: TierInfo[]) => {
    if (busy) return
    setBusy(true)
    setResults([])
    const out: typeof results = []

    for (const t of tierList) {
      const pct = getPct(t.riskTier)
      setStatus(`Withdrawing ${pct}% from ${t.riskTier}...`)
      try {
        const res = await api.createWithdrawal(t.riskTier, pct)
        out.push({
          tier: t.riskTier,
          ok: true,
          msg: `~${Number(res.data.netSol).toFixed(4)} SOL queued`,
        })
      } catch (err: any) {
        out.push({
          tier: t.riskTier,
          ok: false,
          msg: err?.message ?? 'Failed',
        })
      }
    }

    setResults(out)
    setStatus(null)
    setBusy(false)

    if (out.every((r) => r.ok)) {
      setTimeout(() => {
        onWithdrawn()
      }, 1500)
    }
  }

  const handleWithdrawAll = () => {
    // Override all pcts to 100 for withdraw-all
    const full: Record<string, number> = {}
    for (const t of activeTiers) full[t.riskTier] = 100
    setPcts(full)
    handleWithdraw(activeTiers)
  }

  if (!open) return null

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="card w-full max-w-lg relative"
        >
          <button
            onClick={onClose}
            disabled={busy}
            className="absolute right-4 top-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
          >
            <X className="h-5 w-5" />
          </button>

          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold mb-1">
            Withdraw
          </h2>
          <p className="text-sm text-[var(--color-text-muted)] mb-5">
            Choose how much to withdraw from each index. Holdings will be sold and SOL returned to your wallet.
          </p>

          {activeTiers.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">
              No active positions to withdraw from.
            </p>
          ) : (
            <div className="space-y-4 mb-5">
              {activeTiers.map((t) => {
                const c = TIER_COLORS[t.riskTier] ?? TIER_COLORS.BALANCED
                const val = Number(t.currentValueSol)
                const pct = getPct(t.riskTier)
                const estSol = (val * pct) / 100
                return (
                  <div
                    key={t.riskTier}
                    className="rounded-xl border p-4"
                    style={{ borderColor: c.border }}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: c.chip, color: '#0a0a0a' }}
                        >
                          {t.riskTier}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {val.toFixed(4)} SOL
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="font-[family-name:var(--font-mono)] text-sm font-bold"
                          style={{ color: c.text }}
                        >
                          {pct}%
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          ~{estSol.toFixed(4)} SOL
                        </span>
                      </div>
                    </div>
                    {/* Percentage slider */}
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={pct}
                      onChange={(e) => setPct(t.riskTier, Number(e.target.value))}
                      disabled={busy}
                      className="w-full h-1.5 rounded-full appearance-none cursor-pointer disabled:opacity-40"
                      style={{
                        background: `linear-gradient(to right, ${c.chip} 0%, ${c.chip} ${pct}%, var(--color-bg-secondary) ${pct}%, var(--color-bg-secondary) 100%)`,
                        accentColor: c.chip,
                      }}
                    />
                    <div className="flex justify-between mt-2">
                      {[25, 50, 75, 100].map((q) => (
                        <button
                          key={q}
                          type="button"
                          disabled={busy}
                          onClick={() => setPct(t.riskTier, q)}
                          className="rounded border px-2 py-0.5 text-[10px] font-bold transition-colors disabled:opacity-30"
                          style={
                            pct === q
                              ? { background: c.chip, borderColor: c.chip, color: '#0a0a0a' }
                              : { borderColor: c.border, color: c.text }
                          }
                        >
                          {q}%
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="mb-4 space-y-1">
              {results.map((r) => (
                <div
                  key={r.tier}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${r.ok ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'bg-red-500/10 text-red-400'}`}
                >
                  {!r.ok && <AlertTriangle className="h-3 w-3" />}
                  <span className="font-bold">{r.tier}</span> — {r.msg}
                </div>
              ))}
            </div>
          )}

          {status && (
            <div className="mb-3 rounded-md border border-[var(--color-border)] bg-black/20 px-3 py-2 text-xs text-[var(--color-text-muted)]">
              {status}
            </div>
          )}

          {activeTiers.length > 0 && (
            <div className="flex gap-3">
              <button
                onClick={() =>
                  handleWithdraw(activeTiers.filter((t) => getPct(t.riskTier) > 0))
                }
                disabled={busy || activeTiers.length === 0}
                className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <ArrowUpFromLine className="h-4 w-4" />
                {busy ? 'Processing...' : 'Withdraw Selected'}
              </button>
              <button
                onClick={handleWithdrawAll}
                disabled={busy}
                className="btn-outline flex items-center justify-center gap-2 px-4 text-sm disabled:opacity-50 text-red-400 border-red-400/40 hover:bg-red-400/10"
              >
                Withdraw All
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Loader2, XCircle, X } from 'lucide-react'
import { api } from '@/lib/api'

type Swap = {
  id: string
  outputMint: string
  tokenSymbol: string | null
  inputSol: string
  outputAmount: string | null
  status: string
  errorMessage: string | null
  executedAt: string
  confirmedAt: string | null
}

type Progress = {
  depositStatus: string
  done: boolean
  counts: { pending: number; confirmed: number; failed: number; total: number }
  swaps: Swap[]
}

/**
 * Polls /deposits/:id/progress every 1s while the deposit worker is
 * swapping SOL into the tier basket. Shows a live log of every swap
 * (pending → confirmed/failed) and auto-calls onDone once every swap has
 * settled so the dashboard can refetch the portfolio.
 */
export function AllocationProgressModal({
  depositId,
  tier,
  amountSol,
  onClose,
  onDone,
}: {
  depositId: string | null
  tier: string
  amountSol: number
  onClose: () => void
  onDone: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!depositId) return
    let cancelled = false
    let finishedAt = 0
    const tick = async () => {
      try {
        const res = await api.getDepositProgress(depositId)
        if (cancelled) return
        setProgress(res.data)
        // Once done, give the reconcile one extra beat, then signal done.
        if (res.data.done) {
          if (!finishedAt) finishedAt = Date.now()
          if (Date.now() - finishedAt >= 1500) {
            onDone()
            return
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load progress')
      }
      if (!cancelled) setTimeout(tick, 1000)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [depositId, onDone])

  return (
    <AnimatePresence>
      {depositId && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
              <div>
                <div className="font-[family-name:var(--font-display)] text-lg font-bold">
                  Allocating {amountSol} SOL
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {tier} vault — {progress?.counts.confirmed ?? 0}/
                  {progress?.counts.total ?? 0} swaps confirmed
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {error && (
                <div className="m-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
                  {error}
                </div>
              )}
              {!progress && !error && (
                <div className="flex items-center gap-2 p-6 text-sm text-[var(--color-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Waiting for worker to pick up the job…
                </div>
              )}
              {progress && progress.swaps.length === 0 && (
                <div className="flex items-center gap-2 p-6 text-sm text-[var(--color-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Queued. The first swap will appear here any moment…
                </div>
              )}
              {progress && progress.swaps.length > 0 && (
                <ul className="divide-y divide-[var(--color-border-subtle)]">
                  {progress.swaps.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="flex-shrink-0">
                        {s.status === 'CONFIRMED' ? (
                          <CheckCircle2 className="h-4 w-4 text-[#00D62B]" />
                        ) : s.status === 'FAILED' ? (
                          <XCircle className="h-4 w-4 text-red-400" />
                        ) : (
                          <Loader2 className="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">
                          {s.tokenSymbol ?? `${s.outputMint.slice(0, 6)}…${s.outputMint.slice(-4)}`}
                        </div>
                        {s.errorMessage && (
                          <div className="truncate text-[10px] text-red-400">{s.errorMessage}</div>
                        )}
                      </div>
                      <div className="text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                        {s.inputSol} SOL
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {progress?.done && (
              <div className="border-t border-[var(--color-border)] bg-[#00D62B]/10 px-5 py-3 text-sm text-[#00D62B]">
                Allocation complete — refreshing your portfolio…
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

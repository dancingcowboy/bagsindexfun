'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Loader2, XCircle, X } from 'lucide-react'
import { api } from '@/lib/api'

type Swap = {
  id: string
  inputMint: string
  tokenSymbol: string | null
  outputSol: string | null
  status: string
  errorMessage: string | null
  executedAt: string
  confirmedAt: string | null
}

type Progress = {
  withdrawalStatus: string
  done: boolean
  counts: { pending: number; confirmed: number; failed: number; total: number }
  swaps: Swap[]
}

export function WithdrawalProgressModal({
  withdrawalId,
  tier,
  onClose,
  onDone,
}: {
  withdrawalId: string | null
  tier: string
  onClose: () => void
  onDone: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!withdrawalId) return
    let cancelled = false
    let finishedAt = 0
    const tick = async () => {
      try {
        const res = await api.getWithdrawalProgress(withdrawalId)
        if (cancelled) return
        setProgress(res.data)
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
  }, [withdrawalId, onDone])

  return (
    <AnimatePresence>
      {withdrawalId && (
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
                  Liquidating {tier} vault
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {progress?.counts.confirmed ?? 0}/
                  {progress?.counts.total ?? 0} sells confirmed
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
                  Waiting for worker to pick up the job...
                </div>
              )}
              {progress && progress.swaps.length === 0 && (
                <div className="flex items-center gap-2 p-6 text-sm text-[var(--color-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Queued. The first sell will appear here any moment...
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
                          {s.tokenSymbol ?? `${s.inputMint.slice(0, 6)}...${s.inputMint.slice(-4)}`}
                        </div>
                        {s.errorMessage && (
                          <div className="truncate text-[10px] text-red-400">{s.errorMessage}</div>
                        )}
                      </div>
                      <div className="text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                        {s.outputSol ? `${s.outputSol} SOL` : '---'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {progress?.done && (
              <div className="border-t border-[var(--color-border)] bg-[#00D62B]/10 px-5 py-3">
                <div className="text-sm text-[#00D62B]">Liquidation complete</div>
                <div className="text-xs text-[#00D62B]/70 mt-1">
                  SOL has been returned to your wallet. Your portfolio will update within a few moments.
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useEffect } from 'react'

export type NoticeKind = 'success' | 'error' | 'info'

export interface NoticeState {
  kind: NoticeKind
  title: string
  message?: string
}

interface Props {
  notice: NoticeState | null
  onClose: () => void
}

const META: Record<NoticeKind, { color: string; Icon: any }> = {
  success: { color: '#00D62B', Icon: CheckCircle2 },
  error:   { color: '#ff4d4f', Icon: AlertCircle },
  info:    { color: '#00b8ff', Icon: Info },
}

export function Notice({ notice, onClose }: Props) {
  useEffect(() => {
    if (!notice) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notice, onClose])

  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="card w-full max-w-md p-0 overflow-hidden"
            style={{ borderColor: META[notice.kind].color + '55' }}
          >
            <div
              className="flex items-start gap-3 px-6 py-5"
              style={{ borderLeft: `3px solid ${META[notice.kind].color}` }}
            >
              {(() => {
                const Icon = META[notice.kind].Icon
                return <Icon className="h-5 w-5 mt-0.5 shrink-0" style={{ color: META[notice.kind].color }} />
              })()}
              <div className="flex-1 min-w-0">
                <div className="font-[family-name:var(--font-display)] font-bold text-base mb-1">
                  {notice.title}
                </div>
                {notice.message && (
                  <div className="text-sm text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
                    {notice.message}
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                className="text-[var(--color-text-muted)] hover:text-white transition"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex justify-end border-t border-[var(--color-border)] px-6 py-3">
              <button onClick={onClose} className="btn-primary text-xs px-4 py-1.5">
                OK
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

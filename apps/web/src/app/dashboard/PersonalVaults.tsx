'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Pause, Play, RefreshCw, Trash2, Copy, Check, Settings } from 'lucide-react'
import { api } from '@/lib/api'
import { useCallback } from 'react'

function shortenMint(mint: string) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
      title="Copy address"
    >
      {copied ? <Check className="h-3 w-3 text-[#00D62B]" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

export function PersonalVaults() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editingVault, setEditingVault] = useState<string | null>(null)
  const [mintInput, setMintInput] = useState('')
  const [intervalHours, setIntervalHours] = useState(2)
  const [editMints, setEditMints] = useState<string[]>([])
  const [editInterval, setEditInterval] = useState(2)

  const { data: vaultsRes, isLoading } = useQuery({
    queryKey: ['custom-vaults'],
    queryFn: () => api.getCustomVaults(),
  })
  const vaults = vaultsRes?.data ?? []

  const createMut = useMutation({
    mutationFn: (args: { mints: string[]; interval: number }) =>
      api.createCustomVault(args.mints, args.interval),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-vaults'] })
      setShowCreate(false)
      setMintInput('')
      setIntervalHours(2)
    },
  })

  const pauseMut = useMutation({
    mutationFn: (id: string) => api.pauseCustomVault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['custom-vaults'] }),
  })

  const resumeMut = useMutation({
    mutationFn: (id: string) => api.resumeCustomVault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['custom-vaults'] }),
  })

  const rebalanceMut = useMutation({
    mutationFn: (id: string) => api.rebalanceCustomVault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['custom-vaults'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteCustomVault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['custom-vaults'] }),
  })

  const updateMut = useMutation({
    mutationFn: (args: { id: string; tokenMints: string[]; rebalanceIntervalSec: number }) =>
      api.updateCustomVault(args.id, {
        tokenMints: args.tokenMints,
        rebalanceIntervalSec: args.rebalanceIntervalSec,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-vaults'] })
      setEditingVault(null)
    },
  })

  function parseMints(raw: string): string[] {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 32 && s.length <= 44)
  }

  function handleCreate() {
    const mints = parseMints(mintInput)
    if (mints.length === 0) return
    createMut.mutate({ mints, interval: intervalHours * 3600 })
  }

  function startEdit(vault: any) {
    setEditingVault(vault.id)
    setEditMints(vault.tokenMints)
    setEditInterval(vault.rebalanceIntervalSec / 3600)
  }

  function handleUpdate(id: string) {
    if (editMints.length === 0) return
    updateMut.mutate({ id, tokenMints: editMints, rebalanceIntervalSec: editInterval * 3600 })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
      className="mb-8"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
          Personal Vaults
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold uppercase hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <Plus className="h-3 w-3" />
          New Vault
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card mb-4 space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs font-bold uppercase text-[var(--color-text-muted)]">
              Token Mints (one per line or comma-separated)
            </label>
            <textarea
              value={mintInput}
              onChange={(e) => setMintInput(e.target.value)}
              rows={4}
              placeholder="So11111111111111111111111111111111111111112&#10;EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm font-[family-name:var(--font-mono)] placeholder:text-[var(--color-text-muted)]/50"
            />
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {parseMints(mintInput).length} valid mint(s) detected · 10% BAGSX auto-pinned
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold uppercase text-[var(--color-text-muted)]">
              Rebalance Interval
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={2}
                max={168}
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm"
              />
              <span className="text-xs text-[var(--color-text-muted)]">hours (min 2h)</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={parseMints(mintInput).length === 0 || createMut.isPending}
              className="rounded bg-[var(--color-accent)] px-4 py-2 text-xs font-bold uppercase text-black disabled:opacity-50"
            >
              {createMut.isPending ? 'Creating…' : 'Create Vault'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded border border-[var(--color-border)] px-4 py-2 text-xs font-bold uppercase hover:bg-[var(--color-bg-hover)]"
            >
              Cancel
            </button>
          </div>
          {createMut.isError && (
            <p className="text-xs text-red-400">{(createMut.error as Error).message}</p>
          )}
        </div>
      )}

      {/* Vault list */}
      {isLoading ? (
        <div className="card p-8 text-center text-[var(--color-text-muted)]">Loading…</div>
      ) : vaults.length === 0 && !showCreate ? (
        <div className="card p-8 text-center text-[var(--color-text-muted)]">
          No personal vaults yet — create one to build your own index
        </div>
      ) : (
        <div className="space-y-3">
          {vaults.map((v: any) => {
            const holdings = v.subWallet?.holdings ?? []
            const totalValue = holdings.reduce(
              (s: number, h: any) => s + Number(h.valueSolEst || 0),
              0,
            )
            const isEditing = editingVault === v.id

            return (
              <div key={v.id} className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        background: v.status === 'ACTIVE' ? '#00D62B' : '#F59E0B',
                      }}
                    />
                    <div>
                      <div className="text-sm font-bold">
                        Vault {v.id.slice(0, 6)} · {v.tokenMints.length} tokens
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                        <span>{v.subWallet?.address ? shortenMint(v.subWallet.address) : '—'}</span>
                        {v.subWallet?.address && <CopyButton text={v.subWallet.address} />}
                        <span>· every {v.rebalanceIntervalSec / 3600}h</span>
                        {v.lastRebalancedAt && (
                          <span>
                            · last {new Date(v.lastRebalancedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => (isEditing ? setEditingVault(null) : startEdit(v))}
                      className="rounded p-1.5 hover:bg-[var(--color-bg-hover)]"
                      title="Edit"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                    {v.status === 'ACTIVE' ? (
                      <button
                        onClick={() => pauseMut.mutate(v.id)}
                        disabled={pauseMut.isPending}
                        className="rounded p-1.5 hover:bg-[var(--color-bg-hover)]"
                        title="Pause"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => resumeMut.mutate(v.id)}
                        disabled={resumeMut.isPending}
                        className="rounded p-1.5 hover:bg-[var(--color-bg-hover)]"
                        title="Resume"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => rebalanceMut.mutate(v.id)}
                      disabled={rebalanceMut.isPending}
                      className="rounded p-1.5 hover:bg-[var(--color-bg-hover)]"
                      title="Rebalance now"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${rebalanceMut.isPending ? 'animate-spin' : ''}`}
                      />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Delete this vault? Holdings will remain until withdrawn.')) {
                          deleteMut.mutate(v.id)
                        }
                      }}
                      disabled={deleteMut.isPending}
                      className="rounded p-1.5 text-red-400 hover:bg-red-400/10"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
                    <div>
                      <label className="mb-1 block text-[10px] font-bold uppercase text-[var(--color-text-muted)]">
                        Token Mints
                      </label>
                      <textarea
                        value={editMints.join('\n')}
                        onChange={(e) => setEditMints(parseMints(e.target.value))}
                        rows={3}
                        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs font-[family-name:var(--font-mono)]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={2}
                        max={168}
                        value={editInterval}
                        onChange={(e) => setEditInterval(Number(e.target.value))}
                        className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs"
                      />
                      <span className="text-[10px] text-[var(--color-text-muted)]">hours</span>
                      <button
                        onClick={() => handleUpdate(v.id)}
                        disabled={updateMut.isPending}
                        className="ml-auto rounded bg-[var(--color-accent)] px-3 py-1 text-[10px] font-bold uppercase text-black"
                      >
                        {updateMut.isPending ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Holdings */}
                <div className="px-4 py-3">
                  {holdings.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Send SOL to the vault address above to fund it. The rebalancer will buy tokens on the next cycle.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="mb-2 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
                        <span>{holdings.length} holdings</span>
                        <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-primary)]">
                          {totalValue.toFixed(4)} SOL
                        </span>
                      </div>
                      {holdings.map((h: any) => (
                        <div
                          key={h.tokenMint}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="font-[family-name:var(--font-mono)] text-[var(--color-text-muted)]">
                            {shortenMint(h.tokenMint)}
                          </span>
                          <span className="font-[family-name:var(--font-mono)]">
                            {Number(h.valueSolEst || 0).toFixed(4)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

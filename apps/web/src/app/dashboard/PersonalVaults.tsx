'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usePrivy } from '@privy-io/react-auth'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Trash2, Settings, Pause, Play } from 'lucide-react'
import { TierHoldingsCard, TIER_COLORS } from '@/components/TierHoldingsCard'
import { api } from '@/lib/api'

const VAULT_COLOR = {
  bg: 'rgba(251, 191, 36, 0.06)',
  border: 'rgba(251, 191, 36, 0.35)',
  text: '#fbbf24',
  chip: '#f59e0b',
}

function parseMints(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 32 && s.length <= 44)
}

export function PersonalVaults() {
  const { authenticated } = usePrivy()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editingVault, setEditingVault] = useState<string | null>(null)
  const [mintInput, setMintInput] = useState('')
  const [intervalHours, setIntervalHours] = useState(2)
  const [editMintsRaw, setEditMintsRaw] = useState('')
  const [editInterval, setEditInterval] = useState(2)
  const [liquidatingKey, setLiquidatingKey] = useState<string | null>(null)
  const [sellResult, setSellResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const { data: vaultsRes, isLoading, isError } = useQuery({
    queryKey: ['custom-vaults'],
    queryFn: () => api.getCustomVaults(),
    enabled: authenticated,
    retry: 2,
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

  const [tpPending, setTpPending] = useState<string | null>(null)

  async function handleSetAutoTp(vaultId: string, pct: number) {
    setTpPending(`PERSONAL:${pct}`)
    try {
      await api.setCustomVaultAutoTp(vaultId, pct)
      queryClient.invalidateQueries({ queryKey: ['custom-vaults'] })
    } finally {
      setTpPending(null)
    }
  }

  async function handleLiquidateHolding(mint: string, vaultId: string) {
    setLiquidatingKey(`PERSONAL:${mint}`)
    setSellResult(null)
    try {
      await api.liquidateCustomVaultHolding(vaultId, mint)
      queryClient.invalidateQueries({ queryKey: ['custom-vaults'] })
      setSellResult({ ok: true, msg: 'Sell queued — SOL will return to your wallet shortly.' })
    } catch (err: any) {
      setSellResult({ ok: false, msg: err?.message ?? 'Sell failed' })
    } finally {
      setLiquidatingKey(null)
      setTimeout(() => setSellResult(null), 5000)
    }
  }

  function handleCreate() {
    const mints = parseMints(mintInput)
    if (mints.length === 0) return
    createMut.mutate({ mints, interval: intervalHours * 3600 })
  }

  function startEdit(vault: any) {
    setEditingVault(vault.id)
    setEditMintsRaw(vault.tokenMints.join('\n'))
    setEditInterval(vault.rebalanceIntervalSec / 3600)
  }

  function handleUpdate(id: string) {
    const mints = parseMints(editMintsRaw)
    if (mints.length === 0) return
    updateMut.mutate({ id, tokenMints: mints, rebalanceIntervalSec: editInterval * 3600 })
  }

  // Register the custom vault color so TierHoldingsCard can use it
  if (!TIER_COLORS['PERSONAL']) {
    TIER_COLORS['PERSONAL'] = VAULT_COLOR
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

      {sellResult && (
        <div className={`mb-3 rounded-lg px-4 py-2.5 text-xs font-medium ${sellResult.ok ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'bg-red-500/10 text-red-400'}`}>
          {sellResult.msg}
        </div>
      )}

      {/* Vault list */}
      {isLoading ? (
        <div className="card p-8 text-center text-[var(--color-text-muted)]">Loading…</div>
      ) : isError ? (
        <div className="card p-8 text-center text-red-400">Failed to load vaults — try refreshing</div>
      ) : vaults.length === 0 && !showCreate ? (
        <div className="card p-8 text-center text-[var(--color-text-muted)]">
          No personal vaults yet — create one to build your own index
        </div>
      ) : (
        <div className="space-y-4">
          {vaults.map((v: any) => {
            const holdings = (v.subWallet?.holdings ?? []).map((h: any) => {
              const totalVal = (v.subWallet?.holdings ?? []).reduce(
                (s: number, x: any) => s + Number(x.valueSolEst || 0),
                0,
              )
              const val = Number(h.valueSolEst || 0)
              return {
                tokenMint: h.tokenMint,
                tokenSymbol: h.tokenSymbol ?? null,
                marketCapUsd: h.marketCapUsd ?? 0,
                amount: h.amount,
                valueSol: val,
                allocationPct: totalVal > 0 ? ((val / totalVal) * 100).toFixed(2) : '0',
              }
            })
            const nativeSol = Number(v.subWallet?.nativeSol ?? 0)
            const totalValue = holdings.reduce(
              (s: number, h: any) => s + Number(h.valueSol),
              0,
            ) + nativeSol
            const isEditing = editingVault === v.id
            const autoTpPct = v.subWallet?.autoTakeProfitPct ?? 0

            return (
              <div key={v.id} className="space-y-0">
                {/* Vault management bar */}
                <div className="flex items-center justify-between rounded-t-2xl border border-b-0 px-4 py-2"
                  style={{ borderColor: VAULT_COLOR.border, background: VAULT_COLOR.bg }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ background: v.status === 'ACTIVE' ? '#00D62B' : '#F59E0B' }}
                    />
                    <span className="text-xs font-bold" style={{ color: VAULT_COLOR.text }}>
                      Vault {v.id.slice(0, 6)} · {v.tokenMints.length} tokens · every {v.rebalanceIntervalSec / 3600}h
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => (isEditing ? setEditingVault(null) : startEdit(v))}
                      className="rounded p-1.5 hover:bg-white/10"
                      title="Edit tokens/interval"
                    >
                      <Settings className="h-3.5 w-3.5" style={{ color: VAULT_COLOR.text }} />
                    </button>
                    {v.status === 'ACTIVE' ? (
                      <button
                        onClick={() => pauseMut.mutate(v.id)}
                        disabled={pauseMut.isPending}
                        className="rounded p-1.5 hover:bg-white/10"
                        title="Pause auto-rebalance"
                      >
                        <Pause className="h-3.5 w-3.5" style={{ color: VAULT_COLOR.text }} />
                      </button>
                    ) : (
                      <button
                        onClick={() => resumeMut.mutate(v.id)}
                        disabled={resumeMut.isPending}
                        className="rounded p-1.5 hover:bg-white/10"
                        title="Resume auto-rebalance"
                      >
                        <Play className="h-3.5 w-3.5" style={{ color: VAULT_COLOR.text }} />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm('Delete this vault? Holdings will remain until withdrawn.')) {
                          deleteMut.mutate(v.id)
                        }
                      }}
                      disabled={deleteMut.isPending}
                      className="rounded p-1.5 text-red-400 hover:bg-red-400/10"
                      title="Delete vault"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="border-x border-b-0 px-4 py-3 space-y-3"
                    style={{ borderColor: VAULT_COLOR.border, background: 'rgba(251,191,36,0.03)' }}
                  >
                    <div>
                      <label className="mb-1 block text-[10px] font-bold uppercase text-[var(--color-text-muted)]">
                        Token Mints
                      </label>
                      <textarea
                        value={editMintsRaw}
                        onChange={(e) => setEditMintsRaw(e.target.value)}
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
                        className="ml-auto rounded px-3 py-1 text-[10px] font-bold uppercase text-black"
                        style={{ background: VAULT_COLOR.chip }}
                      >
                        {updateMut.isPending ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}

                {/* TierHoldingsCard for the vault */}
                {holdings.length === 0 ? (
                  <div
                    className="rounded-b-2xl border px-5 py-6 text-center text-xs text-[var(--color-text-muted)]"
                    style={{ borderColor: VAULT_COLOR.border, background: VAULT_COLOR.bg }}
                  >
                    Send SOL to the vault address to fund it. The rebalancer will buy tokens on the next cycle.
                  </div>
                ) : (
                  <div className={isEditing ? '' : '-mt-px'}>
                    <TierHoldingsCard
                      tier={{
                        riskTier: 'PERSONAL',
                        walletAddress: v.subWallet?.address,
                        totalValueSol: totalValue,
                        nativeSol,
                        holdings,
                      }}
                      forceReshuffle={{
                        onClick: () => rebalanceMut.mutate(v.id),
                        pending: rebalanceMut.isPending,
                        message: rebalanceMut.isSuccess ? 'Queued' : undefined,
                      }}
                      autoTp={{
                        value: autoTpPct,
                        onChange: (_tier, pct) => handleSetAutoTp(v.id, pct),
                        pending: tpPending,
                      }}
                      onLiquidateHolding={(mint, _tier, _sym, _val) => handleLiquidateHolding(mint, v.id)}
                      liquidatingKey={liquidatingKey}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

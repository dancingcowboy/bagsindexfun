'use client'

import { useCallback, useState } from 'react'
import { Copy, Check, RefreshCw } from 'lucide-react'
import { BAGSX_MINT } from '@bags-index/shared'

// Per-tier colour tokens. Shared between the user dashboard and the admin
// vault view so both surfaces render holdings with identical styling.
export const TIER_COLORS: Record<
  string,
  { bg: string; border: string; text: string; chip: string }
> = {
  CONSERVATIVE: {
    bg: 'rgba(56, 189, 248, 0.06)',
    border: 'rgba(56, 189, 248, 0.35)',
    text: '#7dd3fc',
    chip: '#0ea5e9',
  },
  BALANCED: {
    bg: 'rgba(168, 85, 247, 0.06)',
    border: 'rgba(168, 85, 247, 0.35)',
    text: '#c084fc',
    chip: '#a855f7',
  },
  DEGEN: {
    bg: 'rgba(244, 114, 182, 0.06)',
    border: 'rgba(244, 114, 182, 0.35)',
    text: '#f9a8d4',
    chip: '#ec4899',
  },
}

export interface TierHolding {
  tokenMint: string
  tokenSymbol: string | null
  amount: number | string
  valueSol: number | string
  allocationPct: number | string
  marketCapUsd?: number
}

export interface TierCardData {
  riskTier: string
  walletAddress?: string
  totalValueSol: number | string
  nativeSol?: number | string
  holdings: TierHolding[]
}

export interface TierHoldingsCardProps {
  tier: TierCardData
  /** Controls whether the Force Reshuffle button is rendered. */
  forceReshuffle?: {
    onClick: (tier: string) => void
    pending: boolean
    message?: string
  }
  /** Controls whether the Auto Take-Profit row is rendered. */
  autoTp?: {
    value: number
    onChange: (tier: string, pct: number) => void
    pending: string | null
  }
  /** Per-holding sell action — hidden when omitted. */
  onLiquidateHolding?: (
    mint: string,
    tier: string,
    sym: string | null,
    valueSol: number,
  ) => void
  /** Key ("TIER:mint") of the holding currently being liquidated. */
  liquidatingKey?: string | null
}

function formatMarketCap(mc: number): string {
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`
  return `$${mc.toFixed(0)}`
}

function CopyCAButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(mint)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [mint])
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        copy()
      }}
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

/**
 * Tier holdings card used on both the user dashboard and the admin vault
 * view. Takes a normalized tier payload plus optional action callbacks so
 * the same visual renders for user sub-wallets and the protocol vault.
 */
export function TierHoldingsCard({
  tier,
  forceReshuffle,
  autoTp,
  onLiquidateHolding,
  liquidatingKey,
}: TierHoldingsCardProps) {
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const copyAddr = useCallback((addr: string) => {
    navigator.clipboard.writeText(addr)
    setCopiedAddr(addr)
    setTimeout(() => setCopiedAddr(null), 2000)
  }, [])

  const c = TIER_COLORS[tier.riskTier] ?? TIER_COLORS.BALANCED
  const tierHoldings = tier.holdings ?? []
  const nativeSol = Number(tier.nativeSol ?? 0)
  const tierValue = Number(tier.totalValueSol ?? 0)
  const addr = tier.walletAddress

  return (
    <div
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
            {tier.riskTier}
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
              title="Copy full address"
            >
              {copiedAddr === addr ? (
                <Check className="h-3 w-3" style={{ color: c.text }} />
              ) : (
                <Copy className="h-3 w-3 text-[var(--color-text-muted)]" />
              )}
            </button>
          </div>
        )}
        {forceReshuffle && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => forceReshuffle.onClick(tier.riskTier)}
              disabled={forceReshuffle.pending}
              className="rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{ borderColor: c.border, color: c.text }}
              title="Sell anything no longer in the top-10 and rebuy current ranking. 1-hour cooldown."
            >
              <RefreshCw
                className={`mr-1 inline h-3 w-3 ${
                  forceReshuffle.pending ? 'animate-spin' : ''
                }`}
              />
              {forceReshuffle.pending ? 'Queuing…' : 'Force Reshuffle'}
            </button>
            {forceReshuffle.message && (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {forceReshuffle.message}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Auto Take-Profit presets — 0% = full compound (default). */}
      {autoTp && (
        <div
          className="px-5 py-3 text-xs"
          style={{ borderBottom: `1px solid ${c.border}` }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="uppercase tracking-wider text-[var(--color-text-muted)]">
              Auto Take-Profit
            </span>
            <span
              className="font-[family-name:var(--font-mono)]"
              style={{ color: c.text }}
            >
              {autoTp.value}%
            </span>
          </div>
          <div className="flex gap-1">
            {[0, 25, 50, 75, 100].map((pct) => {
              const isCurrent = autoTp.value === pct
              const isBusy = autoTp.pending === `${tier.riskTier}:${pct}`
              return (
                <button
                  key={pct}
                  type="button"
                  disabled={autoTp.pending !== null}
                  onClick={() => autoTp.onChange(tier.riskTier, pct)}
                  className={`flex-1 rounded-md border px-2 py-1 font-semibold transition-colors disabled:opacity-50 ${
                    isCurrent ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  style={{ borderColor: c.border, color: c.text }}
                >
                  {isBusy ? '…' : pct === 0 ? 'Off' : `${pct}%`}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            After each scheduled rebalance, {autoTp.value}% of any SOL surplus
            is sent to your connected wallet. 0% = compound.
          </p>
        </div>
      )}

      {/* Mobile card layout */}
      <div className="md:hidden divide-y" style={{ borderColor: c.border }}>
        {tierHoldings.map((h) => (
          <div
            key={`${tier.riskTier}:${h.tokenMint}:m`}
            className="px-4 py-3 space-y-2"
            style={{ borderColor: c.border }}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">
                    {h.tokenSymbol ?? '—'}
                  </span>
                  {(h.marketCapUsd ?? 0) > 0 && (
                    <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                      {formatMarketCap(h.marketCapUsd ?? 0)}
                    </span>
                  )}
                </div>
                <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                  {h.tokenMint.slice(0, 6)}…{h.tokenMint.slice(-4)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-[family-name:var(--font-mono)] text-sm">
                  {Number(h.valueSol).toFixed(4)} SOL
                </div>
                <span
                  className="font-[family-name:var(--font-mono)] text-xs"
                  style={{ color: c.text }}
                >
                  {h.allocationPct}%
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/30">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Number(h.allocationPct)}%`,
                    background: c.chip,
                  }}
                />
              </div>
              <div className="flex items-center gap-1">
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
                {onLiquidateHolding && h.tokenMint !== BAGSX_MINT && (
                  <button
                    type="button"
                    disabled={
                      liquidatingKey === `${tier.riskTier}:${h.tokenMint}`
                    }
                    onClick={() =>
                      onLiquidateHolding(
                        h.tokenMint,
                        tier.riskTier,
                        h.tokenSymbol ?? null,
                        Number(h.valueSol),
                      )
                    }
                    title="Sell this position"
                    className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-text-muted)] hover:text-red-400 hover:border-red-400/50 transition-colors disabled:opacity-50"
                  >
                    {liquidatingKey === `${tier.riskTier}:${h.tokenMint}`
                      ? '…'
                      : 'sell'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {nativeSol > 0.001 && (
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ borderColor: c.border }}
          >
            <div>
              <div className="font-semibold text-sm text-[var(--color-text-muted)]">
                SOL
              </div>
              <div className="text-[10px] text-[var(--color-text-muted)]">
                gas reserve
              </div>
            </div>
            <div className="font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
              {nativeSol.toFixed(4)} SOL
            </div>
          </div>
        )}
      </div>

      {/* Desktop table layout */}
      <table className="hidden md:table w-full">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            <th className="px-5 py-2 text-left font-medium">Token</th>
            <th className="px-5 py-2 text-right font-medium">MC</th>
            <th className="px-5 py-2 text-center font-medium">Links</th>
            <th className="px-5 py-2 text-right font-medium">Amount</th>
            <th className="px-5 py-2 text-right font-medium">Value (SOL)</th>
            <th className="px-5 py-2 text-right font-medium">Allocation</th>
            <th className="px-5 py-2 text-right font-medium" />
          </tr>
        </thead>
        <tbody>
          {tierHoldings.map((h) => (
            <tr
              key={`${tier.riskTier}:${h.tokenMint}`}
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
                {(h.marketCapUsd ?? 0) > 0
                  ? formatMarketCap(h.marketCapUsd ?? 0)
                  : '—'}
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
                        width: `${Number(h.allocationPct)}%`,
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
              <td className="px-5 py-3 text-right">
                {onLiquidateHolding && h.tokenMint !== BAGSX_MINT && (
                  <button
                    type="button"
                    disabled={
                      liquidatingKey === `${tier.riskTier}:${h.tokenMint}`
                    }
                    onClick={() =>
                      onLiquidateHolding(
                        h.tokenMint,
                        tier.riskTier,
                        h.tokenSymbol ?? null,
                        Number(h.valueSol),
                      )
                    }
                    title="Sell this position"
                    className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-red-400 hover:border-red-400/50 transition-colors disabled:opacity-50"
                  >
                    {liquidatingKey === `${tier.riskTier}:${h.tokenMint}`
                      ? '…'
                      : 'Sell'}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {nativeSol > 0.001 && (
            <tr
              className="border-t hover:bg-white/[0.02]"
              style={{ borderColor: c.border }}
            >
              <td className="px-5 py-3 text-sm">
                <div className="font-semibold text-[var(--color-text-muted)]">
                  SOL
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  gas reserve
                </div>
              </td>
              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)]">
                —
              </td>
              <td className="px-5 py-3" />
              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                {nativeSol.toFixed(4)}
              </td>
              <td className="px-5 py-3 text-right font-[family-name:var(--font-mono)] text-sm text-[var(--color-text-muted)]">
                {nativeSol.toFixed(4)}
              </td>
              <td className="px-5 py-3" />
              <td className="px-5 py-3" />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

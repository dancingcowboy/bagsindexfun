import { db } from '@bags-index/db'
import { SOL_MINT, BAGSX_MINT, LAMPORTS_PER_SOL } from '@bags-index/shared'
import type { RiskTier } from '@bags-index/shared'
import { postToUserTelegram } from './telegram.js'
import { buildUserPortfolioSummary } from './portfolio-summary.js'

async function getUserForNotify(userId: string) {
  return db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramChatId: true,
      telegramNotifyEnabled: true,
      walletAddress: true,
    },
  })
}

/**
 * Attempt a DM send. If Telegram responds 403 (user blocked the bot or
 * cleared the chat), auto-disable notifications for this user so we stop
 * retrying on every cycle.
 */
async function send(userId: string, chatId: bigint, text: string) {
  const res = await postToUserTelegram(chatId, text)
  if (res.blocked) {
    await db.user
      .update({
        where: { id: userId },
        data: { telegramChatId: null, telegramNotifyEnabled: false },
      })
      .catch((err) => console.error('[telegram/dm] auto-disable failed', err))
    console.warn(`[telegram/dm] user ${userId.slice(0, 8)} blocked — auto-disabled`)
  }
}

function symbolOrShort(mint: string, sym: string | null | undefined): string {
  if (sym) return sym
  if (mint === SOL_MINT) return 'SOL'
  if (mint === BAGSX_MINT) return 'BAGSX'
  return `${mint.slice(0, 4)}…`
}

async function tokenSymbols(mints: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (mints.length === 0) return out
  const rows = await db.tokenScore.findMany({
    where: { tokenMint: { in: mints }, source: 'BAGS' },
    orderBy: { scoredAt: 'desc' },
    select: { tokenMint: true, tokenSymbol: true },
  })
  for (const r of rows) if (!out.has(r.tokenMint)) out.set(r.tokenMint, r.tokenSymbol)
  return out
}

function formatTierDetail(
  tier: RiskTier,
  summary: Awaited<ReturnType<typeof buildUserPortfolioSummary>>,
  maxLines = 10,
): string {
  const t = summary.tiers.find((x) => x.riskTier === tier)
  if (!t || t.holdings.length === 0) return `${tier}: 0 SOL (empty)`
  const lines = t.holdings.slice(0, maxLines).map((h) => {
    const sym = symbolOrShort(h.tokenMint, h.tokenSymbol)
    return `• ${sym} ${h.valueSol.toFixed(3)} SOL`
  })
  const extra = t.holdings.length - maxLines
  const more = extra > 0 ? `\n• …+${extra} more` : ''
  return `<b>${tier}: ${t.totalValueSol.toFixed(3)} SOL</b> (${t.holdings.length} holdings)\n${lines.join('\n')}${more}`
}

function formatOthersLine(
  affectedTier: RiskTier,
  summary: Awaited<ReturnType<typeof buildUserPortfolioSummary>>,
): string {
  const others = summary.tiers
    .filter((t) => t.riskTier !== affectedTier)
    .map((t) => `${t.riskTier} ${t.totalValueSol.toFixed(2)} SOL`)
  const line = others.length > 0 ? `Other: ${others.join(' · ')} · ` : ''
  return `${line}Total ${summary.totalValueSol.toFixed(2)} SOL`
}

export async function notifyRebalance(params: {
  userId: string
  walletId: string
  riskTier: RiskTier
  rebalanceCycleId: string
  trigger: string
}) {
  try {
    const user = await getUserForNotify(params.userId)
    if (!user?.telegramChatId || !user.telegramNotifyEnabled) return

    const swaps = await db.swapExecution.findMany({
      where: {
        rebalanceCycleId: params.rebalanceCycleId,
        subWalletId: params.walletId,
        status: 'CONFIRMED',
      },
      select: {
        inputMint: true,
        outputMint: true,
        inputAmount: true,
        outputAmount: true,
      },
    })
    if (swaps.length === 0) return // nothing meaningful to report

    const mints = new Set<string>()
    for (const s of swaps) {
      if (s.inputMint !== SOL_MINT) mints.add(s.inputMint)
      if (s.outputMint !== SOL_MINT) mints.add(s.outputMint)
    }
    const syms = await tokenSymbols([...mints])

    const sells: string[] = []
    const buys: string[] = []
    for (const s of swaps) {
      if (s.outputMint === SOL_MINT) {
        const sol = Number(s.outputAmount ?? 0n) / LAMPORTS_PER_SOL
        const sym = symbolOrShort(s.inputMint, syms.get(s.inputMint))
        sells.push(`• ${sol.toFixed(3)} SOL  ←  ${sym}`)
      } else if (s.inputMint === SOL_MINT) {
        const sol = Number(s.inputAmount) / LAMPORTS_PER_SOL
        const sym = symbolOrShort(s.outputMint, syms.get(s.outputMint))
        buys.push(`• ${sol.toFixed(3)} SOL  →  ${sym}`)
      }
    }

    const summary = await buildUserPortfolioSummary(params.userId)
    const triggerTag = params.trigger === 'USER_FORCE' ? ' (force reshuffle)' : ''

    const parts: string[] = [`🔄 <b>Rebalance complete — ${params.riskTier}</b>${triggerTag}`, '']
    if (sells.length > 0) parts.push('<b>Sold:</b>', ...sells, '')
    if (buys.length > 0) parts.push('<b>Bought:</b>', ...buys, '')
    parts.push(formatTierDetail(params.riskTier, summary), '', formatOthersLine(params.riskTier, summary))

    await send(params.userId, user.telegramChatId, parts.join('\n'))
  } catch (err) {
    console.error('[telegram/dm] notifyRebalance failed', err)
  }
}

export async function notifyDeposit(params: {
  userId: string
  depositId: string
  riskTier: RiskTier
}) {
  try {
    const user = await getUserForNotify(params.userId)
    if (!user?.telegramChatId || !user.telegramNotifyEnabled) return

    const dep = await db.deposit.findUnique({
      where: { id: params.depositId },
      select: { amountSol: true, feeSol: true, status: true },
    })
    if (!dep) return

    const summary = await buildUserPortfolioSummary(params.userId)
    const net = Number(dep.amountSol) - Number(dep.feeSol)

    const parts: string[] = [
      `💰 <b>Deposit complete — ${params.riskTier}</b>`,
      `+${net.toFixed(3)} SOL deployed (fee ${Number(dep.feeSol).toFixed(4)} SOL)`,
      '',
      formatTierDetail(params.riskTier, summary),
      '',
      formatOthersLine(params.riskTier, summary),
    ]
    await send(params.userId, user.telegramChatId, parts.join('\n'))
  } catch (err) {
    console.error('[telegram/dm] notifyDeposit failed', err)
  }
}

export async function notifyWithdrawal(params: {
  userId: string
  withdrawalId: string
  riskTier: RiskTier
}) {
  try {
    const user = await getUserForNotify(params.userId)
    if (!user?.telegramChatId || !user.telegramNotifyEnabled) return

    const w = await db.withdrawal.findUnique({
      where: { id: params.withdrawalId },
      select: { amountSol: true, feeSol: true, status: true, source: true, txSignature: true },
    })
    if (!w) return

    const summary = await buildUserPortfolioSummary(params.userId)
    const statusTag = w.status === 'CONFIRMED' ? '✅' : w.status === 'PARTIAL' ? '⚠️' : '❌'
    const header =
      w.source === 'AUTO_TP'
        ? `💸 <b>Auto take-profit — ${params.riskTier}</b> ${statusTag}`
        : `💸 <b>Withdrawal ${w.status.toLowerCase()} — ${params.riskTier}</b> ${statusTag}`
    const net = Number(w.amountSol) - Number(w.feeSol)

    const parts: string[] = [
      header,
      `-${net.toFixed(3)} SOL sent (fee ${Number(w.feeSol).toFixed(4)} SOL)`,
      '',
      formatTierDetail(params.riskTier, summary),
      '',
      formatOthersLine(params.riskTier, summary),
    ]
    await send(params.userId, user.telegramChatId, parts.join('\n'))
  } catch (err) {
    console.error('[telegram/dm] notifyWithdrawal failed', err)
  }
}

import { db } from '@bags-index/db'
import type { RiskTier } from '@bags-index/shared'
import { BAGSX_MINT, RISK_TIERS } from '@bags-index/shared'
import { sendMessage, editMessageText, answerCallbackQuery } from './telegram-api.js'
import type { InlineKeyboard } from './telegram-api.js'
import { rebalanceQueue, withdrawalQueue } from '../queue/queues.js'

// ── Tier helpers ────────────────────────────────────────────────────
const TIER_FROM: Record<string, RiskTier> = { C: 'CONSERVATIVE', B: 'BALANCED', D: 'DEGEN' }
const TIER_TO: Record<string, string> = { CONSERVATIVE: 'C', BALANCED: 'B', DEGEN: 'D' }
const TIER_LABEL: Record<string, string> = { CONSERVATIVE: 'Conservative', BALANCED: 'Balanced', DEGEN: 'Degen' }

function btn(text: string, data: string) { return { text, callback_data: data } }
function urlBtn(text: string, url: string) { return { text, url } }
function backRow(data: string) { return [btn('« Back', data)] }

// ── Portfolio summary (mirrors worker/src/lib/portfolio-summary.ts) ─
interface SummaryHolding { tokenMint: string; tokenSymbol: string | null; valueSol: number }
interface SummaryTier {
  riskTier: RiskTier; walletAddress: string; totalValueSol: number
  costBasisSol: number; realizedPnlSol: number; unrealizedPnlSol: number
  totalPnlSol: number; holdings: SummaryHolding[]
}
interface PortfolioSummary {
  tiers: SummaryTier[]; totalValueSol: number; totalCostBasisSol: number
  totalRealizedPnlSol: number; totalUnrealizedPnlSol: number; totalPnlSol: number
}

async function getPortfolio(userId: string): Promise<PortfolioSummary> {
  const wallets = await db.subWallet.findMany({ where: { userId }, include: { holdings: true } })
  const mints = new Set<string>()
  for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
  const scores = mints.size
    ? await db.tokenScore.findMany({
        where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
        orderBy: { scoredAt: 'desc' },
        select: { tokenMint: true, tokenSymbol: true },
      })
    : []
  const sym = new Map<string, string | null>()
  for (const s of scores) if (!sym.has(s.tokenMint)) sym.set(s.tokenMint, s.tokenSymbol)

  const tiers: SummaryTier[] = wallets.map((w) => {
    const holdings = w.holdings
      .map((h) => ({ tokenMint: h.tokenMint, tokenSymbol: sym.get(h.tokenMint) ?? null, valueSol: Number(h.valueSolEst ?? 0) }))
      .filter((h) => h.valueSol > 0)
      .sort((a, b) => b.valueSol - a.valueSol)
    const totalValueSol = holdings.reduce((s, h) => s + h.valueSol, 0)
    const costBasisSol = w.holdings.reduce((s, h) => s + Number(h.costBasisSol ?? 0), 0)
    const realizedPnlSol = Number(w.realizedPnlSol ?? 0)
    const unrealizedPnlSol = totalValueSol - costBasisSol
    return { riskTier: w.riskTier!, walletAddress: w.address, totalValueSol, costBasisSol, realizedPnlSol, unrealizedPnlSol, totalPnlSol: realizedPnlSol + unrealizedPnlSol, holdings }
  })
  return {
    tiers,
    totalValueSol: tiers.reduce((s, t) => s + t.totalValueSol, 0),
    totalCostBasisSol: tiers.reduce((s, t) => s + t.costBasisSol, 0),
    totalRealizedPnlSol: tiers.reduce((s, t) => s + t.realizedPnlSol, 0),
    totalUnrealizedPnlSol: tiers.reduce((s, t) => s + t.unrealizedPnlSol, 0),
    totalPnlSol: tiers.reduce((s, t) => s + t.totalPnlSol, 0),
  }
}

function signed(n: number, d = 4) { return (n >= 0 ? '+' : '') + n.toFixed(d) }
function mintShort(mint: string) { return mint.slice(0, 8) }

// ── Menu builders ───────────────────────────────────────────────────

function mainMenuKeyboard(): InlineKeyboard {
  return { inline_keyboard: [
    [btn('📊 Portfolio', 'p')],
    [btn('📋 All Positions', 'pos')],
    [btn('💧 Liquidate', 'liq'), btn('🔄 Reshuffle', 'rs')],
    [btn('💸 Withdrawal', 'wd')],
  ]}
}

function mainMenuText() {
  return '<b>Bags Index</b>\n\nWhat would you like to do?'
}

async function portfolioText(userId: string) {
  const p = await getPortfolio(userId)
  let text = '<b>📊 Portfolio Summary</b>\n\n'
  for (const t of p.tiers) {
    if (t.totalValueSol === 0 && t.holdings.length === 0) continue
    text += `<b>${TIER_LABEL[t.riskTier]}</b>: ${t.totalValueSol.toFixed(4)} SOL (${signed(t.totalPnlSol)})\n`
  }
  text += `\n<b>Total:</b> ${p.totalValueSol.toFixed(4)} SOL`
  text += `\nPnL: ${signed(p.totalPnlSol)} SOL`
  return text
}

async function positionsText(userId: string, tier: RiskTier) {
  const p = await getPortfolio(userId)
  const t = p.tiers.find((x) => x.riskTier === tier)
  if (!t || t.holdings.length === 0) return `<b>${TIER_LABEL[tier]}</b>\n\nNo positions.`

  const total = t.totalValueSol
  let text = `<b>📋 ${TIER_LABEL[tier]} Positions</b>\n`
  text += `Value: ${total.toFixed(4)} SOL | PnL: ${signed(t.totalPnlSol)}\n\n`
  for (const h of t.holdings) {
    const pct = total > 0 ? ((h.valueSol / total) * 100).toFixed(1) : '0.0'
    const sym = h.tokenSymbol ?? mintShort(h.tokenMint)
    text += `• <b>${sym}</b> — ${h.valueSol.toFixed(4)} SOL (${pct}%)\n`
  }
  return text
}

function positionsKeyboard(tier: RiskTier): InlineKeyboard {
  return { inline_keyboard: [
    ...positionsDexRows(tier),
    backRow('pos'),
  ]}
}

function positionsDexRows(_tier: RiskTier): { text: string; callback_data?: string; url?: string }[][] {
  // DexScreener links are added dynamically in handlePositionsTier
  return []
}

async function buildPositionsTierView(userId: string, tier: RiskTier) {
  const p = await getPortfolio(userId)
  const t = p.tiers.find((x) => x.riskTier === tier)
  const text = await positionsText(userId, tier)
  const rows: { text: string; callback_data?: string; url?: string }[][] = []
  if (t) {
    for (const h of t.holdings) {
      const sym = h.tokenSymbol ?? mintShort(h.tokenMint)
      rows.push([urlBtn(`📈 ${sym} on DexScreener`, `https://dexscreener.com/solana/${h.tokenMint}`)])
    }
  }
  rows.push(backRow('pos'))
  return { text, reply_markup: { inline_keyboard: rows } }
}

// ── Callback router ─────────────────────────────────────────────────

export async function handleMenuCommand(chatId: bigint) {
  const user = await db.user.findFirst({ where: { telegramChatId: chatId } })
  if (!user) {
    await sendMessage(chatId, '⚠️ Your Telegram is not linked. Link it from the dashboard first.')
    return
  }
  await sendMessage(chatId, mainMenuText(), mainMenuKeyboard())
}

export async function handleCallback(
  data: string,
  chatId: bigint,
  messageId: number,
  callbackQueryId: string,
) {
  const user = await db.user.findFirst({ where: { telegramChatId: chatId } })
  if (!user) {
    await answerCallbackQuery(callbackQueryId, 'Account not linked', true)
    return
  }
  const userId = user.id

  try {
    const parts = data.split(':')
    const action = parts[0]

    switch (action) {
      // ── Main menu ──
      case 'm':
        await editMessageText(chatId, messageId, mainMenuText(), mainMenuKeyboard())
        break

      // ── Portfolio ──
      case 'p': {
        const text = await portfolioText(userId)
        await editMessageText(chatId, messageId, text, { inline_keyboard: [backRow('m')] })
        break
      }

      // ── Positions ──
      case 'pos': {
        if (parts[1]) {
          const tier = TIER_FROM[parts[1]]
          if (!tier) break
          const view = await buildPositionsTierView(userId, tier)
          await editMessageText(chatId, messageId, view.text, view.reply_markup)
        } else {
          await editMessageText(chatId, messageId, '<b>📋 Positions</b>\n\nSelect a tier:', {
            inline_keyboard: [
              [btn('Conservative', 'pos:C'), btn('Balanced', 'pos:B'), btn('Degen', 'pos:D')],
              backRow('m'),
            ],
          })
        }
        break
      }

      // ── Liquidate ──
      case 'liq': {
        if (parts.length === 1) {
          // Pick tier
          await editMessageText(chatId, messageId, '<b>💧 Liquidate</b>\n\nSelect a tier:', {
            inline_keyboard: [
              [btn('Conservative', 'liq:C'), btn('Balanced', 'liq:B'), btn('Degen', 'liq:D')],
              backRow('m'),
            ],
          })
        } else if (parts.length === 2) {
          // Pick token
          const tier = TIER_FROM[parts[1]]
          if (!tier) break
          const p = await getPortfolio(userId)
          const t = p.tiers.find((x) => x.riskTier === tier)
          if (!t || t.holdings.length === 0) {
            await editMessageText(chatId, messageId, `<b>${TIER_LABEL[tier]}</b>\n\nNo positions to liquidate.`, {
              inline_keyboard: [backRow('liq')],
            })
            break
          }
          const rows = t.holdings
            .filter((h) => h.tokenMint !== BAGSX_MINT)
            .map((h) => {
              const sym = h.tokenSymbol ?? mintShort(h.tokenMint)
              return [btn(`${sym} — ${h.valueSol.toFixed(4)} SOL`, `liq:${parts[1]}:${mintShort(h.tokenMint)}`)]
            })
          rows.push(backRow('liq'))
          await editMessageText(chatId, messageId, `<b>💧 Liquidate — ${TIER_LABEL[tier]}</b>\n\nSelect token to sell:`, { inline_keyboard: rows })
        } else if (parts.length === 3) {
          // Confirm
          const tier = TIER_FROM[parts[1]]
          if (!tier) break
          const mintPrefix = parts[2]
          const holding = await findHolding(userId, tier, mintPrefix)
          if (!holding) {
            await answerCallbackQuery(callbackQueryId, 'Position not found', true)
            break
          }
          const sym = holding.tokenSymbol ?? mintShort(holding.tokenMint)
          await editMessageText(chatId, messageId,
            `<b>💧 Confirm Liquidation</b>\n\nSell <b>${sym}</b> from ${TIER_LABEL[tier]}?\nEstimated: ~${Number(holding.valueSolEst).toFixed(4)} SOL\n\nProceeds go to your connected wallet.`,
            { inline_keyboard: [[btn('✅ Yes, sell', `liqx:${parts[1]}:${mintPrefix}`), btn('❌ Cancel', 'liq')]] },
          )
        }
        break
      }

      // ── Liquidate execute ──
      case 'liqx': {
        const tier = TIER_FROM[parts[1]]
        if (!tier) break
        const mintPrefix = parts[2]
        const result = await executeLiquidate(userId, tier, mintPrefix)
        if (!result.success) {
          await editMessageText(chatId, messageId, `❌ ${result.error}`, { inline_keyboard: [backRow('m')] })
        } else {
          await editMessageText(chatId, messageId,
            `✅ Liquidation queued — ~${result.estimatedSol!.toFixed(4)} SOL\n\nYou'll get a notification when it's done.`,
          )
        }
        break
      }

      // ── Reshuffle ──
      case 'rs': {
        if (parts.length === 1) {
          await editMessageText(chatId, messageId, '<b>🔄 Force Reshuffle</b>\n\nSelect a tier:', {
            inline_keyboard: [
              [btn('Conservative', 'rs:C'), btn('Balanced', 'rs:B'), btn('Degen', 'rs:D')],
              backRow('m'),
            ],
          })
        } else {
          const tier = TIER_FROM[parts[1]]
          if (!tier) break
          await editMessageText(chatId, messageId,
            `<b>🔄 Confirm Reshuffle</b>\n\nForce reshuffle <b>${TIER_LABEL[tier]}</b>?\n1-hour cooldown applies.`,
            { inline_keyboard: [[btn('✅ Yes, reshuffle', `rsx:${parts[1]}`), btn('❌ Cancel', 'rs')]] },
          )
        }
        break
      }

      // ── Reshuffle execute ──
      case 'rsx': {
        const tier = TIER_FROM[parts[1]]
        if (!tier) break
        const result = await executeReshuffle(userId, tier)
        if (!result.success) {
          await editMessageText(chatId, messageId, `❌ ${result.error}`, { inline_keyboard: [backRow('m')] })
        } else {
          await editMessageText(chatId, messageId, `✅ Reshuffle queued for ${TIER_LABEL[tier]}\n\nYou'll get a notification when it's done.`)
        }
        break
      }

      // ── Withdrawal ──
      case 'wd': {
        if (parts.length === 1) {
          await editMessageText(chatId, messageId, '<b>💸 Withdrawal</b>\n\nSelect a tier:', {
            inline_keyboard: [
              [btn('Conservative', 'wd:C'), btn('Balanced', 'wd:B'), btn('Degen', 'wd:D')],
              [btn('ALL Tiers', 'wd:A')],
              backRow('m'),
            ],
          })
        } else if (parts.length === 2) {
          // Pick percentage
          const tierKey = parts[1]
          const label = tierKey === 'A' ? 'All Tiers' : TIER_LABEL[TIER_FROM[tierKey]] ?? tierKey
          await editMessageText(chatId, messageId, `<b>💸 Withdraw — ${label}</b>\n\nHow much?`, {
            inline_keyboard: [
              [btn('100%', `wd:${tierKey}:100`), btn('75%', `wd:${tierKey}:75`)],
              [btn('50%', `wd:${tierKey}:50`), btn('25%', `wd:${tierKey}:25`)],
              backRow('wd'),
            ],
          })
        } else if (parts.length === 3) {
          // Confirm
          const tierKey = parts[1]
          const pct = parseInt(parts[2], 10)
          const label = tierKey === 'A' ? 'All Tiers' : TIER_LABEL[TIER_FROM[tierKey]] ?? tierKey
          const est = await estimateWithdrawal(userId, tierKey, pct)
          await editMessageText(chatId, messageId,
            `<b>💸 Confirm Withdrawal</b>\n\nWithdraw <b>${pct}%</b> from <b>${label}</b>?\nEstimated: ~${est.toFixed(4)} SOL`,
            { inline_keyboard: [[btn('✅ Yes, withdraw', `wdx:${tierKey}:${pct}`), btn('❌ Cancel', 'wd')]] },
          )
        }
        break
      }

      // ── Withdrawal execute ──
      case 'wdx': {
        const tierKey = parts[1]
        const pct = parseInt(parts[2], 10)
        const result = await executeWithdrawal(userId, tierKey, pct)
        if (!result.success) {
          await editMessageText(chatId, messageId, `❌ ${result.error}`, { inline_keyboard: [backRow('m')] })
        } else {
          const label = tierKey === 'A' ? 'All Tiers' : TIER_LABEL[TIER_FROM[tierKey]] ?? tierKey
          await editMessageText(chatId, messageId,
            `✅ Withdrawal queued — ${pct}% of ${label}\n\nYou'll get a notification when it's done.`,
          )
        }
        break
      }

      default:
        await answerCallbackQuery(callbackQueryId, 'Unknown action', true)
        return
    }

    await answerCallbackQuery(callbackQueryId)
  } catch (err) {
    console.error('[telegram-menu] callback error', err)
    await answerCallbackQuery(callbackQueryId, 'Something went wrong', true)
  }
}

// ── Action executors ────────────────────────────────────────────────

async function findHolding(userId: string, tier: RiskTier, mintPrefix: string) {
  const wallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId, riskTier: tier } },
    include: { holdings: true },
  })
  if (!wallet) return null
  const match = wallet.holdings.find((h) => h.tokenMint.startsWith(mintPrefix) && h.amount > 0n)
  if (!match) return null
  // Resolve symbol
  const score = await db.tokenScore.findFirst({
    where: { tokenMint: match.tokenMint, source: 'BAGS' },
    orderBy: { scoredAt: 'desc' },
    select: { tokenSymbol: true },
  })
  return { ...match, tokenSymbol: score?.tokenSymbol ?? null }
}

async function executeLiquidate(
  userId: string, tier: RiskTier, mintPrefix: string,
): Promise<{ success: boolean; error?: string; estimatedSol?: number }> {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user?.walletAddress) return { success: false, error: 'Connect a wallet address first' }

  const wallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId, riskTier: tier } },
    include: { holdings: true },
  })
  if (!wallet) return { success: false, error: 'No vault for tier' }

  const holding = wallet.holdings.find((h) => h.tokenMint.startsWith(mintPrefix) && h.amount > 0n)
  if (!holding) return { success: false, error: 'Position not found' }
  if (holding.tokenMint === BAGSX_MINT) return { success: false, error: 'BAGSX cannot be liquidated individually' }

  const inflight = await db.withdrawal.findFirst({ where: { userId, riskTier: tier, status: 'PENDING' } })
  if (inflight) return { success: false, error: 'Another withdrawal is already in progress' }

  const estimatedSol = Number(holding.valueSolEst)
  const withdrawal = await db.withdrawal.create({
    data: { userId, riskTier: tier, amountSol: estimatedSol.toFixed(9), feeSol: '0', status: 'PENDING', source: 'USER' },
  })

  await withdrawalQueue.add('liquidate', {
    withdrawalId: withdrawal.id, userId, subWalletId: wallet.id, pct: 100, tokenMint: holding.tokenMint,
  })

  return { success: true, estimatedSol }
}

async function executeReshuffle(
  userId: string, tier: RiskTier,
): Promise<{ success: boolean; error?: string }> {
  const wallet = await db.subWallet.findUnique({ where: { userId_riskTier: { userId, riskTier: tier } } })
  if (!wallet) return { success: false, error: 'No vault for tier' }

  const COOLDOWN_MS = 60 * 60 * 1000
  if (wallet.lastForceRebalanceAt && Date.now() - wallet.lastForceRebalanceAt.getTime() < COOLDOWN_MS) {
    const mins = Math.ceil((COOLDOWN_MS - (Date.now() - wallet.lastForceRebalanceAt.getTime())) / 60000)
    return { success: false, error: `Cooldown active — ${mins} min remaining` }
  }

  const scoringCycle = await db.scoringCycle.findFirst({
    where: { status: 'COMPLETED', tier, source: 'BAGS' },
    orderBy: { completedAt: 'desc' },
  })
  if (!scoringCycle) return { success: false, error: 'No scoring data yet' }

  // Refresh prices
  try {
    const { priceHoldingsFromDex } = await import('@bags-index/solana')
    const holdings = await db.holding.findMany({ where: { subWalletId: wallet.id } })
    const priced = await priceHoldingsFromDex(
      holdings.map((h) => ({ tokenMint: h.tokenMint, amount: h.amount, decimals: h.decimals })),
    )
    await Promise.all(
      holdings.map((h) =>
        db.holding.update({ where: { id: h.id }, data: { valueSolEst: (priced.get(h.tokenMint)?.valueSol ?? 0).toFixed(9) } }),
      ),
    )
  } catch {}

  const rebalanceCycle = await db.rebalanceCycle.upsert({
    where: {
      scoringCycleId_riskTier_trigger_userId: { scoringCycleId: scoringCycle.id, riskTier: tier, trigger: 'USER_FORCE', userId },
    },
    create: {
      scoringCycleId: scoringCycle.id, riskTier: tier, trigger: 'USER_FORCE', userId,
      walletsTotal: 1, shuffleSeed: `user-${userId}-${Date.now()}`, status: 'PROCESSING',
    },
    update: {
      walletsTotal: 1, walletsComplete: 0, shuffleSeed: `user-${userId}-${Date.now()}`,
      status: 'PROCESSING', startedAt: new Date(), completedAt: null,
    },
  })

  await db.subWallet.update({ where: { id: wallet.id }, data: { lastForceRebalanceAt: new Date() } })

  await rebalanceQueue.add(`user-reshuffle-${wallet.id}`, {
    walletId: wallet.id, riskTier: tier, rebalanceCycleId: rebalanceCycle.id, scoringCycleId: scoringCycle.id,
  }, { priority: 1, removeOnComplete: 100, removeOnFail: 100 })

  return { success: true }
}

async function estimateWithdrawal(userId: string, tierKey: string, pct: number): Promise<number> {
  if (tierKey === 'A') {
    let total = 0
    for (const t of ['C', 'B', 'D']) total += await estimateWithdrawal(userId, t, pct)
    return total
  }
  const tier = TIER_FROM[tierKey]
  if (!tier) return 0
  const wallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId, riskTier: tier } },
    include: { holdings: true },
  })
  if (!wallet) return 0
  const total = wallet.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0)
  return total * (pct / 100)
}

async function executeWithdrawal(
  userId: string, tierKey: string, pct: number,
): Promise<{ success: boolean; error?: string }> {
  if (tierKey === 'A') {
    const results = await Promise.all(
      (['C', 'B', 'D'] as const).map((t) => executeWithdrawal(userId, t, pct)),
    )
    const errors = results.filter((r) => !r.success)
    if (errors.length === 3) return { success: false, error: errors[0].error }
    return { success: true }
  }

  const tier = TIER_FROM[tierKey]
  if (!tier) return { success: false, error: 'Invalid tier' }

  const wallet = await db.subWallet.findUnique({
    where: { userId_riskTier: { userId, riskTier: tier } },
    include: { holdings: true },
  })
  if (!wallet) return { success: false, error: 'No vault for tier' }
  if (wallet.holdings.length === 0) return { success: false, error: `No holdings in ${TIER_LABEL[tier]}` }

  const inflight = await db.withdrawal.findFirst({ where: { userId, riskTier: tier, status: 'PENDING' } })
  if (inflight) return { success: false, error: `Withdrawal already in progress for ${TIER_LABEL[tier]}` }

  const totalValueSol = wallet.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0)
  const estimatedSol = totalValueSol * (pct / 100)

  const withdrawal = await db.withdrawal.create({
    data: { userId, riskTier: tier, amountSol: estimatedSol, feeSol: 0, status: 'PENDING' },
  })

  await withdrawalQueue.add('liquidate', {
    withdrawalId: withdrawal.id, userId, subWalletId: wallet.id, pct,
  })

  return { success: true }
}

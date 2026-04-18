import { db } from '@bags-index/db'
import { getTokenBalances } from '@bags-index/solana'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

/**
 * How long after a holding's last update we wait before allowing deletion.
 * Helius /balances can lag a few seconds after a swap — this grace period
 * prevents wiping freshly-bought holdings that the indexer hasn't caught up
 * with yet (see deposit cmns3akcr 2026-04-09).
 */
const DELETE_GRACE_MS = 2 * 60_000 // 2 minutes

/**
 * Reconcile a sub-wallet's DB Holding rows against actual on-chain SPL
 * balances. Preserves cost basis and realized PnL — only `amount` is
 * rewritten — and inserts/deletes rows so the row set matches what the
 * wallet actually holds.
 *
 * Holdings absent from chain are deleted ONLY if their last update is
 * older than DELETE_GRACE_MS, protecting against Helius indexer lag on
 * fresh buys while still cleaning up post-withdrawal ghost rows.
 *
 * Called from every swap worker (deposit/withdrawal/rebalance/switch)
 * immediately after the swap batch finishes, so the DB never silently
 * drifts from chain state.
 */
export async function reconcileSubWalletHoldings(
  subWalletId: string,
  walletAddress: string,
): Promise<{ updated: number; deleted: number; inserted: number }> {
  const chain = (await getTokenBalances(walletAddress)) as {
    tokens?: Array<{ mint: string; amount: number | string; decimals: number }>
  }
  const onChain = new Map<string, { amount: bigint; decimals: number }>()
  for (const t of chain.tokens ?? []) {
    if (t.mint === SOL_MINT) continue
    const raw =
      typeof t.amount === 'string'
        ? BigInt(t.amount)
        : BigInt(Math.floor(Number(t.amount) || 0))
    if (raw > 0n) onChain.set(t.mint, { amount: raw, decimals: t.decimals })
  }

  const holdings = await db.holding.findMany({ where: { subWalletId } })
  const dbByMint = new Map(holdings.map((h) => [h.tokenMint, h]))

  let updated = 0
  let deleted = 0
  let inserted = 0

  const now = Date.now()

  for (const h of holdings) {
    const onChainEntry = onChain.get(h.tokenMint)
    if (onChainEntry !== undefined) {
      const { amount: onChainAmt, decimals: onChainDec } = onChainEntry
      // Token exists on-chain — update amount and decimals if different.
      // Within the grace period, skip amount *shrinks* so Helius indexer
      // lag doesn't roll back a just-recorded buy (see CLANKER 2026-04-18
      // — post-buy DB=25.4T, Helius still at 19.3T, reconcile regressed
      // the row, next rebalance sold only 19.3T of a 25.4T position).
      const age = now - new Date(h.updatedAt).getTime()
      const withinGrace = age <= DELETE_GRACE_MS
      const chainShrinks = onChainAmt < h.amount
      if (withinGrace && chainShrinks) {
        // Skip entirely — trust our recent swap-path increment.
        continue
      }
      if (onChainAmt !== h.amount || onChainDec !== h.decimals) {
        await db.holding.update({
          where: { id: h.id },
          data: { amount: onChainAmt, decimals: onChainDec },
        })
        updated++
      }
    } else {
      // Token not on-chain — delete if old enough (past grace period)
      const rowAge = now - new Date(h.updatedAt).getTime()
      if (rowAge > DELETE_GRACE_MS) {
        await db.holding.delete({ where: { id: h.id } })
        deleted++
      }
    }
  }

  for (const [mint, { amount: amt, decimals: dec }] of onChain) {
    if (dbByMint.has(mint)) continue
    await db.holding.create({
      data: {
        subWalletId,
        tokenMint: mint,
        amount: amt,
        decimals: dec,
        valueSolEst: '0',
        costBasisSol: '0',
      },
    })
    inserted++
  }

  return { updated, deleted, inserted }
}

import { db } from '@bags-index/db'
import { getTokenBalances } from '@bags-index/solana'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

/**
 * Reconcile a sub-wallet's DB Holding rows against actual on-chain SPL
 * balances. Preserves cost basis and realized PnL — only `amount` is
 * rewritten — and inserts/deletes rows so the row set matches what the
 * wallet actually holds.
 *
 * Called from every swap worker (deposit/withdrawal/rebalance/switch/
 * vault-switch) immediately after the swap batch finishes, so the DB
 * never silently drifts from chain state.
 */
export async function reconcileSubWalletHoldings(
  subWalletId: string,
  walletAddress: string,
): Promise<{ updated: number; deleted: number; inserted: number }> {
  const chain = (await getTokenBalances(walletAddress)) as {
    tokens?: Array<{ mint: string; amount: number | string; decimals: number }>
  }
  const onChain = new Map<string, bigint>()
  for (const t of chain.tokens ?? []) {
    if (t.mint === SOL_MINT) continue
    const raw =
      typeof t.amount === 'string'
        ? BigInt(t.amount)
        : BigInt(Math.floor(Number(t.amount) || 0))
    if (raw > 0n) onChain.set(t.mint, raw)
  }

  const holdings = await db.holding.findMany({ where: { subWalletId } })
  const dbByMint = new Map(holdings.map((h) => [h.tokenMint, h]))

  let updated = 0
  const deleted = 0
  let inserted = 0

  // Additive only: update amounts when on-chain reports a different value,
  // insert missing mints. Never delete based on "not in on-chain" — the
  // Helius /balances endpoint lags the chain by a few seconds after a swap,
  // and wiping a freshly-bought holding because the indexer hasn't caught up
  // yet has cost us real portfolios (see deposit cmns3akcr 2026-04-09).
  // Sales to zero are handled explicitly in the swap/rebalance workers.
  for (const h of holdings) {
    const onChainAmt = onChain.get(h.tokenMint)
    if (onChainAmt !== undefined && onChainAmt !== h.amount) {
      await db.holding.update({
        where: { id: h.id },
        data: { amount: onChainAmt },
      })
      updated++
    }
  }

  for (const [mint, amt] of onChain) {
    if (dbByMint.has(mint)) continue
    await db.holding.create({
      data: {
        subWalletId,
        tokenMint: mint,
        amount: amt,
        valueSolEst: '0',
        costBasisSol: '0',
      },
    })
    inserted++
  }

  return { updated, deleted, inserted }
}

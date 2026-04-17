/**
 * One-off script: wipe phantom holdings rows.
 *
 * A "phantom" row = DB Holding with amount > 0 but on-chain SPL balance
 * is 0 (either the ATA exists with 0 balance or the ATA is absent).
 * These rows make the rebalance worker's currentAllocations math treat
 * the ghost value as real, causing it to skip (or under-size) buys for
 * tokens the vault should be re-acquiring.
 *
 * Dry-run by default; pass `--apply` to actually delete.
 *
 * Run on server:
 *   cd /home/bagsindex/app && npx tsx apps/worker/src/scripts/wipe-phantom-holdings.ts
 *   cd /home/bagsindex/app && npx tsx apps/worker/src/scripts/wipe-phantom-holdings.ts --apply
 */
import { db } from '@bags-index/db'
import { getTokenBalances } from '@bags-index/solana'
import { SOL_MINT } from '@bags-index/shared'

type ChainResult = { tokens?: Array<{ mint: string; amount: number | string; decimals: number }> }

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(`[wipe-phantoms] mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const subWallets = await db.subWallet.findMany({
    select: { id: true, address: true, riskTier: true, userId: true },
  })
  console.log(`[wipe-phantoms] scanning ${subWallets.length} sub-wallets`)

  let totalScanned = 0
  let totalPhantoms = 0
  let totalDeleted = 0
  const phantomsByWallet: Array<{
    address: string
    tier: string
    rows: Array<{ mint: string; amount: string; valueSolEst: string }>
  }> = []

  for (const w of subWallets) {
    let chain: ChainResult
    try {
      chain = (await getTokenBalances(w.address)) as ChainResult
    } catch (err) {
      console.warn(`[wipe-phantoms] ${w.address.slice(0, 8)} chain fetch failed — skipping: ${err}`)
      continue
    }

    const chainAmt = new Map<string, bigint>()
    for (const t of chain.tokens ?? []) {
      if (t.mint === SOL_MINT) continue
      const raw =
        typeof t.amount === 'string'
          ? BigInt(t.amount)
          : BigInt(Math.floor(Number(t.amount) || 0))
      // Include zero-balance ATAs in the map so we can distinguish
      // "chain says 0" from "no ATA at all" — both count as phantom.
      chainAmt.set(t.mint, raw)
    }

    const holdings = await db.holding.findMany({
      where: { subWalletId: w.id },
    })
    totalScanned += holdings.length

    const phantoms: Array<{ id: string; mint: string; amount: string; valueSolEst: string }> = []
    for (const h of holdings) {
      if (h.amount <= 0n) {
        phantoms.push({
          id: h.id,
          mint: h.tokenMint,
          amount: h.amount.toString(),
          valueSolEst: h.valueSolEst.toString(),
        })
        continue
      }
      const onChain = chainAmt.get(h.tokenMint) ?? 0n
      if (onChain === 0n) {
        phantoms.push({
          id: h.id,
          mint: h.tokenMint,
          amount: h.amount.toString(),
          valueSolEst: h.valueSolEst.toString(),
        })
      }
    }

    if (phantoms.length === 0) continue

    totalPhantoms += phantoms.length
    phantomsByWallet.push({
      address: w.address,
      tier: w.riskTier!,
      rows: phantoms.map((p) => ({ mint: p.mint, amount: p.amount, valueSolEst: p.valueSolEst })),
    })

    console.log(`[wipe-phantoms] ${w.riskTier} ${w.address.slice(0, 8)} — ${phantoms.length} phantom(s)`)
    for (const p of phantoms) {
      console.log(
        `  · ${p.mint.slice(0, 8)}… amount=${p.amount} valueSolEst=${p.valueSolEst}`,
      )
    }

    if (apply) {
      for (const p of phantoms) {
        try {
          await db.holding.delete({ where: { id: p.id } })
          totalDeleted++
        } catch (err) {
          console.error(`[wipe-phantoms] delete failed for ${p.id}: ${err}`)
        }
      }
    }
  }

  console.log('')
  console.log(`[wipe-phantoms] done — scanned=${totalScanned} phantoms=${totalPhantoms} deleted=${totalDeleted}`)
  console.log(`[wipe-phantoms] wallets affected: ${phantomsByWallet.length}`)
  if (!apply && totalPhantoms > 0) {
    console.log(`[wipe-phantoms] DRY-RUN — re-run with --apply to delete`)
  }
  await db.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * One-off script: sweep SOL from empty vault wallets back to the user.
 * Run on server: cd /home/bagsindex/app && npx tsx apps/worker/src/scripts/sweep-empty-wallets.ts
 */
import { getNativeSolBalanceLamports, transferSolFromServerWallet } from '@bags-index/solana'
import { db } from '@bags-index/db'

const USER_WALLET = 'HF6jdrUj1iVdXBB15pZQBQXtebsFWimn2czN7cQgdmbS'
// Rent-exempt minimum (890,880) + tx fee (5,000) — sender must retain this
const SWEEP_RESERVE_LAMPORTS = 900_000n

const WALLETS_TO_SWEEP = [
  { address: 'CieZvPNxCc9a4UR5wzWcaLhsTQERkwj7roQhyFCpY36h', privyWalletId: 'xgcctgc6a6nz8r48w6vv8wv0', tier: 'DEGEN' },
  { address: 'BXVUpvzqFDrZ6Cm6ZtzrHauMaYnSPb1PfMm5xJnKNiF2', privyWalletId: 'cq2sjbkcteafdgxrh3e0n1i0', tier: 'CONSERVATIVE' },
  { address: 'EBMvWWnDZayqLQngHSh3kSkCAA4iugq7NmvcBpj9ArMo', privyWalletId: 'uy86a4gunvituuwsbmrfmjew', tier: 'BALANCED' },
]

async function main() {
  let totalSwept = 0n

  for (const w of WALLETS_TO_SWEEP) {
    const balanceLamports = await getNativeSolBalanceLamports(w.address)
    const sendable = balanceLamports - SWEEP_RESERVE_LAMPORTS

    if (sendable <= 0n) {
      console.log(`[sweep] ${w.tier} ${w.address.slice(0, 8)}… balance=${balanceLamports} lamports — too low`)
      continue
    }

    console.log(`[sweep] ${w.tier} ${w.address.slice(0, 8)}… sweeping ${Number(sendable) / 1e9} SOL`)

    try {
      const sig = await transferSolFromServerWallet({
        fromPrivyWalletId: w.privyWalletId,
        fromAddress: w.address,
        toAddress: USER_WALLET,
        lamports: sendable,
      })
      console.log(`[sweep] OK → ${sig}`)
      totalSwept += sendable

      // Accounting cleanup — record as a USER withdrawal so /portfolio/pnl
      // counts the swept SOL correctly and a future re-deposit doesn't stack
      // on top of stale cost basis.
      const sw = await db.subWallet.findFirst({
        where: { address: w.address },
        select: { id: true, userId: true, riskTier: true },
      })
      if (sw) {
        await db.withdrawal.create({
          data: {
            userId: sw.userId,
            riskTier: sw.riskTier!,
            amountSol: (Number(sendable) / 1e9).toFixed(9),
            feeSol: '0',
            txSignature: sig,
            status: 'CONFIRMED',
            source: 'USER',
            confirmedAt: new Date(),
          },
        })
        await db.holding.deleteMany({ where: { subWalletId: sw.id } })
        await db.subWallet.update({
          where: { id: sw.id },
          data: { realizedPnlSol: '0' },
        })
        console.log(`[sweep] recorded Withdrawal + cleared holdings for ${w.address.slice(0, 8)}`)
      } else {
        console.warn(`[sweep] WARN: no sub_wallet row for ${w.address} — accounting NOT recorded`)
      }
    } catch (err) {
      console.error(`[sweep] ${w.tier} failed:`, err)
    }
  }

  console.log(`\n[sweep] Total swept: ${Number(totalSwept) / 1e9} SOL`)
  process.exit(0)
}

main()

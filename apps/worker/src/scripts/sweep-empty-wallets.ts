/**
 * One-off script: sweep SOL from empty vault wallets back to the user.
 * Run on server: cd /home/bagsindex/app && npx tsx apps/worker/src/scripts/sweep-empty-wallets.ts
 */
import { getNativeSolBalanceLamports, transferSolFromServerWallet } from '@bags-index/solana'

const USER_WALLET = 'HF6jdrUj1iVdXBB15pZQBQXtebsFWimn2czN7cQgdmbS'
const TX_FEE_LAMPORTS = 10_000n

const WALLETS_TO_SWEEP = [
  { address: 'CieZvPNxCc9a4UR5wzWcaLhsTQERkwj7roQhyFCpY36h', privyWalletId: 'xgcctgc6a6nz8r48w6vv8wv0', tier: 'DEGEN' },
  { address: 'BXVUpvzqFDrZ6Cm6ZtzrHauMaYnSPb1PfMm5xJnKNiF2', privyWalletId: 'cq2sjbkcteafdgxrh3e0n1i0', tier: 'CONSERVATIVE' },
  { address: 'EBMvWWnDZayqLQngHSh3kSkCAA4iugq7NmvcBpj9ArMo', privyWalletId: 'uy86a4gunvituuwsbmrfmjew', tier: 'BALANCED' },
]

async function main() {
  let totalSwept = 0n

  for (const w of WALLETS_TO_SWEEP) {
    const balanceLamports = await getNativeSolBalanceLamports(w.address)
    const sendable = balanceLamports - TX_FEE_LAMPORTS

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
    } catch (err) {
      console.error(`[sweep] ${w.tier} failed:`, err)
    }
  }

  console.log(`\n[sweep] Total swept: ${Number(totalSwept) / 1e9} SOL`)
  process.exit(0)
}

main()

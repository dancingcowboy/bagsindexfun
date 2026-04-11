import 'dotenv/config'
import { db } from '@bags-index/db'
import {
  buildSellTransaction,
  signVersionedTxBytes,
  submitAndConfirmDirect,
  transferSolFromServerWallet,
  getLiveHoldings,
} from '@bags-index/solana'
import { LAMPORTS_PER_SOL } from '@bags-index/shared'

/**
 * EMERGENCY SWEEP
 *
 * Liquidates every sub-wallet on the protocol and returns the resulting
 * SOL to each owner's connected wallet (User.walletAddress). Designed to
 * run standalone from any laptop with:
 *
 *   - PRIVY_APP_ID + PRIVY_APP_SECRET in .env
 *   - DATABASE_URL pointing at a reachable Postgres (or a restored snapshot)
 *   - HELIUS_API_KEY + BAGS_API_KEY for quotes
 *
 * Usage:
 *   pnpm tsx scripts/emergency-sweep.ts              # dry run
 *   pnpm tsx scripts/emergency-sweep.ts --execute    # real sweep
 *   pnpm tsx scripts/emergency-sweep.ts --execute --user <userId>
 *   pnpm tsx scripts/emergency-sweep.ts --execute --wallet <subWalletId>
 *
 * Safety rails:
 *   - Dry run by default: prints the plan, touches nothing.
 *   - --user / --wallet filters let you test on one account before mass sweep.
 *   - Continues past individual failures; prints a per-wallet summary at end.
 *   - Leaves ~0.01 SOL behind for rent/fees on each sub-wallet.
 */

const RENT_BUFFER_LAMPORTS = BigInt(Math.floor(0.01 * LAMPORTS_PER_SOL))

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    execute: args.includes('--execute'),
    userId: argValue(args, '--user'),
    walletId: argValue(args, '--wallet'),
  }
}
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

interface SweepResult {
  walletId: string
  address: string
  owner: string
  destination: string
  sold: number
  soldFailed: number
  solReturned: number
  error?: string
}

async function sweepWallet(
  sw: {
    id: string
    address: string
    privyWalletId: string
    user: { id: string; walletAddress: string }
  },
  execute: boolean,
): Promise<SweepResult> {
  const result: SweepResult = {
    walletId: sw.id,
    address: sw.address,
    owner: sw.user.id,
    destination: sw.user.walletAddress,
    sold: 0,
    soldFailed: 0,
    solReturned: 0,
  }

  try {
    // Live-read holdings from chain so we never miss drift or reconcile gaps
    const live = await getLiveHoldings(sw.address)
    console.log(
      `  · ${sw.address.slice(0, 8)}… → ${sw.user.walletAddress.slice(0, 8)}… | ${live.holdings.length} tokens, ${live.nativeSol.toFixed(4)} SOL`,
    )

    // 1. Sell every SPL holding
    for (const h of live.holdings) {
      if (h.amount === '0') continue
      try {
        if (!execute) {
          console.log(`      [dry] sell ${h.amount} of ${h.tokenMint.slice(0, 8)}…`)
          result.sold++
          continue
        }
        const { txBytes } = await buildSellTransaction({
          tokenMint: h.tokenMint,
          tokenAmount: BigInt(h.amount),
          userPublicKey: sw.address,
        })
        const signed = await signVersionedTxBytes({
          walletId: sw.privyWalletId,
          txBytes,
        })
        const sig = await submitAndConfirmDirect(signed)
        console.log(`      ✓ sold ${h.tokenMint.slice(0, 8)}… ${sig.slice(0, 16)}…`)
        result.sold++
      } catch (err) {
        console.error(`      ✗ sell ${h.tokenMint.slice(0, 8)}… failed: ${err}`)
        result.soldFailed++
      }
    }

    // 2. Transfer remaining SOL back to owner's connected wallet
    // Re-read native balance after sells to capture sale proceeds
    const after = execute ? await getLiveHoldings(sw.address) : live
    const lamports = BigInt(Math.floor(after.nativeSol * LAMPORTS_PER_SOL))
    const sendable = lamports > RENT_BUFFER_LAMPORTS ? lamports - RENT_BUFFER_LAMPORTS : 0n

    if (sendable <= 0n) {
      console.log(`      (nothing to transfer after rent buffer)`)
      return result
    }

    if (!execute) {
      console.log(`      [dry] transfer ${Number(sendable) / LAMPORTS_PER_SOL} SOL → ${sw.user.walletAddress}`)
      result.solReturned = Number(sendable) / LAMPORTS_PER_SOL
      return result
    }

    const sig = await transferSolFromServerWallet({
      fromPrivyWalletId: sw.privyWalletId,
      fromAddress: sw.address,
      toAddress: sw.user.walletAddress,
      lamports: sendable,
    })
    result.solReturned = Number(sendable) / LAMPORTS_PER_SOL
    console.log(`      ✓ returned ${result.solReturned} SOL · ${sig.slice(0, 16)}…`)

    // Accounting cleanup — without this, /portfolio/pnl still counts the
    // old deposits as live cost basis and any re-deposit stacks on top,
    // producing phantom unrealized losses on the dashboard.
    //   1. Record a Withdrawal row (status=CONFIRMED) for the swept SOL
    //   2. Delete Holding rows for this sub-wallet (tokens are gone)
    //   3. Zero realizedPnlSol so the next cycle starts from a clean slate
    const swRow = await db.subWallet.findUnique({
      where: { id: sw.id },
      select: { riskTier: true },
    })
    if (swRow) {
      await db.withdrawal.create({
        data: {
          userId: sw.user.id,
          riskTier: swRow.riskTier,
          amountSol: result.solReturned.toFixed(9),
          feeSol: '0',
          txSignature: sig,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      })
      await db.holding.deleteMany({ where: { subWalletId: sw.id } })
      await db.subWallet.update({
        where: { id: sw.id },
        data: { realizedPnlSol: '0' },
      })
    }
  } catch (err) {
    result.error = String(err)
    console.error(`      ✗ wallet failed: ${err}`)
  }

  return result
}

async function main() {
  const { execute, userId, walletId } = parseArgs()

  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log(`║  BAGS INDEX EMERGENCY SWEEP  ·  ${execute ? 'LIVE EXECUTION' : 'DRY RUN       '}       ║`)
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')

  if (!process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
    console.error('PRIVY_APP_ID + PRIVY_APP_SECRET required. Aborting.')
    process.exit(1)
  }

  // Skip placeholder rows whose address starts with `pending-` — those
  // represent users whose Privy provisioning failed mid-signup and have
  // no real on-chain account to sweep.
  const where: any = { address: { not: { startsWith: 'pending-' } } }
  if (walletId) where.id = walletId
  if (userId) where.userId = userId

  const wallets = await db.subWallet.findMany({
    where,
    include: { user: { select: { id: true, walletAddress: true } } },
    orderBy: { createdAt: 'asc' },
  })

  if (wallets.length === 0) {
    console.log('No sub-wallets matched the filter. Nothing to do.')
    return
  }

  console.log(`Target: ${wallets.length} sub-wallet${wallets.length === 1 ? '' : 's'}`)
  if (userId) console.log(`Filter: userId=${userId}`)
  if (walletId) console.log(`Filter: walletId=${walletId}`)
  if (!execute) {
    console.log('')
    console.log('DRY RUN — no transactions will be sent. Add --execute to perform the sweep.')
  } else {
    console.log('')
    console.log('*** LIVE EXECUTION — transactions WILL be sent. You have 5 seconds to abort (Ctrl-C). ***')
    await new Promise((r) => setTimeout(r, 5000))
  }
  console.log('')

  const results: SweepResult[] = []
  for (const w of wallets) {
    if (!w.user?.walletAddress) {
      console.log(`  · ${w.address.slice(0, 8)}… SKIP (no owner wallet)`)
      continue
    }
    const r = await sweepWallet(w as any, execute)
    results.push(r)
  }

  console.log('')
  console.log('═════════════ SUMMARY ═════════════')
  const totalSol = results.reduce((s, r) => s + r.solReturned, 0)
  const okSells = results.reduce((s, r) => s + r.sold, 0)
  const badSells = results.reduce((s, r) => s + r.soldFailed, 0)
  const errored = results.filter((r) => r.error).length
  console.log(`Wallets processed: ${results.length}`)
  console.log(`Sells ok / failed: ${okSells} / ${badSells}`)
  console.log(`Wallets with errors: ${errored}`)
  console.log(`Total SOL ${execute ? 'returned' : 'would return'}: ${totalSol.toFixed(6)}`)
  console.log('')
  if (errored > 0) {
    console.log('Errored wallets:')
    for (const r of results.filter((x) => x.error)) {
      console.log(`  · ${r.address} → ${r.error}`)
    }
  }
}

main()
  .catch((err) => {
    console.error('[emergency-sweep] fatal:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())

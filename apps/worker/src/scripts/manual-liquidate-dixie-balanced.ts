/**
 * One-off: manually liquidate dixie's 2 stuck BALANCED holdings via Jupiter
 * over plain RPC (no Jito, no Helius Sender), then sweep SOL to user wallet.
 *
 * Run on server: cd /home/bagsindex/app && npx tsx apps/worker/src/scripts/manual-liquidate-dixie-balanced.ts
 */
import { Buffer } from 'node:buffer'
import { db } from '@bags-index/db'
import {
  getJupiterQuote,
  buildJupiterSwapTx,
  signVersionedTxBytes,
  submitAndConfirmDirect,
  transferSolFromServerWallet,
  getNativeSolBalanceLamports,
} from '@bags-index/solana'
import { SOL_MINT, LAMPORTS_PER_SOL } from '@bags-index/shared'

const SUB_WALLET_ID = 'cmnwakp0h00058763844f4ujb'
const SUB_WALLET_ADDRESS = '8LitatfNjMszKmYWHL7Lw9V4oPZ5sR5S4rDMtKvWJBTt'
const PRIVY_WALLET_ID = 'tpmgj4ve0buxnnvwxp7rqxuy'
const USER_WALLET = '6AjjcCpWUN2MHMJpKvNLLnXABj35DiLX4CfMJ8TzzW9x'
const SWEEP_RESERVE = 900_000n // rent-exempt + tx fee

async function sellOne(tokenMint: string, tokenAmount: bigint) {
  console.log(`[manual-sell] ${tokenMint.slice(0, 8)}… amount=${tokenAmount}`)
  const quote = await getJupiterQuote({
    inputMint: tokenMint,
    outputMint: SOL_MINT,
    amount: tokenAmount.toString(),
    slippageBps: 500,
  })
  console.log(`[manual-sell] quote outAmount=${quote.outAmount} slippageBps=${quote.slippageBps}`)

  const swap = await buildJupiterSwapTx({ quote, userPublicKey: SUB_WALLET_ADDRESS })
  const txBytes = Buffer.from(swap.swapTransaction, 'base64')
  const signed = await signVersionedTxBytes({ walletId: PRIVY_WALLET_ID, txBytes })
  const sig = await submitAndConfirmDirect(signed)
  console.log(`[manual-sell] CONFIRMED ${sig}`)

  await db.swapExecution.create({
    data: {
      subWalletId: SUB_WALLET_ID,
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      inputAmount: tokenAmount,
      outputAmount: BigInt(quote.outAmount),
      slippageBps: quote.slippageBps,
      route: 'JUPITER',
      status: 'CONFIRMED',
      txSignature: sig,
    },
  })
  await db.holding.delete({
    where: { subWalletId_tokenMint: { subWalletId: SUB_WALLET_ID, tokenMint } },
  })
  return BigInt(quote.outAmount)
}

async function main() {
  const holdings = await db.holding.findMany({
    where: { subWalletId: SUB_WALLET_ID },
    orderBy: { tokenMint: 'asc' },
  })
  console.log(`[manual] ${holdings.length} holdings to liquidate`)

  let recoveredLamports = 0n
  for (const h of holdings) {
    if (h.amount <= 0n) continue
    try {
      recoveredLamports += await sellOne(h.tokenMint, h.amount)
    } catch (err: any) {
      console.error(`[manual-sell] FAILED ${h.tokenMint.slice(0, 8)}…:`, err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }

  console.log(`[manual] recovered ~${Number(recoveredLamports) / LAMPORTS_PER_SOL} SOL from sells`)

  // Sweep native SOL to user wallet
  const bal = await getNativeSolBalanceLamports(SUB_WALLET_ADDRESS)
  const sendable = bal > SWEEP_RESERVE ? bal - SWEEP_RESERVE : 0n
  console.log(`[manual] native balance=${bal} sendable=${sendable}`)
  if (sendable > 0n) {
    const sig = await transferSolFromServerWallet({
      fromPrivyWalletId: PRIVY_WALLET_ID,
      fromAddress: SUB_WALLET_ADDRESS,
      toAddress: USER_WALLET,
      lamports: sendable,
    })
    console.log(`[manual] swept ${Number(sendable) / LAMPORTS_PER_SOL} SOL → ${USER_WALLET}: ${sig}`)

    // Mark the most recent PARTIAL withdrawal for this sub-wallet as CONFIRMED
    const latestPartial = await db.withdrawal.findFirst({
      where: { userId: 'cmnwakoiy0000876304e42l02', riskTier: 'BALANCED', status: 'PARTIAL' },
      orderBy: { createdAt: 'desc' },
    })
    if (latestPartial) {
      await db.withdrawal.update({
        where: { id: latestPartial.id },
        data: {
          status: 'CONFIRMED',
          txSignature: sig,
          amountSol: Number(sendable) / LAMPORTS_PER_SOL,
          confirmedAt: new Date(),
        },
      })
      console.log(`[manual] marked withdrawal ${latestPartial.id} CONFIRMED`)
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

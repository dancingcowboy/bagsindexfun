import {
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  PublicKey,
  AddressLookupTableAccount,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { getConnection } from './connection.js'
import { getTradeQuote, getSwapTransaction } from './bags.js'
import { getJupiterQuote, buildJupiterSwapTx } from './jupiter-swap.js'
import { sendJitoProtected } from './helius.js'
import { SOL_MINT, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from '@bags-index/shared'

export interface SwapResult {
  signature: string
  inputMint: string
  outputMint: string
  inputAmount: string
  outputAmount: string
}

export type SwapRoute = 'BAGS' | 'JUPITER'

// ─── Jito tip helpers ─────────────────────────────────────────────────────────
// Helius Sender requires tips to Helius-specific wallets, NOT the standard
// Jito tip accounts. Source: helius-labs/helius-rust-sdk SENDER_TIP_ACCOUNTS.
const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
  'D1Mc6j9xQWgR1o1Z7yU5nVVXFQiAYx7FG9AW1aVfwrUM',
]
const JITO_TIP_LAMPORTS = 200_000 // 0.0002 SOL — Helius Sender minimum

function randomTipAccount(): PublicKey {
  return new PublicKey(HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)])
}

/**
 * Append a Jito tip SOL transfer to an existing VersionedTransaction.
 * Decompiles the message, adds the tip instruction, then recompiles.
 */
async function addJitoTip(txBytes: Uint8Array, feePayer: PublicKey): Promise<Uint8Array> {
  const connection = getConnection()
  const tx = VersionedTransaction.deserialize(txBytes)
  const addressLookupTableAccounts: AddressLookupTableAccount[] = []

  // Resolve any address lookup tables used by the transaction
  for (const key of tx.message.addressTableLookups) {
    const accountInfo = await connection.getAddressLookupTable(key.accountKey)
    if (accountInfo.value) addressLookupTableAccounts.push(accountInfo.value)
  }

  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts })
  message.instructions.push(
    SystemProgram.transfer({
      fromPubkey: feePayer,
      toPubkey: randomTipAccount(),
      lamports: JITO_TIP_LAMPORTS,
    }),
  )

  // Recompile with a fresh blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  message.recentBlockhash = blockhash
  const newTx = new VersionedTransaction(message.compileToV0Message(addressLookupTableAccounts))
  return newTx.serialize()
}

/**
 * Unified shape for the swap router. Both Bags and Jupiter expose
 * `outAmount` and `slippageBps` on their quote responses, so callers can
 * read those fields without knowing which venue served the trade. The
 * `route` tag is recorded in SwapExecution.route for post-hoc attribution.
 */
export interface BuiltSwap {
  txBytes: Uint8Array
  // Both Bags and Jupiter expose `outAmount` and `slippageBps`. Typed loose
  // here so we can return either venue's response without a discriminated
  // union; callers only read those two fields.
  quote: { outAmount: string | number; slippageBps: number } & Record<string, any>
  route: SwapRoute
}

const FALLBACK_ENABLED = process.env.BAGS_FALLBACK_ENABLED !== 'false'

function shouldFallbackToJupiter(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { remaining?: number } }; message?: string; code?: string }
  if (e?.response?.status === 429) return true
  if (e?.response?.status && e.response.status >= 500) return true
  if (e?.message?.includes('Bags API quota drained')) return true
  // Network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc.)
  if (e?.code?.startsWith('E')) return true
  return false
}

/**
 * Build a SOL → token buy. Tries Bags first (hackathon-preferred routing),
 * falls back to Jupiter v6 on 429 / quota-drained / network error so a
 * rate-limited Bags endpoint doesn't silently turn a deposit into a no-op.
 */
export async function buildBuyTransaction(params: {
  tokenMint: string
  solAmount: bigint
  userPublicKey: string
  slippageBps?: number
}): Promise<BuiltSwap> {
  const slippage = Math.min(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)

  const feePayer = new PublicKey(params.userPublicKey)
  try {
    const quote = await getTradeQuote({
      inputMint: SOL_MINT,
      outputMint: params.tokenMint,
      amount: params.solAmount.toString(),
      slippageBps: slippage,
    })
    const swapRes = await getSwapTransaction({
      quoteResponse: quote,
      userPublicKey: params.userPublicKey,
    })
    // Bags txs don't include a Jito tip — add one for MEV protection.
    const rawBytes = bs58.decode(swapRes.swapTransaction)
    const tippedBytes = await addJitoTip(rawBytes, feePayer)
    return { txBytes: tippedBytes, quote, route: 'BAGS' }
  } catch (err) {
    if (!FALLBACK_ENABLED || !shouldFallbackToJupiter(err)) throw err
    const e = err as { response?: { status?: number }; message?: string }
    console.warn(
      `[swap] Bags unavailable for buy ${params.tokenMint.slice(0, 8)}… (${e?.response?.status ?? e?.message ?? 'unknown'}); falling through to Jupiter`,
    )
    let jq: Awaited<ReturnType<typeof getJupiterQuote>>
    try {
      jq = await getJupiterQuote({
        inputMint: SOL_MINT,
        outputMint: params.tokenMint,
        amount: params.solAmount.toString(),
        slippageBps: slippage,
      })
    } catch (quoteErr: any) {
      console.error(`[swap] Jupiter quote failed for buy ${params.tokenMint.slice(0, 8)}…: ${quoteErr?.response?.status ?? quoteErr?.message}`)
      throw quoteErr
    }
    try {
      // Jupiter's built-in jitoTipLamports sends to standard Jito accounts,
      // but we submit via Helius Sender which only accepts Helius wallets.
      // So we add the Helius tip manually, same as the Bags path.
      const jSwap = await buildJupiterSwapTx({ quote: jq, userPublicKey: params.userPublicKey })
      const jupBytes = Buffer.from(jSwap.swapTransaction, 'base64')
      const tippedBytes = await addJitoTip(jupBytes, feePayer)
      return {
        txBytes: tippedBytes,
        quote: jq,
        route: 'JUPITER',
      }
    } catch (swapErr: any) {
      console.error(`[swap] Jupiter swap-build failed for buy ${params.tokenMint.slice(0, 8)}…: ${swapErr?.response?.status ?? swapErr?.message}`)
      throw swapErr
    }
  }
}

/**
 * Build a token → SOL sell. Same cascade: Bags → Jupiter v6 on rate limit.
 */
export async function buildSellTransaction(params: {
  tokenMint: string
  tokenAmount: bigint
  userPublicKey: string
  slippageBps?: number
}): Promise<BuiltSwap> {
  const slippage = Math.min(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)

  const feePayer = new PublicKey(params.userPublicKey)
  try {
    const quote = await getTradeQuote({
      inputMint: params.tokenMint,
      outputMint: SOL_MINT,
      amount: params.tokenAmount.toString(),
      slippageBps: slippage,
    })
    const swapRes = await getSwapTransaction({
      quoteResponse: quote,
      userPublicKey: params.userPublicKey,
    })
    const rawBytes = bs58.decode(swapRes.swapTransaction)
    const tippedBytes = await addJitoTip(rawBytes, feePayer)
    return { txBytes: tippedBytes, quote, route: 'BAGS' }
  } catch (err) {
    if (!FALLBACK_ENABLED || !shouldFallbackToJupiter(err)) throw err
    const e = err as { response?: { status?: number }; message?: string }
    console.warn(
      `[swap] Bags unavailable for sell ${params.tokenMint.slice(0, 8)}… (${e?.response?.status ?? e?.message ?? 'unknown'}); falling through to Jupiter`,
    )
    let jq: Awaited<ReturnType<typeof getJupiterQuote>>
    try {
      jq = await getJupiterQuote({
        inputMint: params.tokenMint,
        outputMint: SOL_MINT,
        amount: params.tokenAmount.toString(),
        slippageBps: slippage,
      })
    } catch (quoteErr: any) {
      console.error(`[swap] Jupiter quote failed for sell ${params.tokenMint.slice(0, 8)}…: ${quoteErr?.response?.status ?? quoteErr?.message}`)
      throw quoteErr
    }
    try {
      const jSwap = await buildJupiterSwapTx({ quote: jq, userPublicKey: params.userPublicKey })
      const jupBytes = Buffer.from(jSwap.swapTransaction, 'base64')
      const tippedBytes = await addJitoTip(jupBytes, feePayer)
      return {
        txBytes: tippedBytes,
        quote: jq,
        route: 'JUPITER',
      }
    } catch (swapErr: any) {
      console.error(`[swap] Jupiter swap-build failed for sell ${params.tokenMint.slice(0, 8)}…: ${swapErr?.response?.status ?? swapErr?.message}`)
      throw swapErr
    }
  }
}

/**
 * Submit a signed transaction with Jito MEV protection via Helius Sender,
 * then wait for confirmation on the standard RPC.
 */
export async function submitAndConfirm(
  signedTxBytes: Uint8Array,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const connection = getConnection()
  const tx = VersionedTransaction.deserialize(signedTxBytes)
  const base64 = Buffer.from(tx.serialize()).toString('base64')
  const signature = await sendJitoProtected(base64)

  // Poll signature status instead of relying on confirmTransaction's 30s
  // blockhash-bound timeout — Solana congestion often lands txs 30-90s
  // after submission.
  //
  // Landing reliability: Helius Sender uses skipPreflight+maxRetries=0
  // (fire-and-forget). If Jito doesn't bundle the tx in its ~60s window,
  // the blockhash expires and the tx is lost. To counter this without
  // paying more in tips, we rebroadcast the SAME signed tx via regular
  // RPC on a steady cadence — same signature = no double-spend risk,
  // the Jito tip instruction is already in the signed bytes so total
  // cost is unchanged. Whichever path lands first wins.
  const timeoutMs = opts?.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  let lastRebroadcast = Date.now()
  while (Date.now() < deadline) {
    try {
      const { value } = await connection.getSignatureStatuses([signature])
      const status = value[0]
      if (status?.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`)
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        return signature
      }
    } catch (err: any) {
      if (err?.message?.startsWith('Transaction failed on-chain')) throw err
      // transient RPC error — keep polling
    }
    // Rebroadcast every ~10s via direct RPC to keep the tx alive across
    // leader slots while Jito races for bundle inclusion. Silent on
    // rebroadcast errors (duplicate signature, already-processed, etc).
    if (Date.now() - lastRebroadcast >= 10_000) {
      lastRebroadcast = Date.now()
      connection
        .sendRawTransaction(signedTxBytes, { skipPreflight: true, maxRetries: 0 })
        .catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
  throw new Error(
    `Transaction ${signature} not confirmed in ${Math.round(timeoutMs / 1000)}s`,
  )
}

/**
 * Submit a signed transaction via the plain Solana RPC (no Jito tip required).
 * Use for transactions where MEV protection is unnecessary — e.g. Bags fee
 * claim txs, which don't include a tip instruction and are rejected by
 * Helius Sender for that reason.
 */
export async function submitAndConfirmDirect(signedTxBytes: Uint8Array): Promise<string> {
  const connection = getConnection()
  const signature = await connection.sendRawTransaction(signedTxBytes, {
    skipPreflight: false,
    maxRetries: 3,
  })
  await connection.confirmTransaction(signature, 'confirmed')
  return signature
}

/**
 * Previously capped swap size to a % of pool liquidity to limit slippage.
 * The per-swap slippage guard (MAX_SLIPPAGE_BPS) already protects against
 * catastrophic executions, so the hard ceiling was removed — callers get the
 * full requested amount back. Kept as a thin passthrough so existing call
 * sites continue to compile and we can reinstate a cap without a signature
 * change if needed.
 */
export async function capInputToLiquidity(_tokenMint: string, requestedLamports: bigint): Promise<bigint> {
  return requestedLamports
}

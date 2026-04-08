import { VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { getConnection } from './connection.js'
import { getTradeQuote, getSwapTransaction } from './bags.js'
import { sendJitoProtected, getTokenSolLiquidity } from './helius.js'
import { SOL_MINT, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MAX_LIQUIDITY_PCT, LAMPORTS_PER_SOL } from '@bags-index/shared'

export interface SwapResult {
  signature: string
  inputMint: string
  outputMint: string
  inputAmount: string
  outputAmount: string
}

/**
 * Execute a buy (SOL -> token) via Bags trade API.
 * Returns the unsigned transaction bytes for Privy signing.
 */
export async function buildBuyTransaction(params: {
  tokenMint: string
  solAmount: bigint
  userPublicKey: string
  slippageBps?: number
}): Promise<{ txBytes: Uint8Array; quote: ReturnType<typeof getTradeQuote> extends Promise<infer T> ? T : never }> {
  const slippage = Math.min(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)

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

  const txBytes = bs58.decode(swapRes.swapTransaction)
  return { txBytes, quote }
}

/**
 * Execute a sell (token -> SOL) via Bags trade API.
 * Returns the unsigned transaction bytes for Privy signing.
 */
export async function buildSellTransaction(params: {
  tokenMint: string
  tokenAmount: bigint
  userPublicKey: string
  slippageBps?: number
}): Promise<{ txBytes: Uint8Array; quote: ReturnType<typeof getTradeQuote> extends Promise<infer T> ? T : never }> {
  const slippage = Math.min(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)

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

  const txBytes = bs58.decode(swapRes.swapTransaction)
  return { txBytes, quote }
}

/**
 * Submit a signed transaction with Jito MEV protection via Helius Sender,
 * then wait for confirmation on the standard RPC.
 */
export async function submitAndConfirm(signedTxBytes: Uint8Array): Promise<string> {
  const connection = getConnection()
  const tx = VersionedTransaction.deserialize(signedTxBytes)
  const base64 = Buffer.from(tx.serialize()).toString('base64')
  const signature = await sendJitoProtected(base64)
  await connection.confirmTransaction(signature, 'confirmed')
  return signature
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
 * Cap a desired SOL input to no more than MAX_LIQUIDITY_PCT (default 2%) of the
 * token's available SOL-side liquidity. Returns the capped lamport amount.
 *
 * If liquidity can't be fetched, falls back to the requested amount (the swap's
 * own slippage cap will still protect against catastrophic moves).
 */
export async function capInputToLiquidity(tokenMint: string, requestedLamports: bigint): Promise<bigint> {
  const solLiquidity = await getTokenSolLiquidity(tokenMint)
  if (!solLiquidity || solLiquidity <= 0) return requestedLamports
  const maxSol = solLiquidity * (MAX_LIQUIDITY_PCT / 100)
  const maxLamports = BigInt(Math.floor(maxSol * LAMPORTS_PER_SOL))
  return requestedLamports > maxLamports ? maxLamports : requestedLamports
}

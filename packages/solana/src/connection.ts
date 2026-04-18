import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'

let connection: Connection | null = null
let publicConnection: Connection | null = null

export function getConnection(): Connection {
  if (!connection) {
    const rpcUrl = process.env.HELIUS_RPC_URL
    if (!rpcUrl) throw new Error('HELIUS_RPC_URL is required')
    connection = new Connection(rpcUrl, 'confirmed')
  }
  return connection
}

function getPublicConnection(): Connection {
  if (!publicConnection) {
    const url = process.env.PUBLIC_RPC_URL || 'https://solana-rpc.publicnode.com'
    publicConnection = new Connection(url, 'confirmed')
  }
  return publicConnection
}

// Try Helius first; if it fails (429/timeout), fall back to public RPC so
// dashboard refreshes don't get stuck when the Helius key is exhausted.
async function getBalanceLamportsWithFallback(address: string): Promise<number> {
  try {
    const conn = getConnection()
    return await conn.getBalance(new PublicKey(address))
  } catch (err) {
    const pub = getPublicConnection()
    return await pub.getBalance(new PublicKey(address))
  }
}

/** Native SOL balance for a wallet address, in SOL (float). */
export async function getNativeSolBalance(address: string): Promise<number> {
  const lamports = await getBalanceLamportsWithFallback(address)
  return lamports / LAMPORTS_PER_SOL
}

/** Native SOL balance for a wallet address, in lamports (bigint). */
export async function getNativeSolBalanceLamports(address: string): Promise<bigint> {
  const lamports = await getBalanceLamportsWithFallback(address)
  return BigInt(lamports)
}

/**
 * Verify that a confirmed transaction contains a SystemProgram transfer that
 * matches the expected source, destination, and lamport amount.
 */
export async function hasConfirmedSystemTransfer(params: {
  txSignature: string
  fromAddress: string
  toAddress: string
  lamports: bigint
}): Promise<boolean> {
  const conn = getConnection()
  const tx = await conn.getParsedTransaction(params.txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (!tx || tx.meta?.err) return false

  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix) || !ix.parsed || ix.program !== 'system') continue
    const parsed = ix.parsed as {
      type?: string
      info?: { source?: string; destination?: string; lamports?: number | string }
    }
    if (parsed.type !== 'transfer' || !parsed.info) continue
    const lamports = BigInt(parsed.info.lamports ?? 0)
    if (
      parsed.info.source === params.fromAddress &&
      parsed.info.destination === params.toAddress &&
      lamports === params.lamports
    ) {
      return true
    }
  }

  return false
}

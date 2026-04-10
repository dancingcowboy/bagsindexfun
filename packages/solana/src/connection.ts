import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'

let connection: Connection | null = null

export function getConnection(): Connection {
  if (!connection) {
    const rpcUrl = process.env.HELIUS_RPC_URL
    if (!rpcUrl) throw new Error('HELIUS_RPC_URL is required')
    connection = new Connection(rpcUrl, 'confirmed')
  }
  return connection
}

/** Native SOL balance for a wallet address, in SOL (float). */
export async function getNativeSolBalance(address: string): Promise<number> {
  const conn = getConnection()
  const lamports = await conn.getBalance(new PublicKey(address))
  return lamports / LAMPORTS_PER_SOL
}

/** Native SOL balance for a wallet address, in lamports (bigint). */
export async function getNativeSolBalanceLamports(address: string): Promise<bigint> {
  const conn = getConnection()
  const lamports = await conn.getBalance(new PublicKey(address))
  return BigInt(lamports)
}

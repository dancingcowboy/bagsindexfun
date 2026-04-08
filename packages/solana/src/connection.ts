import { Connection } from '@solana/web3.js'

let connection: Connection | null = null

export function getConnection(): Connection {
  if (!connection) {
    const rpcUrl = process.env.HELIUS_RPC_URL
    if (!rpcUrl) throw new Error('HELIUS_RPC_URL is required')
    connection = new Connection(rpcUrl, 'confirmed')
  }
  return connection
}

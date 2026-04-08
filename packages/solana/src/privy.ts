import { PrivyClient } from '@privy-io/server-auth'
import { VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

let client: PrivyClient | null = null

export function getPrivy(): PrivyClient {
  if (client) return client
  const appId = process.env.PRIVY_APP_ID
  const appSecret = process.env.PRIVY_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required')
  }
  client = new PrivyClient(appId, appSecret)
  return client
}

/**
 * Create a new Solana server wallet via Privy. Returns the walletId + address.
 * The private key never leaves Privy's HSM.
 */
export async function createSolanaServerWallet(): Promise<{
  walletId: string
  address: string
}> {
  const privy = getPrivy()
  const wallet = await privy.walletApi.createWallet({ chainType: 'solana' })
  return { walletId: wallet.id, address: wallet.address }
}

/**
 * Sign a base58-encoded VersionedTransaction with a Privy server wallet.
 * Returns the signed serialized bytes ready for submission.
 */
export async function signVersionedTxBase58(params: {
  walletId: string
  base58Tx: string
}): Promise<Uint8Array> {
  return signVersionedTxBytes({
    walletId: params.walletId,
    txBytes: bs58.decode(params.base58Tx),
  })
}

/**
 * Sign raw VersionedTransaction bytes with a Privy server wallet.
 */
export async function signVersionedTxBytes(params: {
  walletId: string
  txBytes: Uint8Array
}): Promise<Uint8Array> {
  const privy = getPrivy()
  const tx = VersionedTransaction.deserialize(params.txBytes)
  const res = await privy.walletApi.solana.signTransaction({
    walletId: params.walletId,
    transaction: tx,
  })
  return (res.signedTransaction as VersionedTransaction).serialize()
}

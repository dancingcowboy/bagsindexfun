import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { getConnection } from './connection.js'
import { signVersionedTxBytes } from './privy.js'
import { submitAndConfirmDirect } from './swap.js'

/**
 * Build, sign and submit a SOL transfer from a Privy server wallet to a
 * destination address. Returns the on-chain signature.
 *
 * Used by the withdrawal worker to send liquidated SOL back to the user's
 * connected wallet, and anywhere else the protocol moves native SOL out of
 * a sub-wallet.
 */
export async function transferSolFromServerWallet(params: {
  fromPrivyWalletId: string
  fromAddress: string
  toAddress: string
  lamports: bigint
}): Promise<string> {
  const connection = getConnection()
  const fromPubkey = new PublicKey(params.fromAddress)
  const toPubkey = new PublicKey(params.toAddress)

  const ix = SystemProgram.transfer({
    fromPubkey,
    toPubkey,
    lamports: params.lamports,
  })

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  const signed = await signVersionedTxBytes({
    walletId: params.fromPrivyWalletId,
    txBytes: tx.serialize(),
  })
  return submitAndConfirmDirect(signed)
}

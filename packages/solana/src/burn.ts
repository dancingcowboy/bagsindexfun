import {
  createBurnInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { getConnection } from './connection.js'

/**
 * Build an SPL token burn transaction.
 * Returns unsigned transaction bytes for Privy signing.
 */
export async function buildBurnTransaction(params: {
  ownerPublicKey: string
  tokenMint: string
  amount: bigint
}): Promise<Uint8Array> {
  const connection = getConnection()
  const owner = new PublicKey(params.ownerPublicKey)
  const mint = new PublicKey(params.tokenMint)

  const ata = await getAssociatedTokenAddress(mint, owner)

  const burnIx = createBurnInstruction(
    ata,
    mint,
    owner,
    params.amount,
    [],
    TOKEN_PROGRAM_ID
  )

  const { blockhash } = await connection.getLatestBlockhash('confirmed')

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [burnIx],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  return tx.serialize()
}

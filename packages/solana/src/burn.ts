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
 * Fetch the raw token balance (in base units) for a wallet's associated token
 * account for a given mint. Returns 0n if the ATA doesn't exist yet.
 */
export async function getAtaBalance(params: {
  ownerPublicKey: string
  tokenMint: string
}): Promise<bigint> {
  const connection = getConnection()
  const owner = new PublicKey(params.ownerPublicKey)
  const mint = new PublicKey(params.tokenMint)
  const ata = await getAssociatedTokenAddress(mint, owner)
  try {
    const bal = await connection.getTokenAccountBalance(ata, 'confirmed')
    return BigInt(bal.value.amount)
  } catch {
    return 0n
  }
}

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

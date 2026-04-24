import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'

export function buildDepositTransaction(
  fromPubkey: PublicKey,
  subWalletAddress: string,
  amountSol: number,
): Transaction {
  const toPubkey = new PublicKey(subWalletAddress)
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL)

  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports,
    }),
  )
}

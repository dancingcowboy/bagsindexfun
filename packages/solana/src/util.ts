import bs58 from 'bs58'

/** Encode raw transaction bytes as base58 (what Privy's sign API expects). */
export function toBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes)
}

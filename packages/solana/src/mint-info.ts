import { PublicKey } from '@solana/web3.js'
import { getConnection } from './connection.js'

/**
 * Batch-fetch SPL mint decimals. Reads the raw mint account and extracts
 * the decimals byte at offset 44 (SPL Token mint layout).
 * Chunked to 100 per getMultipleAccountsInfo call.
 */
export async function getMintDecimalsBatch(mints: string[]): Promise<Map<string, number>> {
  const connection = getConnection()
  const out = new Map<string, number>()
  const BATCH = 100
  for (let i = 0; i < mints.length; i += BATCH) {
    const slice = mints.slice(i, i + BATCH)
    const keys = slice.map((m) => new PublicKey(m))
    const accounts = await connection.getMultipleAccountsInfo(keys, 'confirmed')
    for (let j = 0; j < slice.length; j++) {
      const acc = accounts[j]
      if (acc && acc.data && acc.data.length >= 45) {
        out.set(slice[j], acc.data[44])
      }
    }
  }
  return out
}

import axios from 'axios'

function getApiKey(): string {
  const key = process.env.HELIUS_API_KEY
  if (!key) throw new Error('HELIUS_API_KEY is required')
  return key
}

/**
 * Get holder count for a token mint via Helius DAS API.
 */
export async function getHolderCount(
  tokenMint: string,
  opts?: { maxPages?: number }
): Promise<number> {
  const apiKey = getApiKey()
  // Helius DAS getTokenAccounts does NOT return a reliable `total`; we have to
  // paginate. Default cap is 5 pages (≤5000 holders) for the Bags path. The
  // DexScreener admin worker passes maxPages: 1 to keep Helius budget ≤30/cycle.
  const maxPages = opts?.maxPages ?? 5
  let cursor: string | undefined
  let total = 0
  for (let page = 0; page < maxPages; page++) {
    const res = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        jsonrpc: '2.0',
        id: 'bags-index',
        method: 'getTokenAccounts',
        params: { mint: tokenMint, limit: 1000, ...(cursor ? { cursor } : {}) },
      },
      { timeout: 20_000 }
    )
    const result = res.data.result
    const accounts = result?.token_accounts ?? []
    total += accounts.length
    if (accounts.length < 1000) break
    cursor = result?.cursor
    if (!cursor) break
  }
  return total
}

/**
 * Get token metadata via Helius DAS API.
 */
export async function getTokenMetadata(tokenMint: string) {
  const apiKey = getApiKey()
  const res = await axios.post(
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    {
      jsonrpc: '2.0',
      id: 'bags-index',
      method: 'getAsset',
      params: { id: tokenMint },
    },
    { timeout: 15_000 }
  )
  return res.data.result
}

/**
 * Get token metadata for multiple mints in one call via Helius DAS API.
 * Max 1000 per batch.
 */
export async function getTokenMetadataBatch(tokenMints: string[]) {
  const apiKey = getApiKey()
  const res = await axios.post(
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    {
      jsonrpc: '2.0',
      id: 'bags-index',
      method: 'getAssetBatch',
      params: { ids: tokenMints },
    },
    { timeout: 30_000 }
  )
  return res.data.result as Array<{
    id: string
    content: {
      metadata: { name: string; symbol: string }
      links?: { image?: string }
    }
  }>
}

/**
 * Get token balances for a wallet via Helius enhanced API.
 */
export async function getTokenBalances(walletAddress: string) {
  const apiKey = getApiKey()
  const res = await axios.get(
    `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${apiKey}`,
    { timeout: 15_000 }
  )
  return res.data
}

/**
 * Submit a base64-encoded signed VersionedTransaction via the Helius "Sender"
 * staked-connection endpoint with Jito bundle protection.
 * Returns the signature string.
 */
export async function sendJitoProtected(signedTxBase64: string): Promise<string> {
  const apiKey = getApiKey()
  let res: any
  try {
    res = await axios.post(
      `https://sender.helius-rpc.com/fast?api-key=${apiKey}`,
      {
        jsonrpc: '2.0',
        id: 'bags-index-send',
        method: 'sendTransaction',
        params: [
          signedTxBase64,
          { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
        ],
      },
      { timeout: 20_000 }
    )
  } catch (err: any) {
    const body = err?.response?.data
    console.error(`[helius] Sender HTTP ${err?.response?.status}: ${JSON.stringify(body)?.slice(0, 2000)}`)
    throw err
  }
  if (res.data.error) {
    throw new Error(`Helius sender error: ${res.data.error.message || JSON.stringify(res.data.error)}`)
  }
  return res.data.result as string
}

/**
 * Fetch the on-chain quote-token liquidity (in SOL) for a token's primary
 * Bags/Meteora pool via Jupiter's price+liquidity endpoint.
 */
export async function getTokenSolLiquidity(tokenMint: string): Promise<number> {
  try {
    const jupKey = process.env.JUPITER_API_KEY
    const base = jupKey ? 'https://api.jup.ag/price/v2' : 'https://lite-api.jup.ag/price/v2'
    const headers: Record<string, string> = jupKey ? { 'x-api-key': jupKey } : {}
    const res = await axios.get(
      `${base}?ids=${tokenMint}&showExtraInfo=true`,
      { headers, timeout: 10_000 }
    )
    const info = res.data?.data?.[tokenMint]
    const liq = info?.extraInfo?.depth?.buyPriceImpactRatio?.depth?.['1000'] ?? 0
    // Fallback: use confidence-weighted depth if direct field absent
    return Number(liq) || 0
  } catch {
    return 0
  }
}

/**
 * Get parsed transaction history for a wallet.
 */
export async function getTransactionHistory(walletAddress: string, limit = 50) {
  const apiKey = getApiKey()
  const res = await axios.get(
    `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=${limit}`,
    { timeout: 15_000 }
  )
  return res.data
}

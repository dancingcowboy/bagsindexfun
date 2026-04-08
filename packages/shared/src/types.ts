// ─── Token Scoring ───────────────────────────────────────────────────────────

export interface TokenData {
  tokenMint: string
  tokenSymbol: string
  tokenName: string
  image?: string
  volume24h: number
  holderCount: number
  holderGrowthPct: number
  priceUsd: number
  liquidityUsd: number
}

export interface ScoredToken extends TokenData {
  compositeScore: number
  rank: number
  weightPct: number
}

export interface IndexComposition {
  cycleId: string
  scoredAt: string
  tokens: ScoredToken[]
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface PortfolioHolding {
  tokenMint: string
  tokenSymbol: string
  tokenName: string
  amount: string
  valueSol: string
  allocationPct: number
}

export interface Portfolio {
  totalValueSol: string
  totalValueUsd: string
  holdings: PortfolioHolding[]
  lastRebalancedAt: string | null
}

// ─── Deposits & Withdrawals ─────────────────────────────────────────────────

export type TxStatusType = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'PARTIAL'

export interface DepositIntent {
  amountSol: number
}

export interface DepositResponse {
  id: string
  subWalletAddress: string
  amountSol: string
  feeSol: string
  netAmountSol: string
  status: TxStatusType
}

export interface WithdrawalResponse {
  id: string
  estimatedSol: string
  feeSol: string
  netSol: string
  status: TxStatusType
}

// ─── Bags API Types ─────────────────────────────────────────────────────────

export interface BagsTokenFeedItem {
  name: string
  symbol: string
  description: string
  image: string
  tokenMint: string
  status: 'PRE_LAUNCH' | 'PRE_GRAD' | 'MIGRATING' | 'MIGRATED'
  twitter: string | null
  website: string | null
  launchSignature: string | null
  dbcPoolKey: string | null
  dammV2PoolKey: string | null
}

export interface BagsTradeQuote {
  requestId: string
  contextSlot: number
  inAmount: string
  inputMint: string
  outAmount: string
  outputMint: string
  minOutAmount: string
  priceImpactPct: string
  slippageBps: number
  routePlan: Array<{
    venue: string
    inAmount: string
    outAmount: string
    inputMint: string
    outputMint: string
  }>
}

export interface BagsSwapResponse {
  swapTransaction: string
  computeUnitLimit: number
  lastValidBlockHeight: number
  prioritizationFeeLamports: number
}

// ─── Risk Tiers ─────────────────────────────────────────────────────────────

export type RiskTierType = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

export interface TierAllocation {
  tier: RiskTierType
  allocations: Array<{
    tokenMint: string
    tokenSymbol: string
    tokenName: string
    weightPct: number
    reasoning: string
    confidence: string
    signals: string[]
  }>
}

export interface AnalysisResult {
  summary: string
  sentiment: string
  keyInsights: string[]
  reasoning: string
  tiers: TierAllocation[]
}

// ─── Rebalance ──────────────────────────────────────────────────────────────

export interface RebalanceDelta {
  tokenMint: string
  currentPct: number
  targetPct: number
  action: 'BUY' | 'SELL' | 'HOLD'
  amountSol: number
}

// ─── Burn ───────────────────────────────────────────────────────────────────

export interface BurnStats {
  totalTokensBurned: string
  totalSolSpent: string
  burnCount: number
}

// ─── API Responses ──────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean
  data: T
  error?: string
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number
  page: number
  limit: number
}

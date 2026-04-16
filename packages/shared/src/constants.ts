// ─── Platform Token Exposure ─────────────────────────────────────────────────

/**
 * Every index vault (user + protocol system vault) holds a fixed 10% slice in
 * $BAGSX, the platform token. Every participant is directly exposed to the
 * platform's upside via native token holdings. No deposit, withdrawal, or
 * switch fees. Sold back to SOL on withdrawal like any other holding.
 */
export const BAGSX_MINT = 'DTp6oMA51WydSAcqY8cgYCFTtQXcQHNq5geCSgrwBAGS'
export const BAGSX_WEIGHT_PCT = 10

// ─── Risk Tiers ─────────────────────────────────────────────────────────────

export const RISK_TIERS = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

export const RISK_TIER_CONFIG = {
  CONSERVATIVE: {
    label: 'Conservative',
    description: 'Established tokens with deep liquidity and stable holder bases. Lower risk, steadier returns.',
    tokenCount: 10,
    color: '#00b8ff',
    icon: 'Shield',
  },
  BALANCED: {
    label: 'Balanced',
    description: 'Mix of proven performers and emerging tokens. The default index fund experience.',
    tokenCount: 10,
    color: '#00D62B',
    icon: 'BarChart3',
  },
  DEGEN: {
    label: 'Degen',
    description: 'High momentum, newer tokens, bigger swings. Maximum upside potential with higher risk.',
    tokenCount: 10,
    color: '#ff8c00',
    icon: 'Zap',
  },
} as const

// ─── Index ───────────────────────────────────────────────────────────────────

/** Number of top tokens per tier */
export const TOP_N_TOKENS = 10

/** Minimum liquidity in USD to qualify for index */
export const MIN_LIQUIDITY_USD = 50_000

/** Holder drop threshold for auto-blacklist (20% in 4 hours) */
export const HOLDER_DROP_BLACKLIST_PCT = 20

/** Default scoring weights (BALANCED tier) */
export const SCORE_WEIGHT_VOLUME = 0.5
export const SCORE_WEIGHT_HOLDER_GROWTH = 0.3
export const SCORE_WEIGHT_LIQUIDITY = 0.2

/** Holder-growth blend: 24h gets 40%, 7d gets 60% (catches both fresh momentum and sustained traction) */
export const HOLDER_GROWTH_24H_WEIGHT = 0.4
export const HOLDER_GROWTH_7D_WEIGHT = 0.6

/** Volume sanity check — wash-trading filter.
 *  A token is downweighted if its volume-per-unique-trader exceeds this multiple of the median.
 *  e.g. if median V/trader is $50 and a token shows $5,000/trader, it's likely wash trading. */
export const WASH_TRADE_RATIO_THRESHOLD = 10
/** Tokens failing the sanity check have their volume score multiplied by this penalty */
export const WASH_TRADE_PENALTY = 0.25
/** Minimum unique traders in 24h to even be considered (filters dead tokens) */
export const MIN_UNIQUE_TRADERS_24H = 25

/** Daily rebalance threshold — only execute a rebalance if at least N positions change.
 *  Prevents fee bleed from constant micro-shuffling when scores are noisy at the boundary. */
export const REBALANCE_MIN_RANK_CHANGES = 2

/** Per-tier max rebalance frequency in hours.
 *  The scoring run is daily, but a tier can choose to NOT rebalance even if scores changed,
 *  to save fees. Capped at every 12h — never weekly (too much drift, dangerous on memes). */
export const TIER_REBALANCE_HOURS = {
  CONSERVATIVE: 24, // daily
  BALANCED: 12,     // twice daily
  DEGEN: 4,         // six times daily — chase momentum before it fades
} as const

// ─── Per-Tier Scoring Configs ────────────────────────────────────────────────

/** Each tier reweights the same signals to express a different risk philosophy. */
export const TIER_SCORING_CONFIG = {
  CONSERVATIVE: {
    weights: { volume: 0.30, holderGrowth: 0.40, liquidity: 0.30 },
    minLiquidityUsd: 8_000,
    minMarketCapUsd: 20_000,
    minHolderCount: 200,
    minAgeDays: 5,
    maxVolatility7d: 0.6,
    /** SOL anchor allocation — Conservative holds 12% SOL + 10% BAGSX (exposure). */
    solAnchorPct: 12,
  },
  BALANCED: {
    weights: { volume: 0.50, holderGrowth: 0.30, liquidity: 0.20 },
    minLiquidityUsd: 10_000,
    minMarketCapUsd: 20_000,
    minHolderCount: 150,
    minAgeDays: 3,
    maxVolatility7d: 1.5,
    solAnchorPct: 0,
  },
  DEGEN: {
    weights: { volume: 0.35, holderGrowth: 0.55, liquidity: 0.10 },
    minLiquidityUsd: 5_000,
    minMarketCapUsd: 20_000,
    minHolderCount: 50,
    minAgeDays: 0,
    maxVolatility7d: 5.0,
    /** Degen rejects anything older than 90 days — always hunting fresh tokens. */
    maxAgeDays: 90,
    solAnchorPct: 0,
  },
} as const

/**
 * Max weight any single token can hold within a tier. Prevents a backfilled
 * dominator (e.g. AEGIS in DEGEN) from crushing a thin pool. Excess weight is
 * redistributed proportionally to the other holdings via iterative capping.
 */
export const MAX_TOKEN_WEIGHT_PCT = 0.25

// ─── Solana ──────────────────────────────────────────────────────────────────

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const SOL_DECIMALS = 9
export const LAMPORTS_PER_SOL = 1_000_000_000

/** Reserve SOL kept in every sub-wallet at all times — funds gas for future
 *  sells/rebalances. Without it, a pool can get stuck if every lamport is in
 *  token positions and a sell transaction can't pay its fee. */
export const WALLET_RESERVE_SOL = 0.05

/** Estimated gas cost for a single Bags fee-claim tx (no Jito tip, base
 *  fee + priority fee as built by Bags). A position can return up to 2
 *  legs (virtual-pool + DAMM), so worst-case gas per position is 2x. */
export const FEE_CLAIM_GAS_PER_TX_LAMPORTS = 15_000n

/** Minimum claimable-to-gas ratio before we bother claiming a position.
 *  3× gas means we only autoclaim when the fees are at least triple the
 *  worst-case gas cost — otherwise the tx fee eats the reward. */
export const FEE_CLAIM_MIN_MULTIPLE = 3n

// ─── Swaps ───────────────────────────────────────────────────────────────────

/** Default slippage for index rebalance swaps (3%) */
export const DEFAULT_SLIPPAGE_BPS = 300

/** Max slippage cap (5%) */
export const MAX_SLIPPAGE_BPS = 500

/** Max retries for failed swaps */
export const MAX_SWAP_RETRIES = 3

// ─── Bags API ────────────────────────────────────────────────────────────────

export const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1'

// ─── Queue Names ─────────────────────────────────────────────────────────────

export const QUEUE_SCORING = 'scoring'
export const QUEUE_REBALANCE = 'rebalance'
export const QUEUE_DEPOSIT = 'deposit-allocation'
export const QUEUE_WITHDRAWAL = 'withdrawal-liquidation'
export const QUEUE_ANALYSIS = 'analysis'
export const QUEUE_FEE_CLAIM = 'fee-claim'
export const QUEUE_PRICE_SNAPSHOT = 'price-snapshot'
export const QUEUE_SWITCH = 'switch'
export const QUEUE_VAULT_SWITCH = 'vault-switch'
export const QUEUE_DEX_SCORING = 'dex-scoring'

// DexScreener admin hotlist universe size (separate from TOP_N_TOKENS)
export const DEXSCREENER_UNIVERSE_SIZE = 30

/** Wrapped SOL mint — reference for SOL-denominated valuation. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'

/** How often to auto-claim accrued Bags trading fees from the vault wallet */
export const FEE_CLAIM_INTERVAL_HOURS = 4

// ─── Rebalance Batching ──────────────────────────────────────────────────────

/** Wallets per batch during rebalance */
export const REBALANCE_BATCH_SIZE = 20

/** Delay between batches in ms */
export const REBALANCE_BATCH_DELAY_MS = 500

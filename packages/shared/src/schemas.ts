import { z } from 'zod'

// ─── Auth ────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  privyToken: z.string().min(1),
})

// ─── Risk Tiers ─────────────────────────────────────────────────────────────

export const riskTierSchema = z.enum(['CONSERVATIVE', 'BALANCED', 'DEGEN'])

export const setRiskTierSchema = z.object({
  tier: riskTierSchema,
})

// ─── Deposits ────────────────────────────────────────────────────────────────

export const createDepositSchema = z.object({
  riskTier: riskTierSchema,
  amountSol: z.number().positive().max(10_000),
})

export const confirmDepositSchema = z.object({
  txSignature: z.string().min(64).max(128),
})

// ─── Withdrawals ─────────────────────────────────────────────────────────────

export const createWithdrawalSchema = z.object({
  riskTier: riskTierSchema,
  /** If omitted, withdraw everything */
  amountSol: z.number().positive().optional(),
})

// ─── Tier Switch ─────────────────────────────────────────────────────────────

export const createSwitchSchema = z
  .object({
    fromTier: riskTierSchema,
    toTier: riskTierSchema,
  })
  .refine((v) => v.fromTier !== v.toTier, {
    message: 'fromTier and toTier must differ',
  })

// ─── Projects (Bags App fee-share vaults) ───────────────────────────────────

export const registerProjectVaultSchema = z.object({
  sourceTokenMint: z.string().min(32).max(64),
  sourceSymbol: z.string().min(1).max(32),
  sourceName: z.string().min(1).max(100),
  sourceImageUrl: z.string().url().max(500).optional(),
  /** BPS share of the token's trading fees, 1–10000 */
  feeShareBps: z.number().int().min(1).max(10_000),
  riskTier: riskTierSchema,
  // ownerWallet is derived server-side from the authenticated user, not from the body.
  twitter: z.string().max(200).optional(),
  website: z.string().url().max(500).optional(),
})

// ─── Admin ───────────────────────────────────────────────────────────────────

export const blacklistTokenSchema = z.object({
  tokenMint: z.string().min(32).max(64),
  reason: z.string().min(1).max(500),
})

// ─── Pagination ──────────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

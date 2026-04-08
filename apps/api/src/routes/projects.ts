import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { registerProjectVaultSchema } from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'

const PROJECT_TIMELOCK_DAYS = 30

/**
 * /projects — public leaderboard + vault registration for Bags token projects.
 *
 * Projects add a vault address to their Bags `/fee-share/config` `claimersArray`
 * with some BPS. Those fees flow on-chain. This route just tracks metadata and
 * renders the public leaderboard — the actual money movement happens via Bags.
 */
export async function projectRoutes(app: FastifyInstance) {
  /**
   * GET /projects — public leaderboard
   */
  app.get('/', async (_req, reply) => {
    try {
      const vaults = await db.projectVault.findMany({
        orderBy: { currentValueSol: 'desc' },
        take: 100,
      })
      return {
        success: true,
        data: vaults.map((v) => ({
          sourceTokenMint: v.sourceTokenMint,
          sourceSymbol: v.sourceSymbol,
          sourceName: v.sourceName,
          sourceImageUrl: v.sourceImageUrl,
          vaultAddress: v.vaultAddress,
          feeShareBps: v.feeShareBps,
          feeSharePct: (v.feeShareBps / 100).toFixed(2),
          riskTier: v.riskTier,
          twitter: v.twitter,
          website: v.website,
          totalSolReceived: v.totalSolReceived.toString(),
          currentValueSol: v.currentValueSol.toString(),
          unlocksAt: v.unlocksAt,
          createdAt: v.createdAt,
          lastFundedAt: v.lastFundedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to list projects')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /projects/:mint — single project detail
   */
  app.get('/:mint', async (req, reply) => {
    try {
      const { mint } = req.params as { mint: string }
      const vault = await db.projectVault.findUnique({
        where: { sourceTokenMint: mint },
      })
      if (!vault) {
        return reply.status(404).send({ error: 'Project vault not found' })
      }
      return {
        success: true,
        data: {
          sourceTokenMint: vault.sourceTokenMint,
          sourceSymbol: vault.sourceSymbol,
          sourceName: vault.sourceName,
          sourceImageUrl: vault.sourceImageUrl,
          vaultAddress: vault.vaultAddress,
          feeShareBps: vault.feeShareBps,
          feeSharePct: (vault.feeShareBps / 100).toFixed(2),
          riskTier: vault.riskTier,
          ownerWallet: vault.ownerWallet,
          twitter: vault.twitter,
          website: vault.website,
          totalSolReceived: vault.totalSolReceived.toString(),
          currentValueSol: vault.currentValueSol.toString(),
          unlocksAt: vault.unlocksAt,
          createdAt: vault.createdAt,
          lastFundedAt: vault.lastFundedAt,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get project')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /projects — register a new project vault.
   *
   * Security model:
   * - GETs are public (leaderboard data).
   * - POST requires a valid Privy-backed JWT. ownerWallet is derived from
   *   the authenticated user's walletAddress, not from the request body —
   *   no arbitrary ownerWallet squatting.
   * - Per-route rate limit (5/min/IP) on top of the global auth limit.
   * - Uniqueness on `sourceTokenMint` prevents duplicate rows per mint.
   *
   * NOTE: Privy Server Wallet creation is stubbed until keys are configured.
   * A deterministic pending address is reserved so the row is usable.
   */
  app.post(
    '/',
    {
      preHandler: [requireAuth],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
    try {
      const parsed = registerProjectVaultSchema.parse(req.body)
      const ownerWallet = req.authUser!.walletAddress

      const existing = await db.projectVault.findUnique({
        where: { sourceTokenMint: parsed.sourceTokenMint },
      })
      if (existing) {
        return reply.status(409).send({ error: 'Vault already exists for this token' })
      }

      // TODO: privy.walletApi.create() when keys are configured
      const pendingId = `project-${parsed.sourceTokenMint.slice(0, 12)}`

      const unlocksAt = new Date(Date.now() + PROJECT_TIMELOCK_DAYS * 24 * 60 * 60 * 1000)

      const vault = await db.projectVault.create({
        data: {
          sourceTokenMint: parsed.sourceTokenMint,
          sourceSymbol: parsed.sourceSymbol,
          sourceName: parsed.sourceName,
          sourceImageUrl: parsed.sourceImageUrl,
          vaultAddress: pendingId,
          privyWalletId: pendingId,
          feeShareBps: parsed.feeShareBps,
          riskTier: parsed.riskTier,
          ownerWallet,
          twitter: parsed.twitter,
          website: parsed.website,
          unlocksAt,
        },
      })

      return {
        success: true,
        data: {
          id: vault.id,
          vaultAddress: vault.vaultAddress,
          unlocksAt: vault.unlocksAt,
          instructions: {
            step1: `Add this vault address to your Bags fee-share claimersArray: ${vault.vaultAddress}`,
            step2: `Allocate ${parsed.feeShareBps} BPS (${(parsed.feeShareBps / 100).toFixed(2)}%) to this address`,
            step3: `New launch: include in your initial /fee-share/config. Existing token: your fee admin calls /fee-share/admin/update-config to add the vault. Fees flow automatically afterward.`,
            docsNewLaunch: 'https://docs.bags.fm/api-reference/create-fee-share-configuration',
            docsExisting: 'https://docs.bags.fm/api-reference/create-fee-share-admin-update-config',
          },
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to register project vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
    },
  )
}

import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { CUSTOM_VAULT_MIN_INTERVAL_SEC } from '@bags-index/shared'
import { createSolanaServerWallet } from '@bags-index/solana'
import { requireAuth } from '../middleware/auth.js'
import { customVaultQueue } from '../queue/queues.js'

export async function customVaultRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * GET /custom-vaults — list user's custom vaults
   */
  app.get('/', async (req) => {
    const userId = req.authUser!.userId
    const vaults = await db.customVault.findMany({
      where: { subWallet: { userId } },
      include: {
        subWallet: {
          select: {
            id: true,
            address: true,
            holdings: {
              select: {
                tokenMint: true,
                amount: true,
                valueSolEst: true,
                costBasisSol: true,
                realizedPnlSol: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return { data: vaults }
  })

  /**
   * GET /custom-vaults/:id — single vault detail
   */
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
      include: {
        subWallet: {
          select: {
            id: true,
            address: true,
            holdings: {
              select: {
                tokenMint: true,
                amount: true,
                valueSolEst: true,
                costBasisSol: true,
                realizedPnlSol: true,
                totalSoldSol: true,
              },
            },
          },
        },
      },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })
    return { data: vault }
  })

  /**
   * POST /custom-vaults — create a personal vault
   * Body: { tokenMints: string[], rebalanceIntervalSec?: number, name?: string }
   */
  app.post<{
    Body: { tokenMints: string[]; rebalanceIntervalSec?: number }
  }>('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const { tokenMints, rebalanceIntervalSec = CUSTOM_VAULT_MIN_INTERVAL_SEC } = req.body

      if (!Array.isArray(tokenMints) || tokenMints.length === 0) {
        return reply.status(400).send({ error: 'tokenMints[] required (at least 1 token)' })
      }
      if (tokenMints.length > 20) {
        return reply.status(400).send({ error: 'Max 20 tokens per vault' })
      }
      if (rebalanceIntervalSec < CUSTOM_VAULT_MIN_INTERVAL_SEC) {
        return reply
          .status(400)
          .send({ error: `rebalanceIntervalSec must be >= ${CUSTOM_VAULT_MIN_INTERVAL_SEC}` })
      }

      // Limit: max 3 custom vaults per user
      const existing = await db.customVault.count({
        where: { subWallet: { userId } },
      })
      if (existing >= 3) {
        return reply.status(400).send({ error: 'Max 3 personal vaults allowed' })
      }

      const { walletId, address } = await createSolanaServerWallet()

      const subWallet = await db.subWallet.create({
        data: {
          userId,
          privyWalletId: walletId,
          address,
          riskTier: null,
        },
      })

      const vault = await db.customVault.create({
        data: {
          subWalletId: subWallet.id,
          tokenMints,
          rebalanceIntervalSec,
        },
      })

      // Register repeatable scheduler
      await customVaultQueue.upsertJobScheduler(
        `custom-vault-${vault.id}`,
        { every: rebalanceIntervalSec * 1000 },
        { name: `custom-vault-${vault.id}`, data: { customVaultId: vault.id } },
      )

      return { data: { vault, subWallet: { id: subWallet.id, address } } }
    } catch (err) {
      app.log.error(err, 'Failed to create custom vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * PATCH /custom-vaults/:id — update token list, interval, or name
   */
  app.patch<{
    Params: { id: string }
    Body: { tokenMints?: string[]; rebalanceIntervalSec?: number }
  }>('/:id', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const vault = await db.customVault.findFirst({
        where: { id: req.params.id, subWallet: { userId } },
      })
      if (!vault) return reply.status(404).send({ error: 'Not found' })

      const { tokenMints, rebalanceIntervalSec } = req.body
      if (tokenMints && tokenMints.length > 20) {
        return reply.status(400).send({ error: 'Max 20 tokens per vault' })
      }
      if (
        rebalanceIntervalSec !== undefined &&
        rebalanceIntervalSec < CUSTOM_VAULT_MIN_INTERVAL_SEC
      ) {
        return reply
          .status(400)
          .send({ error: `rebalanceIntervalSec must be >= ${CUSTOM_VAULT_MIN_INTERVAL_SEC}` })
      }

      const updated = await db.customVault.update({
        where: { id: vault.id },
        data: {
          ...(tokenMints ? { tokenMints } : {}),
          ...(rebalanceIntervalSec ? { rebalanceIntervalSec } : {}),
        },
      })

      if (rebalanceIntervalSec) {
        await customVaultQueue.upsertJobScheduler(
          `custom-vault-${vault.id}`,
          { every: rebalanceIntervalSec * 1000 },
          { name: `custom-vault-${vault.id}`, data: { customVaultId: vault.id } },
        )
      }

      return { data: updated }
    } catch (err) {
      app.log.error(err, 'Failed to update custom vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /custom-vaults/:id/pause
   */
  app.post<{ Params: { id: string } }>('/:id/pause', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    await db.customVault.update({ where: { id: vault.id }, data: { status: 'PAUSED' } })
    await customVaultQueue.removeJobScheduler(`custom-vault-${vault.id}`)
    return { data: { status: 'PAUSED' } }
  })

  /**
   * POST /custom-vaults/:id/resume
   */
  app.post<{ Params: { id: string } }>('/:id/resume', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    await db.customVault.update({ where: { id: vault.id }, data: { status: 'ACTIVE' } })
    await customVaultQueue.upsertJobScheduler(
      `custom-vault-${vault.id}`,
      { every: vault.rebalanceIntervalSec * 1000 },
      { name: `custom-vault-${vault.id}`, data: { customVaultId: vault.id } },
    )
    return { data: { status: 'ACTIVE' } }
  })

  /**
   * POST /custom-vaults/:id/rebalance — trigger immediate rebalance
   */
  app.post<{ Params: { id: string } }>('/:id/rebalance', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    await customVaultQueue.add(`manual-${vault.id}-${Date.now()}`, {
      customVaultId: vault.id,
    })
    return { data: { queued: true } }
  })

  /**
   * DELETE /custom-vaults/:id — remove vault + scheduler
   * Holdings remain in the sub-wallet until user withdraws.
   */
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    await customVaultQueue.removeJobScheduler(`custom-vault-${vault.id}`)
    await db.customVault.delete({ where: { id: vault.id } })
    return { data: { deleted: true } }
  })
}

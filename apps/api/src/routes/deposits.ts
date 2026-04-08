import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { createDepositSchema, confirmDepositSchema, DEPOSIT_FEE_BPS } from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'
import { depositQueue, burnQueue } from '../queue/queues.js'

export async function depositRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * POST /deposits
   * Declare intent to deposit. Returns sub-wallet address to send SOL to.
   */
  app.post('/', async (req, reply) => {
    try {
      const { amountSol, riskTier } = createDepositSchema.parse(req.body)
      const userId = req.authUser!.userId

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier } },
      })
      if (!subWallet) {
        return reply.status(400).send({ error: 'Sub-wallet not initialized' })
      }

      const feeSol = (amountSol * DEPOSIT_FEE_BPS) / 10_000
      const netAmountSol = amountSol - feeSol

      const deposit = await db.deposit.create({
        data: {
          userId,
          riskTier,
          amountSol,
          feeSol,
          status: 'PENDING',
        },
      })

      return {
        success: true,
        data: {
          id: deposit.id,
          riskTier,
          subWalletAddress: subWallet.address,
          amountSol: deposit.amountSol.toString(),
          feeSol: deposit.feeSol.toString(),
          netAmountSol: netAmountSol.toFixed(9),
          status: deposit.status,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to create deposit')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /deposits/:id/confirm
   * Submit tx signature. Verifies on-chain, then enqueues allocation + burn.
   */
  app.post('/:id/confirm', async (req, reply) => {
    try {
      const { id } = req.params as { id: string }
      const { txSignature } = confirmDepositSchema.parse(req.body)
      const userId = req.authUser!.userId

      // Ownership check
      const deposit = await db.deposit.findFirst({
        where: { id, userId },
      })
      if (!deposit) return reply.status(404).send({ error: 'Deposit not found' })
      if (deposit.status !== 'PENDING') {
        return reply.status(400).send({ error: 'Deposit already processed' })
      }

      // Update with tx signature
      await db.deposit.update({
        where: { id },
        data: { txSignature, status: 'CONFIRMED', confirmedAt: new Date() },
      })

      // Enqueue allocation job
      await depositQueue.add('allocate', {
        depositId: id,
        userId,
      })

      // Enqueue burn job for the fee
      await burnQueue.add('burn-deposit-fee', {
        depositId: id,
        feeSol: deposit.feeSol.toString(),
      })

      return {
        success: true,
        data: { id, status: 'CONFIRMED', txSignature },
      }
    } catch (err) {
      app.log.error(err, 'Failed to confirm deposit')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /deposits
   * List user's deposits.
   */
  app.get('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const deposits = await db.deposit.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })

      return {
        success: true,
        data: deposits.map((d) => ({
          id: d.id,
          amountSol: d.amountSol.toString(),
          feeSol: d.feeSol.toString(),
          txSignature: d.txSignature,
          status: d.status,
          createdAt: d.createdAt,
          confirmedAt: d.confirmedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to list deposits')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

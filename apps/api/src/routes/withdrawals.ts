import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { createWithdrawalSchema } from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'
import { withdrawalQueue } from '../queue/queues.js'

export async function withdrawalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * POST /withdrawals
   * Request withdrawal — enqueues liquidation of all holdings.
   */
  app.post('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const { riskTier } = createWithdrawalSchema.parse(req.body)

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier } },
        include: { holdings: true },
      })
      if (!subWallet) {
        return reply.status(400).send({ error: 'No sub-wallet found' })
      }
      if (subWallet.holdings.length === 0) {
        return reply.status(400).send({ error: 'No holdings to withdraw' })
      }

      const totalValueSol = subWallet.holdings.reduce(
        (sum, h) => sum + Number(h.valueSolEst),
        0
      )
      // No withdrawal fee — user receives 100% of vault value (the BAGSX
      // slice is sold alongside every other holding by the worker).
      const feeSol = 0
      const netSol = totalValueSol

      const withdrawal = await db.withdrawal.create({
        data: {
          userId,
          riskTier,
          amountSol: totalValueSol,
          feeSol,
          status: 'PENDING',
        },
      })

      await withdrawalQueue.add('liquidate', {
        withdrawalId: withdrawal.id,
        userId,
        subWalletId: subWallet.id,
      })

      return {
        success: true,
        data: {
          id: withdrawal.id,
          estimatedSol: totalValueSol.toFixed(9),
          feeSol: feeSol.toFixed(9),
          netSol: netSol.toFixed(9),
          status: withdrawal.status,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to create withdrawal')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /withdrawals
   * List user's withdrawals.
   */
  app.get('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const withdrawals = await db.withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })

      return {
        success: true,
        data: withdrawals.map((w) => ({
          id: w.id,
          amountSol: w.amountSol.toString(),
          feeSol: w.feeSol.toString(),
          txSignature: w.txSignature,
          status: w.status,
          createdAt: w.createdAt,
          confirmedAt: w.confirmedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to list withdrawals')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

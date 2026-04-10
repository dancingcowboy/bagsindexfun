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
      const { riskTier, pct } = createWithdrawalSchema.parse(req.body)
      const withdrawPct = pct ?? 100 // default: liquidate everything

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
      const estimatedSol = totalValueSol * (withdrawPct / 100)
      // No withdrawal fee — user receives 100% of vault value (the BAGSX
      // slice is sold alongside every other holding by the worker).
      const feeSol = 0

      const withdrawal = await db.withdrawal.create({
        data: {
          userId,
          riskTier,
          amountSol: estimatedSol,
          feeSol,
          status: 'PENDING',
        },
      })

      await withdrawalQueue.add('liquidate', {
        withdrawalId: withdrawal.id,
        userId,
        subWalletId: subWallet.id,
        pct: withdrawPct,
      })

      return {
        success: true,
        data: {
          id: withdrawal.id,
          riskTier,
          pct: withdrawPct,
          estimatedSol: estimatedSol.toFixed(9),
          feeSol: feeSol.toFixed(9),
          netSol: estimatedSol.toFixed(9),
          status: withdrawal.status,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to create withdrawal')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /withdrawals/:id/retry
   * Re-enqueue a PARTIAL withdrawal so the worker retries unsold holdings.
   */
  app.post<{ Params: { id: string } }>('/:id/retry', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const withdrawal = await db.withdrawal.findFirst({
        where: { id: req.params.id, userId },
      })
      if (!withdrawal) {
        return reply.status(404).send({ error: 'Withdrawal not found' })
      }
      if (withdrawal.status !== 'PARTIAL') {
        return reply.status(400).send({ error: `Cannot retry — status is ${withdrawal.status}` })
      }

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: withdrawal.riskTier } },
      })
      if (!subWallet) {
        return reply.status(400).send({ error: 'Sub-wallet not found' })
      }

      await db.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'PENDING' },
      })

      await withdrawalQueue.add('liquidate', {
        withdrawalId: withdrawal.id,
        userId,
        subWalletId: subWallet.id,
        pct: 100,
      })

      return { success: true, data: { id: withdrawal.id, status: 'PENDING' } }
    } catch (err) {
      app.log.error(err, 'Failed to retry withdrawal')
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

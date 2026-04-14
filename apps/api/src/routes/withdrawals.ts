import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { createWithdrawalSchema, SOL_MINT } from '@bags-index/shared'
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

      // Block only on PENDING (actively running). PARTIAL is terminal —
      // holdings have moved on (rebalances), so a new withdrawal against
      // current vault state is the right UX. Old PARTIAL rows remain in
      // history and can still be retried explicitly via /:id/retry.
      const inflight = await db.withdrawal.findFirst({
        where: {
          userId,
          riskTier,
          status: 'PENDING',
        },
      })
      if (inflight) {
        return reply.status(409).send({ error: 'Withdrawal already in progress for this tier' })
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
   * GET /withdrawals/:id/progress
   * Live liquidation progress. Polls swap executions (sells) since the
   * withdrawal was created so the frontend can show a live log.
   */
  app.get<{ Params: { id: string } }>('/:id/progress', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const withdrawal = await db.withdrawal.findFirst({
        where: { id: req.params.id, userId },
      })
      if (!withdrawal) return reply.status(404).send({ error: 'Withdrawal not found' })

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: withdrawal.riskTier } },
        select: { id: true },
      })

      const since = withdrawal.createdAt
      const swaps = subWallet
        ? await db.swapExecution.findMany({
            where: {
              subWalletId: subWallet.id,
              outputMint: SOL_MINT,
              executedAt: { gte: since },
            },
            orderBy: { executedAt: 'asc' },
            take: 50,
          })
        : []

      // Resolve token symbols from inputMint (the token being sold)
      const mints = [...new Set(swaps.map((s) => s.inputMint))]
      const scores = mints.length
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: mints } },
            orderBy: { scoredAt: 'desc' },
            select: { tokenMint: true, tokenSymbol: true },
          })
        : []
      const symbolByMint = new Map<string, string | null>()
      for (const s of scores) {
        if (!symbolByMint.has(s.tokenMint)) symbolByMint.set(s.tokenMint, s.tokenSymbol)
      }

      const pending = swaps.filter((s) => s.status === 'PENDING').length
      const confirmed = swaps.filter((s) => s.status === 'CONFIRMED').length
      const failed = swaps.filter((s) => s.status === 'FAILED').length
      const done =
        withdrawal.status !== 'PENDING' && swaps.length > 0 && pending === 0

      return {
        success: true,
        data: {
          withdrawalStatus: withdrawal.status,
          done,
          counts: { pending, confirmed, failed, total: swaps.length },
          swaps: swaps.map((s) => ({
            id: s.id,
            inputMint: s.inputMint,
            tokenSymbol: symbolByMint.get(s.inputMint) ?? null,
            outputSol: s.outputAmount
              ? (Number(s.outputAmount) / 1e9).toFixed(6)
              : null,
            status: s.status,
            errorMessage: s.errorMessage,
            executedAt: s.executedAt,
            confirmedAt: s.confirmedAt,
          })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get withdrawal progress')
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
          riskTier: w.riskTier,
          amountSol: w.amountSol.toString(),
          feeSol: w.feeSol.toString(),
          txSignature: w.txSignature,
          status: w.status,
          source: w.source,
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

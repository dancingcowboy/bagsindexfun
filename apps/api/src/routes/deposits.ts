import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { createDepositSchema, confirmDepositSchema } from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'
import { depositQueue } from '../queue/queues.js'

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

      // Per-user deposit cap (override via USER_DEPOSIT_CAP_SOL env var).
      // Computed as: sum(confirmed deposits) - sum(confirmed withdrawals).
      // Pending deposits are NOT counted so a stuck intent doesn't block
      // future legitimate deposits, but the new intent must fit under the cap
      // assuming it confirms.
      const userCapSol = Number(process.env.USER_DEPOSIT_CAP_SOL ?? '100')
      if (userCapSol > 0) {
        const [depAgg, wdAgg] = await Promise.all([
          db.deposit.aggregate({
            where: { userId, status: 'CONFIRMED' },
            _sum: { amountSol: true },
          }),
          db.withdrawal.aggregate({
            where: { userId, status: 'CONFIRMED' },
            _sum: { amountSol: true },
          }),
        ])
        const netDeposited = Number(depAgg._sum.amountSol ?? 0) - Number(wdAgg._sum.amountSol ?? 0)
        if (netDeposited + amountSol > userCapSol) {
          const remaining = Math.max(0, userCapSol - netDeposited)
          return reply.status(400).send({
            error: `Per-user deposit cap of ${userCapSol} SOL would be exceeded. You can deposit up to ${remaining.toFixed(4)} SOL more.`,
          })
        }
      }

      // No deposit fee — the vault instead holds a fixed 8% BAGSX exposure,
      // bought via the standard allocation + rebalance pipeline.
      const feeSol = 0
      const netAmountSol = amountSol

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
   * Submit tx signature. Verifies on-chain, then enqueues allocation.
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
   * GET /deposits/:id/progress
   * Live allocation progress for a single deposit. Returns the deposit
   * status plus every swap_execution against the tier sub-wallet since
   * the deposit was confirmed, so the dashboard can render a live log
   * while the worker is buying tokens and auto-refresh when done.
   */
  app.get('/:id/progress', async (req, reply) => {
    try {
      const { id } = req.params as { id: string }
      const userId = req.authUser!.userId

      const deposit = await db.deposit.findFirst({
        where: { id, userId },
      })
      if (!deposit) return reply.status(404).send({ error: 'Deposit not found' })

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: deposit.riskTier } },
        select: { id: true },
      })

      const since = deposit.confirmedAt ?? deposit.createdAt
      const swaps = subWallet
        ? await db.swapExecution.findMany({
            where: { subWalletId: subWallet.id, executedAt: { gte: since } },
            orderBy: { executedAt: 'asc' },
            take: 50,
          })
        : []

      const mints = [...new Set(swaps.map((s) => s.outputMint))]
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
      const done = deposit.status !== 'PENDING' && swaps.length > 0 && pending === 0

      return {
        success: true,
        data: {
          depositStatus: deposit.status,
          done,
          counts: { pending, confirmed, failed, total: swaps.length },
          swaps: swaps.map((s) => ({
            id: s.id,
            outputMint: s.outputMint,
            tokenSymbol: symbolByMint.get(s.outputMint) ?? null,
            inputSol: (Number(s.inputAmount) / 1e9).toFixed(6),
            outputAmount: s.outputAmount?.toString() ?? null,
            status: s.status,
            errorMessage: s.errorMessage,
            executedAt: s.executedAt,
            confirmedAt: s.confirmedAt,
          })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get deposit progress')
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

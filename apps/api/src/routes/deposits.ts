import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { createDepositSchema, confirmDepositSchema, LAMPORTS_PER_SOL } from '@bags-index/shared'
import { hasConfirmedSystemTransfer } from '@bags-index/solana'
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

      // Beta whitelist gate: only wallets in the whitelist may deposit.
      // Each entry carries a per-user per-tier deposit cap (default 30 SOL).
      const user = await db.user.findUnique({ where: { id: userId }, select: { walletAddress: true } })
      const whitelistEntry = user
        ? await db.walletWhitelist.findUnique({ where: { walletAddress: user.walletAddress } })
        : null
      if (!whitelistEntry) {
        return reply.status(403).send({ error: 'Wallet not whitelisted for beta access' })
      }

      // Cap is measured against CURRENT vault value (live holdings), not net
      // deposited. Vaults may grow organically above the cap via rebalance
      // gains — that's fine; we only gate additional deposit-driven growth.
      const vaultCapSol = Number(whitelistEntry.maxDepositSol)
      if (vaultCapSol > 0) {
        const holdings = await db.holding.findMany({
          where: { subWalletId: subWallet.id },
          select: { valueSolEst: true },
        })
        const currentVaultSol = holdings.reduce((sum, h) => sum + Number(h.valueSolEst), 0)
        if (currentVaultSol + amountSol > vaultCapSol) {
          const remaining = Math.max(0, vaultCapSol - currentVaultSol)
          return reply.status(400).send({
            error: `Vault cap of ${vaultCapSol} SOL reached for ${riskTier} (current size: ${currentVaultSol.toFixed(4)} SOL). You can deposit up to ${remaining.toFixed(4)} SOL more, or contact the admin for an exemption.`,
          })
        }
      }

      // No deposit fee — the vault instead holds a fixed 10% BAGSX exposure,
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

      const subWallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier: deposit.riskTier } },
        select: { address: true },
      })
      if (!subWallet) {
        return reply.status(400).send({ error: 'Sub-wallet not initialized' })
      }

      const expectedLamports = BigInt(
        Math.round(Number(deposit.amountSol) * LAMPORTS_PER_SOL),
      )
      const verified = await hasConfirmedSystemTransfer({
        txSignature,
        fromAddress: req.authUser!.walletAddress,
        toAddress: subWallet.address,
        lamports: expectedLamports,
      })
      if (!verified) {
        return reply.status(400).send({
          error: 'Submitted transaction does not contain the expected confirmed deposit transfer',
        })
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
            where: { tokenMint: { in: mints }, source: 'BAGS' },
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

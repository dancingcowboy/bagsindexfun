import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { CUSTOM_VAULT_MIN_INTERVAL_SEC, LAMPORTS_PER_SOL } from '@bags-index/shared'
import { createSolanaServerWallet, hasConfirmedSystemTransfer, getNativeSolBalance } from '@bags-index/solana'
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
            autoTakeProfitPct: true,
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
    // Enrich holdings with token metadata (symbol, market cap) from latest scores
    const mints = new Set<string>()
    for (const v of vaults) {
      for (const h of v.subWallet?.holdings ?? []) mints.add(h.tokenMint)
    }
    const scores = mints.size > 0
      ? await db.tokenScore.findMany({
          where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
          orderBy: { scoredAt: 'desc' },
          select: { tokenMint: true, tokenSymbol: true, marketCapUsd: true },
        })
      : []
    const metaByMint = new Map<string, { symbol: string | null; marketCapUsd: number }>()
    for (const s of scores) {
      if (!metaByMint.has(s.tokenMint)) {
        metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, marketCapUsd: Number(s.marketCapUsd) })
      }
    }

    // Fallback to DexScreener for mints not in scoring DB (user-chosen tokens)
    const missing = [...mints].filter((m) => !metaByMint.has(m))
    if (missing.length > 0) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${missing.join(',')}`,
          { signal: AbortSignal.timeout(10_000) },
        )
        const data: any = await res.json()
        const pairs: any[] = Array.isArray(data) ? data : data?.pairs ?? []
        for (const p of pairs) {
          const mint = p?.baseToken?.address
          if (!mint || metaByMint.has(mint)) continue
          metaByMint.set(mint, {
            symbol: p?.baseToken?.symbol ?? null,
            marketCapUsd: Number(p?.marketCap) || Number(p?.fdv) || 0,
          })
        }
      } catch {
        // Non-critical — UI just shows raw mint address
      }
    }

    const nativeSolByAddress = new Map<string, number>()
    for (const v of vaults) {
      if (v.subWallet?.address && v.subWallet.holdings.length > 0) {
        try {
          nativeSolByAddress.set(v.subWallet.address, await getNativeSolBalance(v.subWallet.address))
        } catch {
          nativeSolByAddress.set(v.subWallet.address, 0)
        }
      }
    }

    const serialized = vaults.map((v) => {
      const nativeSol = v.subWallet?.holdings.length
        ? (nativeSolByAddress.get(v.subWallet.address) ?? 0)
        : 0
      return {
        ...v,
        subWallet: v.subWallet
          ? {
              ...v.subWallet,
              nativeSol,
              holdings: v.subWallet.holdings.map((h) => {
                const meta = metaByMint.get(h.tokenMint)
                return {
                  ...h,
                  amount: h.amount.toString(),
                  valueSolEst: Number(h.valueSolEst),
                  costBasisSol: Number(h.costBasisSol),
                  realizedPnlSol: Number(h.realizedPnlSol),
                  tokenSymbol: meta?.symbol ?? null,
                  marketCapUsd: meta?.marketCapUsd ?? 0,
                }
              }),
            }
          : null,
      }
    })
    return { data: serialized }
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
    return {
      data: {
        ...vault,
        subWallet: vault.subWallet
          ? {
              ...vault.subWallet,
              holdings: vault.subWallet.holdings.map((h) => ({
                ...h,
                amount: h.amount.toString(),
                valueSolEst: Number(h.valueSolEst),
                costBasisSol: Number(h.costBasisSol),
                realizedPnlSol: Number(h.realizedPnlSol),
                totalSoldSol: Number(h.totalSoldSol),
              })),
            }
          : null,
      },
    }
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
   * PUT /custom-vaults/:id/auto-tp — set auto take-profit percentage
   * Body: { pct: number } (0–100)
   */
  app.put<{
    Params: { id: string }
    Body: { pct: number }
  }>('/:id/auto-tp', async (req, reply) => {
    const userId = req.authUser!.userId
    const { pct } = req.body
    if (pct === undefined || pct < 0 || pct > 100) {
      return reply.status(400).send({ error: 'pct must be 0–100' })
    }
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    await db.subWallet.update({
      where: { id: vault.subWalletId },
      data: { autoTakeProfitPct: pct },
    })
    return { data: { pct } }
  })

  /**
   * POST /custom-vaults/:id/liquidate/:mint — sell a single holding
   */
  app.post<{ Params: { id: string; mint: string } }>(
    '/:id/liquidate/:mint',
    async (req, reply) => {
      try {
        const userId = req.authUser!.userId
        const vault = await db.customVault.findFirst({
          where: { id: req.params.id, subWallet: { userId } },
          include: { subWallet: { select: { id: true } } },
        })
        if (!vault) return reply.status(404).send({ error: 'Not found' })

        const holding = await db.holding.findUnique({
          where: {
            subWalletId_tokenMint: {
              subWalletId: vault.subWalletId,
              tokenMint: req.params.mint,
            },
          },
        })
        if (!holding || holding.amount <= 0n) {
          return reply.status(400).send({ error: 'Holding not found or empty' })
        }

        // Create a withdrawal record and enqueue liquidation for this single token
        const withdrawal = await db.withdrawal.create({
          data: {
            userId,
            riskTier: 'DEGEN',
            amountSol: 0,
            feeSol: 0,
            status: 'PENDING',
          },
        })

        const { withdrawalQueue } = await import('../queue/queues.js')
        await withdrawalQueue.add('liquidate-single', {
          withdrawalId: withdrawal.id,
          userId,
          subWalletId: vault.subWalletId,
          tokenMint: req.params.mint,
        })

        return { data: { id: withdrawal.id, status: 'PENDING' } }
      } catch (err) {
        app.log.error(err, 'Failed to liquidate custom vault holding')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * POST /custom-vaults/:id/withdraw — liquidate all holdings + send SOL back
   * Body: { pct?: number } (1–100, default 100)
   */
  app.post<{ Params: { id: string }; Body: { pct?: number } }>(
    '/:id/withdraw',
    async (req, reply) => {
      try {
        const userId = req.authUser!.userId
        const withdrawPct = req.body?.pct ?? 100
        if (withdrawPct < 1 || withdrawPct > 100) {
          return reply.status(400).send({ error: 'pct must be 1–100' })
        }
        const vault = await db.customVault.findFirst({
          where: { id: req.params.id, subWallet: { userId } },
          include: { subWallet: { include: { holdings: true } } },
        })
        if (!vault) return reply.status(404).send({ error: 'Not found' })
        if (!vault.subWallet || vault.subWallet.holdings.length === 0) {
          return reply.status(400).send({ error: 'No holdings to withdraw' })
        }

        const inflight = await db.withdrawal.findFirst({
          where: { userId, riskTier: 'DEGEN', status: 'PENDING' },
        })
        if (inflight) {
          const age = Date.now() - new Date(inflight.createdAt).getTime()
          if (age > 10 * 60 * 1000) {
            await db.withdrawal.update({
              where: { id: inflight.id },
              data: { status: 'PARTIAL', confirmedAt: new Date() },
            })
          } else {
            return reply.status(409).send({ error: 'Withdrawal already in progress' })
          }
        }

        const totalValueSol = vault.subWallet.holdings.reduce(
          (sum, h) => sum + Number(h.valueSolEst), 0,
        )

        const withdrawal = await db.withdrawal.create({
          data: {
            userId,
            riskTier: 'DEGEN',
            amountSol: totalValueSol * (withdrawPct / 100),
            feeSol: 0,
            status: 'PENDING',
          },
        })

        const { withdrawalQueue } = await import('../queue/queues.js')
        await withdrawalQueue.add('liquidate', {
          withdrawalId: withdrawal.id,
          userId,
          subWalletId: vault.subWalletId,
          pct: withdrawPct,
        })

        return {
          data: {
            id: withdrawal.id,
            status: 'PENDING',
            estimatedSol: (totalValueSol * withdrawPct / 100).toFixed(9),
          },
        }
      } catch (err) {
        app.log.error(err, 'Failed to withdraw from custom vault')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * DELETE /custom-vaults/:id — remove vault + scheduler
   * Blocked while holdings have value.
   */
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const userId = req.authUser!.userId
    const vault = await db.customVault.findFirst({
      where: { id: req.params.id, subWallet: { userId } },
      include: { subWallet: { select: { holdings: { where: { amount: { gt: 0 } } } } } },
    })
    if (!vault) return reply.status(404).send({ error: 'Not found' })

    if (vault.subWallet && vault.subWallet.holdings.length > 0) {
      return reply.status(400).send({ error: 'Withdraw all funds before deleting this vault' })
    }

    await customVaultQueue.removeJobScheduler(`custom-vault-${vault.id}`)
    await db.customVault.delete({ where: { id: vault.id } })
    return { data: { deleted: true } }
  })

  /**
   * POST /custom-vaults/:id/deposit — declare deposit intent
   * Returns the sub-wallet address to send SOL to.
   * Body: { amountSol: number }
   */
  app.post<{
    Params: { id: string }
    Body: { amountSol: number }
  }>('/:id/deposit', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const { amountSol } = req.body
      if (!amountSol || amountSol <= 0 || amountSol > 10_000) {
        return reply.status(400).send({ error: 'amountSol must be between 0 and 10000' })
      }

      const vault = await db.customVault.findFirst({
        where: { id: req.params.id, subWallet: { userId } },
        include: { subWallet: { select: { id: true, address: true } } },
      })
      if (!vault) return reply.status(404).send({ error: 'Not found' })

      return {
        data: {
          vaultId: vault.id,
          subWalletAddress: vault.subWallet.address,
          amountSol,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to create custom vault deposit intent')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /custom-vaults/:id/deposit/confirm — verify on-chain tx, trigger rebalance
   * Body: { txSignature: string, amountSol: number }
   */
  app.post<{
    Params: { id: string }
    Body: { txSignature: string; amountSol: number }
  }>('/:id/deposit/confirm', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const { txSignature, amountSol } = req.body
      if (!txSignature || txSignature.length < 64) {
        return reply.status(400).send({ error: 'Valid txSignature required' })
      }

      const vault = await db.customVault.findFirst({
        where: { id: req.params.id, subWallet: { userId } },
        include: { subWallet: { select: { id: true, address: true } } },
      })
      if (!vault) return reply.status(404).send({ error: 'Not found' })

      const expectedLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL))
      const verified = await hasConfirmedSystemTransfer({
        txSignature,
        fromAddress: req.authUser!.walletAddress,
        toAddress: vault.subWallet.address,
        lamports: expectedLamports,
      })
      if (!verified) {
        return reply.status(400).send({ error: 'Transaction does not match expected deposit' })
      }

      // Trigger immediate rebalance so SOL gets allocated to tokens
      await customVaultQueue.add(`deposit-${vault.id}-${Date.now()}`, {
        customVaultId: vault.id,
      })

      return { data: { confirmed: true, rebalanceQueued: true } }
    } catch (err) {
      app.log.error(err, 'Failed to confirm custom vault deposit')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

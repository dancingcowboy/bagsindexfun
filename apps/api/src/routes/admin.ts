import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { blacklistTokenSchema, RISK_TIERS, TWEET_PLAN } from '@bags-index/shared'
import { requireAdmin } from '../middleware/auth.js'
import { scoringQueue, rebalanceQueue, priceSnapshotQueue } from '../queue/queues.js'

/** Tweet posting interval in hours — 84 tweets every 4h = 14 days */
const TWEET_INTERVAL_HOURS = 4

const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  /**
   * POST /admin/trigger-price-snapshot — enqueue an immediate price snapshot.
   * Useful to seed initial data so the PnL chart isn't empty before the
   * first :00 UTC cron tick.
   */
  app.post('/trigger-price-snapshot', async (_req, reply) => {
    try {
      const job = await priceSnapshotQueue.add('manual-snapshot', {})
      return { success: true, jobId: job.id }
    } catch (err) {
      app.log.error(err, 'Failed to enqueue price snapshot')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/vault — protocol vault holdings, deposits, burns summary.
   * Admin-only; returns the system:protocol-vault user's sub-wallets,
   * token holdings, and fee-claim history.
   */
  app.get('/vault', async (_req, reply) => {
    try {
      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: {
          subWallets: { include: { holdings: true } },
          deposits: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      })
      if (!user) return { success: true, data: null }

      // Resolve symbol/name per mint from the most recent TokenScore row.
      const mints = new Set<string>()
      for (const w of user.subWallets) for (const h of w.holdings) mints.add(h.tokenMint)
      const scores = mints.size
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: [...mints] } },
            orderBy: { scoredAt: 'desc' },
            select: { tokenMint: true, tokenSymbol: true, tokenName: true },
          })
        : []
      const metaByMint = new Map<string, { symbol: string; name: string }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint)) metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName })
      }

      const totalValueSol = user.subWallets.reduce(
        (sum, w) => sum + w.holdings.reduce((h, x) => h + Number(x.valueSolEst || 0), 0),
        0,
      )
      const totalClaimedSol = user.deposits.reduce((s, d) => s + Number(d.amountSol || 0), 0)
      const totalBurnedSol = user.deposits.reduce((s, d) => s + Number(d.feeSol || 0), 0)

      return {
        success: true,
        data: {
          walletAddress: user.walletAddress,
          subWallets: user.subWallets.map((w) => ({
            riskTier: w.riskTier,
            address: w.address,
            holdings: w.holdings.map((h) => {
              const meta = metaByMint.get(h.tokenMint)
              return {
                tokenMint: h.tokenMint,
                tokenSymbol: meta?.symbol ?? null,
                tokenName: meta?.name ?? null,
                amount: h.amount.toString(),
                valueSolEst: h.valueSolEst?.toString() ?? '0',
              }
            }),
          })),
          totals: {
            totalValueSol: totalValueSol.toFixed(6),
            totalClaimedSol: totalClaimedSol.toFixed(6),
            totalBurnedSol: totalBurnedSol.toFixed(6),
            claimCount: user.deposits.length,
          },
          recentClaims: user.deposits.slice(0, 10).map((d) => ({
            id: d.id,
            amountSol: Number(d.amountSol).toFixed(6),
            feeSol: Number(d.feeSol).toFixed(6),
            createdAt: d.createdAt,
            status: d.status,
          })),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to load vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/pnl
   * Per-pool (sub-wallet) PnL across ALL users, plus per-tier aggregates.
   */
  app.get('/pnl', async (_req, reply) => {
    try {
      const wallets = await db.subWallet.findMany({
        include: {
          holdings: true,
          user: { select: { walletAddress: true } },
        },
      })
      const pools = wallets.map((w) => {
        const currentValue = w.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0)
        const costBasis = w.holdings.reduce((s, h) => s + Number(h.costBasisSol), 0)
        const realized = Number(w.realizedPnlSol)
        const unrealized = currentValue - costBasis
        const totalPnl = realized + unrealized
        const invested = w.holdings.reduce((s, h) => s + Number(h.totalBoughtSol), 0)
        const pnlPct = invested > 0 ? (totalPnl / invested) * 100 : 0
        return {
          subWalletId: w.id,
          riskTier: w.riskTier,
          subWalletAddress: w.address,
          ownerWallet: w.user.walletAddress,
          currentValueSol: currentValue.toFixed(9),
          costBasisSol: costBasis.toFixed(9),
          realizedSol: realized.toFixed(9),
          unrealizedSol: unrealized.toFixed(9),
          totalPnlSol: totalPnl.toFixed(9),
          pnlPct: pnlPct.toFixed(2),
        }
      })
      const tierAgg: Record<string, { pools: number; currentValueSol: number; costBasisSol: number; realizedSol: number; unrealizedSol: number; totalPnlSol: number }> = {}
      for (const tier of RISK_TIERS) {
        tierAgg[tier] = { pools: 0, currentValueSol: 0, costBasisSol: 0, realizedSol: 0, unrealizedSol: 0, totalPnlSol: 0 }
      }
      for (const p of pools) {
        const t = tierAgg[p.riskTier]
        t.pools++
        t.currentValueSol += Number(p.currentValueSol)
        t.costBasisSol += Number(p.costBasisSol)
        t.realizedSol += Number(p.realizedSol)
        t.unrealizedSol += Number(p.unrealizedSol)
        t.totalPnlSol += Number(p.totalPnlSol)
      }
      const tiers = Object.entries(tierAgg).map(([tier, v]) => ({
        riskTier: tier,
        pools: v.pools,
        currentValueSol: v.currentValueSol.toFixed(9),
        costBasisSol: v.costBasisSol.toFixed(9),
        realizedSol: v.realizedSol.toFixed(9),
        unrealizedSol: v.unrealizedSol.toFixed(9),
        totalPnlSol: v.totalPnlSol.toFixed(9),
        pnlPct: v.costBasisSol > 0 ? ((v.totalPnlSol / v.costBasisSol) * 100).toFixed(2) : '0.00',
      }))
      return { success: true, data: { pools, tiers } }
    } catch (err) {
      app.log.error(err, 'Failed to get admin pnl')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/blacklist
   */
  app.post('/blacklist', async (req, reply) => {
    try {
      const { tokenMint, reason } = blacklistTokenSchema.parse(req.body)
      const entry = await db.tokenBlacklist.create({
        data: {
          tokenMint,
          reason,
          addedBy: req.authUser!.walletAddress,
        },
      })
      return { success: true, data: entry }
    } catch (err) {
      app.log.error(err, 'Failed to blacklist token')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * DELETE /admin/blacklist/:mint
   */
  app.delete('/blacklist/:mint', async (req, reply) => {
    try {
      const { mint } = req.params as { mint: string }
      await db.tokenBlacklist.delete({ where: { tokenMint: mint } })
      return { success: true }
    } catch (err) {
      app.log.error(err, 'Failed to remove from blacklist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/trigger-scoring
   */
  app.post('/trigger-scoring', async (_req, reply) => {
    try {
      await scoringQueue.add('manual-scoring', {}, { priority: 1 })
      return { success: true, data: { message: 'Scoring job queued' } }
    } catch (err) {
      app.log.error(err, 'Failed to trigger scoring')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/trigger-rebalance
   */
  app.post('/trigger-rebalance', async (_req, reply) => {
    try {
      await rebalanceQueue.add('manual-rebalance', {}, { priority: 1 })
      return { success: true, data: { message: 'Rebalance job queued' } }
    } catch (err) {
      app.log.error(err, 'Failed to trigger rebalance')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/overview
   * One-shot dashboard payload — users, volumes, fees, burns, queues, latest cycles.
   */
  app.get('/overview', async (_req, reply) => {
    try {
      const now = new Date()
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

      const [
        userTotal,
        users24h,
        users7d,
        subWalletCount,
        depositTotals,
        depositAgg,
        deposit24hAgg,
        withdrawalAgg,
        burnAgg,
        projectVaultCount,
        projectVaultAgg,
        blacklistCount,
        latestScoring,
        latestRebalances,
        scoringWaiting,
        scoringActive,
        rebalanceWaiting,
        rebalanceActive,
      ] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { createdAt: { gte: since24h } } }),
        db.user.count({ where: { createdAt: { gte: since7d } } }),
        db.subWallet.count(),
        db.deposit.groupBy({
          by: ['riskTier'],
          where: { status: 'CONFIRMED' },
          _count: true,
          _sum: { amountSol: true, feeSol: true },
        }),
        db.deposit.aggregate({
          where: { status: 'CONFIRMED' },
          _count: true,
          _sum: { amountSol: true, feeSol: true },
        }),
        db.deposit.aggregate({
          where: { status: 'CONFIRMED', createdAt: { gte: since24h } },
          _count: true,
          _sum: { amountSol: true, feeSol: true },
        }),
        db.withdrawal.aggregate({
          where: { status: 'CONFIRMED' },
          _count: true,
          _sum: { amountSol: true, feeSol: true },
        }),
        db.burnRecord.aggregate({
          where: { status: 'CONFIRMED' },
          _count: true,
          _sum: { solSpent: true },
        }),
        db.projectVault.count(),
        db.projectVault.aggregate({
          _sum: { totalSolReceived: true, currentValueSol: true },
        }),
        db.tokenBlacklist.count(),
        db.scoringCycle.findFirst({ orderBy: { startedAt: 'desc' } }),
        db.rebalanceCycle.findMany({
          orderBy: { startedAt: 'desc' },
          take: 6,
        }),
        scoringQueue.getWaitingCount(),
        scoringQueue.getActiveCount(),
        rebalanceQueue.getWaitingCount(),
        rebalanceQueue.getActiveCount(),
      ])

      const tierBreakdown = RISK_TIERS.map((tier) => {
        const row = depositTotals.find((d) => d.riskTier === tier)
        return {
          tier,
          deposits: row?._count ?? 0,
          totalSol: row?._sum.amountSol?.toString() ?? '0',
          feeSol: row?._sum.feeSol?.toString() ?? '0',
        }
      })

      return {
        success: true,
        data: {
          users: {
            total: userTotal,
            new24h: users24h,
            new7d: users7d,
            subWallets: subWalletCount,
          },
          deposits: {
            total: depositAgg._count,
            totalSol: depositAgg._sum.amountSol?.toString() ?? '0',
            totalFeeSol: depositAgg._sum.feeSol?.toString() ?? '0',
            count24h: deposit24hAgg._count,
            sol24h: deposit24hAgg._sum.amountSol?.toString() ?? '0',
            tierBreakdown,
          },
          withdrawals: {
            total: withdrawalAgg._count,
            totalSol: withdrawalAgg._sum.amountSol?.toString() ?? '0',
            totalFeeSol: withdrawalAgg._sum.feeSol?.toString() ?? '0',
          },
          burns: {
            total: burnAgg._count,
            solSpent: burnAgg._sum.solSpent?.toString() ?? '0',
          },
          projectVaults: {
            total: projectVaultCount,
            totalSolReceived: projectVaultAgg._sum.totalSolReceived?.toString() ?? '0',
            currentValueSol: projectVaultAgg._sum.currentValueSol?.toString() ?? '0',
          },
          blacklist: { count: blacklistCount },
          scoring: {
            latestCycle: latestScoring
              ? {
                  id: latestScoring.id,
                  status: latestScoring.status,
                  startedAt: latestScoring.startedAt,
                  completedAt: latestScoring.completedAt,
                  tokenCount: latestScoring.tokenCount,
                }
              : null,
            queueWaiting: scoringWaiting,
            queueActive: scoringActive,
          },
          rebalance: {
            recent: latestRebalances.map((r) => ({
              id: r.id,
              tier: r.riskTier,
              status: r.status,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              walletsTotal: r.walletsTotal,
              walletsComplete: r.walletsComplete,
              walletsFailed: r.walletsFailed,
            })),
            queueWaiting: rebalanceWaiting,
            queueActive: rebalanceActive,
          },
          generatedAt: now.toISOString(),
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to load admin overview')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/users — recent users with deposit totals
   */
  app.get('/users', async (req, reply) => {
    try {
      const { limit = '50' } = req.query as { limit?: string }
      const take = Math.min(parseInt(limit) || 50, 200)
      const users = await db.user.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          subWallets: { select: { riskTier: true } },
          _count: { select: { deposits: true, withdrawals: true } },
        },
      })

      // Per-user deposit totals
      const userIds = users.map((u) => u.id)
      const totals = await db.deposit.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: 'CONFIRMED' },
        _sum: { amountSol: true },
      })
      const totalMap = new Map(totals.map((t) => [t.userId, t._sum.amountSol?.toString() ?? '0']))

      return {
        success: true,
        data: users.map((u) => ({
          id: u.id,
          walletAddress: u.walletAddress,
          createdAt: u.createdAt,
          lastSeenAt: u.lastSeenAt,
          tiers: u.subWallets.map((w) => w.riskTier),
          depositCount: u._count.deposits,
          withdrawalCount: u._count.withdrawals,
          totalDepositedSol: totalMap.get(u.id) ?? '0',
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to list users')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/audit — recent audit log
   */
  app.get('/audit', async (req, reply) => {
    try {
      const { limit = '100' } = req.query as { limit?: string }
      const take = Math.min(parseInt(limit) || 100, 500)
      const logs = await db.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take,
      })
      return { success: true, data: logs }
    } catch (err) {
      app.log.error(err, 'Failed to load audit log')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  // ─── X (Twitter) Campaign ───────────────────────────────────────────────

  /**
   * GET /admin/tweets — full campaign queue
   */
  app.get('/tweets', async (_req, reply) => {
    try {
      const tweets = await db.tweet.findMany({ orderBy: { scheduledAt: 'asc' } })
      return { success: true, data: tweets }
    } catch (err) {
      app.log.error(err, 'Failed to list tweets')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/tweets/seed — seed the queue from TWEET_PLAN.
   * Idempotent: skips if any tweets already exist (use POST /tweets/reset to clear).
   * Each tweet starts as DRAFT with no scheduledAt commitment yet.
   */
  app.post('/tweets/seed', async (_req, reply) => {
    try {
      const existing = await db.tweet.count()
      if (existing > 0) {
        return reply.status(409).send({ error: 'Tweets already seeded — use /tweets/reset first' })
      }
      // Schedule placeholders at TWEET_INTERVAL_HOURS apart starting "now",
      // but mark as DRAFT — POST /tweets/launch reschedules from now.
      const now = Date.now()
      const created = await db.$transaction(
        TWEET_PLAN.map((p, i) =>
          db.tweet.create({
            data: {
              text: p.text,
              imageAlt: p.imageQuery,
              scheduledAt: new Date(now + i * TWEET_INTERVAL_HOURS * 60 * 60 * 1000),
              status: 'DRAFT',
            },
          }),
        ),
      )
      return { success: true, data: { count: created.length } }
    } catch (err) {
      app.log.error(err, 'Failed to seed tweets')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/tweets/launch — reschedule all DRAFT/FAILED tweets relative to NOW
   * with TWEET_INTERVAL_HOURS spacing, and flip status to ACTIVE so the
   * tweet-poller starts firing them.
   */
  app.post('/tweets/launch', async (_req, reply) => {
    try {
      const tweets = await db.tweet.findMany({
        where: { status: { in: ['DRAFT', 'FAILED'] } },
        orderBy: { scheduledAt: 'asc' },
      })
      const now = Date.now()
      await db.$transaction(
        tweets.map((t, i) =>
          db.tweet.update({
            where: { id: t.id },
            data: {
              scheduledAt: new Date(now + i * TWEET_INTERVAL_HOURS * 60 * 60 * 1000),
              status: 'ACTIVE',
              errorMessage: null,
            },
          }),
        ),
      )
      return { success: true, data: { activated: tweets.length } }
    } catch (err) {
      app.log.error(err, 'Failed to launch tweets')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/tweets/reset — danger: deletes the entire campaign queue.
   */
  app.post('/tweets/reset', async (_req, reply) => {
    try {
      const result = await db.tweet.deleteMany({})
      return { success: true, data: { deleted: result.count } }
    } catch (err) {
      app.log.error(err, 'Failed to reset tweets')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * PATCH /admin/tweets/:id — edit text, scheduledAt, status, imageUrl, imageAlt
   */
  app.patch('/tweets/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string }
      const body = req.body as {
        text?: string
        scheduledAt?: string
        status?: 'DRAFT' | 'ACTIVE' | 'SENT' | 'FAILED'
        imageUrl?: string | null
        imageAlt?: string | null
      }
      const data: Record<string, unknown> = {}
      if (typeof body.text === 'string') data.text = body.text.slice(0, 280)
      if (typeof body.scheduledAt === 'string') data.scheduledAt = new Date(body.scheduledAt)
      if (typeof body.status === 'string') data.status = body.status
      if (body.imageUrl !== undefined) {
        // Allow null (clear), https URLs, or data URLs for direct uploads.
        // Data URLs must be image/png|jpeg|gif|webp and ≤ 5 MB decoded.
        if (body.imageUrl !== null) {
          const url = body.imageUrl
          if (url.startsWith('data:')) {
            const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url)
            if (!m) return reply.status(400).send({ error: 'Invalid image data URL' })
            const approxBytes = Math.floor((m[3].length * 3) / 4)
            if (approxBytes > 5 * 1024 * 1024) return reply.status(413).send({ error: 'Image too large' })
          } else if (!/^https:\/\//.test(url)) {
            return reply.status(400).send({ error: 'imageUrl must be https or data URL' })
          }
        }
        data.imageUrl = body.imageUrl
      }
      if (body.imageAlt !== undefined) data.imageAlt = body.imageAlt
      const updated = await db.tweet.update({ where: { id }, data })
      return { success: true, data: updated }
    } catch (err) {
      app.log.error(err, 'Failed to update tweet')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * DELETE /admin/tweets/:id
   */
  app.delete('/tweets/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string }
      await db.tweet.delete({ where: { id } })
      return { success: true }
    } catch (err) {
      app.log.error(err, 'Failed to delete tweet')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/tweets/unsplash?q=... — search Unsplash for image candidates.
   * Returns the regular-size URL + photographer credit for each result.
   */
  app.get('/tweets/unsplash', async (req, reply) => {
    try {
      const { q } = req.query as { q?: string }
      if (!q) return reply.status(400).send({ error: 'Missing query' })
      const key = process.env.UNSPLASH_ACCESS_KEY
      if (!key) return reply.status(500).send({ error: 'Unsplash not configured' })
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=12&orientation=landscape`
      const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } })
      if (!res.ok) {
        app.log.error({ status: res.status }, 'Unsplash API error')
        return reply.status(500).send({ error: 'Internal server error' })
      }
      const data = (await res.json()) as { results: Array<{ id: string; urls: { regular: string; small: string }; alt_description: string | null; user: { name: string; links: { html: string } } }> }
      return {
        success: true,
        data: data.results.map((p) => ({
          id: p.id,
          url: p.urls.regular,
          thumb: p.urls.small,
          alt: p.alt_description,
          credit: p.user.name,
          creditUrl: p.user.links.html,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to search Unsplash')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/tweets/prefill-images — auto-pick an Unsplash image for every
   * tweet that doesn't have one yet, using its imageAlt as the search query.
   */
  app.post('/tweets/prefill-images', async (_req, reply) => {
    try {
      const key = process.env.UNSPLASH_ACCESS_KEY
      if (!key) return reply.status(500).send({ error: 'Unsplash not configured' })

      const tweets = await db.tweet.findMany({
        where: { imageUrl: null },
        orderBy: { scheduledAt: 'asc' },
      })

      let filled = 0
      let failed = 0
      for (const t of tweets) {
        const query = t.imageAlt || 'crypto'
        try {
          const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`
          const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } })
          if (!res.ok) {
            failed++
            continue
          }
          const data = (await res.json()) as { results: Array<{ urls: { regular: string }; alt_description: string | null }> }
          if (data.results.length === 0) {
            failed++
            continue
          }
          const pick = data.results[Math.floor(Math.random() * Math.min(data.results.length, 5))]
          await db.tweet.update({
            where: { id: t.id },
            data: {
              imageUrl: pick.urls.regular,
              imageAlt: pick.alt_description || t.imageAlt,
            },
          })
          filled++
          // Polite throttle to respect Unsplash demo rate limit (50/hr)
          await new Promise((r) => setTimeout(r, 250))
        } catch {
          failed++
        }
      }

      return { success: true, data: { filled, failed, totalScanned: tweets.length } }
    } catch (err) {
      app.log.error(err, 'Failed to prefill images')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/blacklist — list current blacklist
   */
  app.get('/blacklist', async (_req, reply) => {
    try {
      const entries = await db.tokenBlacklist.findMany({
        orderBy: { addedAt: 'desc' },
      })
      return { success: true, data: entries }
    } catch (err) {
      app.log.error(err, 'Failed to load blacklist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

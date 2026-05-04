import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import {
  RISK_TIERS,
  BAGSX_MINT,
  createSwitchSchema,
} from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'
import { rebalanceQueue, switchQueue, withdrawalQueue } from '../queue/queues.js'

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /**
   * GET /portfolio
   * Aggregate portfolio across all the user's tier wallets.
   * Returns holdings grouped by riskTier.
   */
  app.get<{ Querystring: { live?: string } }>('/', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const wantsLive = req.query.live === '1' || req.query.live === 'true'

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        include: { holdings: true },
      })

      if (wallets.length === 0) {
        return { success: true, data: { totalValueSol: '0', tiers: [] } }
      }

      // Live pricing is opt-in via ?live=1. On that path we re-price the
      // DB holdings (kept fresh by post-swap reconcile) using DexScreener
      // priceNative — no Helius or Jupiter calls. The default path reads
      // valueSolEst straight from the DB (refreshed hourly by the snapshot
      // worker). Native SOL always comes from the chain; we try Helius RPC
      // and fall back to public RPC inside getNativeSolBalance.
      const priceByMint = new Map<string, { valueSol: number; priceSol: number; source: string }>()
      const nativeSolByAddress = new Map<string, number>()
      if (wantsLive) {
        const { priceHoldingsFromDex } = await import('@bags-index/solana')
        const allHoldings = wallets.flatMap((w) =>
          w.holdings.map((h) => ({
            tokenMint: h.tokenMint,
            amount: h.amount,
            decimals: h.decimals,
          })),
        )
        try {
          const priced = await priceHoldingsFromDex(allHoldings)
          for (const [mint, p] of priced) priceByMint.set(mint, p)
        } catch (err) {
          app.log.warn({ err }, '[portfolio] DexScreener re-pricing failed')
        }
      }
      const { getNativeSolBalance } = await import('@bags-index/solana')
      await Promise.all(
        wallets.map(async (w) => {
          try {
            nativeSolByAddress.set(w.address, await getNativeSolBalance(w.address))
          } catch (err) {
            app.log.warn({ err, wallet: w.address }, '[portfolio] native SOL fetch failed')
            nativeSolByAddress.set(w.address, 0)
          }
        }),
      )

      // Pull token symbol/name from recent TokenScore rows so the UI has
      // labels for every mint we display.
      const mints = new Set<string>()
      for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
      const scores = mints.size
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
            orderBy: { scoredAt: 'desc' },
            select: { tokenMint: true, tokenSymbol: true, tokenName: true, marketCapUsd: true },
          })
        : []
      const metaByMint = new Map<string, { symbol: string | null; name: string | null; marketCapUsd: number }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint))
          metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName, marketCapUsd: Number(s.marketCapUsd) })
      }

      // Each DB holding's valueSol comes from either the live DexScreener
      // re-price (when ?live=1) or the worker-maintained `valueSolEst`.
      const resolveValueSol = (h: (typeof wallets)[number]['holdings'][number]): number => {
        if (wantsLive) {
          const p = priceByMint.get(h.tokenMint)
          if (p && p.source !== 'none') return p.valueSol
        }
        return Number(h.valueSolEst)
      }

      const tiers = wallets.map((w) => {
        const nativeSol = w.holdings.length > 0 ? (nativeSolByAddress.get(w.address) ?? 0) : 0
        const holdingVals = w.holdings.map((h) => ({ h, v: resolveValueSol(h) }))
        const tokenValueSol = holdingVals.reduce((s, x) => s + x.v, 0)
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          totalValueSol: (tokenValueSol + nativeSol).toFixed(9),
          nativeSol: nativeSol.toFixed(9),
          holdings: holdingVals.map(({ h, v }) => {
            const meta = metaByMint.get(h.tokenMint)
            const priced = wantsLive ? priceByMint.get(h.tokenMint) : undefined
            return {
              tokenMint: h.tokenMint,
              tokenSymbol: meta?.symbol ?? null,
              tokenName: meta?.name ?? null,
              amount: h.amount.toString(),
              valueSol: v.toFixed(9),
              priceSource: priced?.source ?? 'db',
              marketCapUsd: meta?.marketCapUsd ?? 0,
              allocationPct:
                tokenValueSol > 0 ? ((v / tokenValueSol) * 100).toFixed(2) : '0',
            }
          }),
        }
      })

      const grandTotal = tiers.reduce((s, t) => s + Number(t.totalValueSol), 0)

      return {
        success: true,
        data: {
          totalValueSol: grandTotal.toFixed(9),
          tiers,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to get portfolio')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /portfolio/switch
   * Atomically switch a user's position from one tier sub-wallet to another.
   * Skips the on-chain round-trip through the connected wallet and charges a
   * single flat fee (1%) instead of withdrawal+deposit (5% combined).
   *
   * Auth: requireAuth preHandler (registered on the router).
   * Ownership: both source & dest sub-wallets are scoped to req.authUser.userId.
   */
  app.post('/switch', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const body = createSwitchSchema.parse(req.body)

      const [srcWallet, dstWallet] = await Promise.all([
        db.subWallet.findUnique({
          where: { userId_riskTier: { userId, riskTier: body.fromTier } },
          include: { holdings: true },
        }),
        db.subWallet.findUnique({
          where: { userId_riskTier: { userId, riskTier: body.toTier } },
        }),
      ])
      if (!srcWallet) {
        return reply.status(404).send({ error: 'Source tier not found' })
      }
      if (!dstWallet) {
        return reply.status(404).send({ error: 'Destination tier not found' })
      }
      if (srcWallet.holdings.length === 0) {
        return reply.status(400).send({ error: 'Source tier has no holdings' })
      }

      const inflight = await db.switchJob.findFirst({
        where: { userId, status: 'PENDING' },
      })
      if (inflight) {
        return reply.status(409).send({ error: 'Switch already in progress' })
      }

      const sourceValueSol = srcWallet.holdings.reduce(
        (s, h) => s + Number(h.valueSolEst),
        0,
      )
      if (sourceValueSol <= 0) {
        return reply.status(400).send({ error: 'Source value is zero' })
      }
      // No switch fee — vault exposure is fee-free end-to-end.
      const feeSol = 0

      const job = await db.switchJob.create({
        data: {
          userId,
          fromTier: body.fromTier,
          toTier: body.toTier,
          sourceValueSol,
          feeSol,
          status: 'PENDING',
        },
      })

      await switchQueue.add('switch', { switchJobId: job.id, userId })

      return {
        success: true,
        data: {
          id: job.id,
          fromTier: job.fromTier,
          toTier: job.toTier,
          sourceValueSol: sourceValueSol.toFixed(9),
          feeSol: feeSol.toFixed(9),
          status: job.status,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to create switch job')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /portfolio/reshuffle
   * Force an immediate single-wallet rebalance for the caller's vault of the
   * given tier. Reuses the rebalance worker's per-wallet branch by enqueueing
   * a job with `walletId` set. Server-enforced 1-hour cooldown per wallet.
   *
   * Auth: requireAuth preHandler (registered on the router).
   * Ownership: sub-wallet looked up via composite `(userId, riskTier)` —
   * caller can only touch their own vault.
   */
  app.post<{ Body: { riskTier?: string } }>('/reshuffle', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const tier = req.body?.riskTier
      if (!tier || !RISK_TIERS.includes(tier as any)) {
        return reply.status(400).send({ error: 'Invalid tier' })
      }
      const riskTier = tier as 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

      const wallet = await db.subWallet.findUnique({
        where: { userId_riskTier: { userId, riskTier } },
      })
      if (!wallet) {
        return reply.status(404).send({ error: 'No vault for tier' })
      }

      const COOLDOWN_MS = 60 * 60 * 1000
      if (
        wallet.lastForceRebalanceAt &&
        Date.now() - wallet.lastForceRebalanceAt.getTime() < COOLDOWN_MS
      ) {
        const remainingMin = Math.ceil(
          (COOLDOWN_MS - (Date.now() - wallet.lastForceRebalanceAt.getTime())) /
            60000,
        )
        return reply
          .status(429)
          .send({ error: `Cooldown active — try again in ${remainingMin} min` })
      }

      const scoringCycle = await db.scoringCycle.findFirst({
        where: { status: 'COMPLETED', tier: riskTier, source: 'BAGS' },
        orderBy: { completedAt: 'desc' },
      })
      if (!scoringCycle) {
        return reply.status(503).send({ error: 'No scoring data yet — try later' })
      }

      // Refresh valueSolEst for this wallet's holdings before enqueueing.
      // reconcile.ts inserts new rows with valueSolEst=0 and the price-snapshot
      // worker only runs hourly, so a wallet that just saw a withdrawal or
      // deposit can look "empty" to the rebalance worker even when it holds
      // sizeable positions. Pricing in the request path (a few hundred ms)
      // guarantees the worker sees non-zero totalValueSol and actually swaps.
      try {
        const { priceHoldingsFromDex } = await import('@bags-index/solana')
        const dbHoldings = await db.holding.findMany({
          where: { subWalletId: wallet.id },
        })
        const priced = await priceHoldingsFromDex(
          dbHoldings.map((h) => ({
            tokenMint: h.tokenMint,
            amount: h.amount,
            decimals: h.decimals,
          })),
        )
        await Promise.all(
          dbHoldings.map((h) =>
            db.holding.update({
              where: { id: h.id },
              data: { valueSolEst: (priced.get(h.tokenMint)?.valueSol ?? 0).toFixed(9) },
            }),
          ),
        )
      } catch (err) {
        app.log.warn({ err }, '[reshuffle] live pricing failed — proceeding with stale values')
      }

      const rebalanceCycle = await db.rebalanceCycle.upsert({
        where: {
          scoringCycleId_riskTier_trigger_userId: {
            scoringCycleId: scoringCycle.id,
            riskTier,
            trigger: 'USER_FORCE',
            userId,
          },
        },
        create: {
          scoringCycleId: scoringCycle.id,
          riskTier,
          trigger: 'USER_FORCE',
          userId,
          walletsTotal: 1,
          shuffleSeed: `user-${userId}-${Date.now()}`,
          status: 'PROCESSING',
        },
        update: {
          walletsTotal: 1,
          walletsComplete: 0,
          shuffleSeed: `user-${userId}-${Date.now()}`,
          status: 'PROCESSING',
          startedAt: new Date(),
          completedAt: null,
        },
      })

      await db.subWallet.update({
        where: { id: wallet.id },
        data: { lastForceRebalanceAt: new Date() },
      })

      await rebalanceQueue.add(
        `user-reshuffle-${wallet.id}`,
        {
          walletId: wallet.id,
          riskTier,
          rebalanceCycleId: rebalanceCycle.id,
          scoringCycleId: scoringCycle.id,
        },
        { priority: 1, removeOnComplete: 100, removeOnFail: 100 },
      )

      return {
        success: true,
        data: { rebalanceCycleId: rebalanceCycle.id, status: 'queued' },
      }
    } catch (err) {
      app.log.error(err, 'Failed to enqueue user-force reshuffle')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * PUT /portfolio/auto-tp
   * Update the auto-take-profit percentage for one tier (0–100).
   * 0 = compound. 100 = withdraw all surplus each AUTO cycle.
   */
  app.put<{ Body: { riskTier?: string; pct?: number } }>(
    '/auto-tp',
    async (req, reply) => {
      try {
        const userId = req.authUser!.userId
        const { riskTier, pct } = req.body ?? {}
        if (!riskTier || !RISK_TIERS.includes(riskTier as any)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        if (
          typeof pct !== 'number' ||
          !Number.isInteger(pct) ||
          pct < 0 ||
          pct > 100
        ) {
          return reply.status(400).send({ error: 'pct must be integer 0..100' })
        }
        const tier = riskTier as 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'
        const wallet = await db.subWallet.findUnique({
          where: { userId_riskTier: { userId, riskTier: tier } },
        })
        if (!wallet) {
          return reply.status(404).send({ error: 'No vault for tier' })
        }
        if (pct > 0) {
          const user = await db.user.findUnique({ where: { id: userId } })
          if (!user?.walletAddress) {
            return reply
              .status(400)
              .send({ error: 'Connect a wallet address first' })
          }
        }
        await db.subWallet.update({
          where: { id: wallet.id },
          data: { autoTakeProfitPct: pct },
        })
        return { success: true, data: { riskTier: tier, pct } }
      } catch (err) {
        app.log.error(err, 'Failed to update auto-TP')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * POST /portfolio/holdings/:mint/liquidate
   * Sell one specific holding back to SOL and transfer proceeds to the
   * user's connected wallet. Leaves the other positions untouched. The
   * resulting SOL is recorded as a USER withdrawal so cost-basis and
   * PnL accounting stays consistent with full withdrawals.
   *
   * BAGSX is the fixed platform slice and is not individually liquidatable.
   */
  app.post<{ Params: { mint: string }; Body: { riskTier?: string } }>(
    '/holdings/:mint/liquidate',
    async (req, reply) => {
      try {
        const userId = req.authUser!.userId
        const { mint } = req.params
        const { riskTier } = req.body ?? {}
        if (!mint || typeof mint !== 'string') {
          return reply.status(400).send({ error: 'Invalid mint' })
        }
        if (mint === BAGSX_MINT) {
          return reply.status(400).send({ error: 'BAGSX cannot be liquidated individually' })
        }
        if (!riskTier || !RISK_TIERS.includes(riskTier as any)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        const tier = riskTier as 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

        const user = await db.user.findUnique({ where: { id: userId } })
        if (!user?.walletAddress) {
          return reply.status(400).send({ error: 'Connect a wallet address first' })
        }

        const subWallet = await db.subWallet.findUnique({
          where: { userId_riskTier: { userId, riskTier: tier } },
          include: {
            holdings: { where: { tokenMint: mint } },
          },
        })
        if (!subWallet) {
          return reply.status(404).send({ error: 'No vault for tier' })
        }
        const holding = subWallet.holdings[0]
        if (!holding || holding.amount <= 0n) {
          return reply.status(404).send({ error: 'Position not held' })
        }

        // Block concurrent PENDING withdrawals for this tier — prevents
        // fighting with a full-withdrawal job over the same holdings.
        const inflight = await db.withdrawal.findFirst({
          where: { userId, riskTier: tier, status: 'PENDING' },
        })
        if (inflight) {
          return reply.status(409).send({ error: 'Another withdrawal is already in progress for this tier' })
        }

        const estimatedSol = Number(holding.valueSolEst)
        const withdrawal = await db.withdrawal.create({
          data: {
            userId,
            riskTier: tier,
            amountSol: estimatedSol.toFixed(9),
            feeSol: '0',
            status: 'PENDING',
            source: 'USER',
          },
        })

        await withdrawalQueue.add('liquidate', {
          withdrawalId: withdrawal.id,
          userId,
          subWalletId: subWallet.id,
          pct: 100,
          tokenMint: mint,
        })

        return {
          success: true,
          data: {
            id: withdrawal.id,
            tokenMint: mint,
            riskTier: tier,
            estimatedSol: estimatedSol.toFixed(9),
            status: withdrawal.status,
          },
        }
      } catch (err) {
        app.log.error(err, 'Failed to liquidate holding')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * GET /portfolio/switches
   * List the authenticated user's switch history (ownership-scoped).
   */
  app.get('/switches', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const jobs = await db.switchJob.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      return {
        success: true,
        data: jobs.map((j) => ({
          id: j.id,
          fromTier: j.fromTier,
          toTier: j.toTier,
          sourceValueSol: Number(j.sourceValueSol).toFixed(9),
          feeSol: Number(j.feeSol).toFixed(9),
          overlapKept: j.overlapKept,
          sellsExecuted: j.sellsExecuted,
          buysExecuted: j.buysExecuted,
          solSavedEstimate: Number(j.solSavedEstimate).toFixed(9),
          status: j.status,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to list switches')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/pnl
   * Per-tier PnL for the authenticated user only (ownership scoped).
   */
  app.get('/pnl', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        include: { holdings: true },
      })

      // Live value per wallet (token value + native SOL). Falls back to the
      // DB snapshot when the Helius/price fetch fails so the PnL card never
      // goes blank on a transient RPC hiccup.
      // Live re-price via DexScreener + native SOL via RPC-with-fallback.
      // No Helius /balances calls — we trust DB amounts (post-swap reconcile
      // keeps them fresh) and only ask DexScreener for live prices.
      const { priceHoldingsFromDex, getNativeSolBalance } = await import('@bags-index/solana')
      const liveByWallet = new Map<string, number>()
      const allHoldings = wallets.flatMap((w) =>
        w.holdings.map((h) => ({
          tokenMint: h.tokenMint,
          amount: h.amount,
          decimals: h.decimals,
        })),
      )
      let pricedMap = new Map<string, { valueSol: number; source: string }>()
      try {
        const priced = await priceHoldingsFromDex(allHoldings)
        for (const [m, p] of priced) pricedMap.set(m, { valueSol: p.valueSol, source: p.source })
      } catch (err) {
        app.log.warn({ err }, '[pnl] DexScreener re-pricing failed')
      }
      await Promise.all(
        wallets.map(async (w) => {
          const tokenValue = w.holdings.reduce((s, h) => {
            const p = pricedMap.get(h.tokenMint)
            return s + (p && p.source !== 'none' ? p.valueSol : Number(h.valueSolEst))
          }, 0)
          let nativeSol = 0
          try {
            nativeSol = await getNativeSolBalance(w.address)
          } catch (err) {
            app.log.warn({ err, wallet: w.address }, '[pnl] native SOL fetch failed')
          }
          liveByWallet.set(w.id, tokenValue + nativeSol)
        }),
      )

      // Per-tier cashflows. Deposits net-of-fee (fees never enter vault).
      // Withdrawals split by source: USER cash-outs consume basis
      // proportionally; AUTO_TP payouts are pure realized gain above
      // basis (matches the TP policy — payouts don't reduce cost basis).
      const [depositRows, userWdRows, autoTpWdRows] = await Promise.all([
        db.deposit.groupBy({
          by: ['riskTier'],
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          _sum: { amountSol: true, feeSol: true },
        }),
        db.withdrawal.groupBy({
          by: ['riskTier'],
          where: { userId, source: 'USER', status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          _sum: { amountSol: true },
        }),
        db.withdrawal.groupBy({
          by: ['riskTier'],
          where: { userId, source: 'AUTO_TP', status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          _sum: { amountSol: true },
        }),
      ])
      const depositedByTier = new Map<string, number>()
      for (const d of depositRows) {
        depositedByTier.set(
          d.riskTier,
          Number(d._sum.amountSol ?? 0) - Number(d._sum.feeSol ?? 0),
        )
      }
      const userWdByTier = new Map<string, number>()
      for (const w of userWdRows) userWdByTier.set(w.riskTier, Number(w._sum.amountSol ?? 0))
      const autoTpByTier = new Map<string, number>()
      for (const w of autoTpWdRows) autoTpByTier.set(w.riskTier, Number(w._sum.amountSol ?? 0))

      const tiers = wallets.map((w) => {
        // When a wallet has zero holdings, its value is 0 — any remaining
        // native SOL is a gas reserve, not user value. Only count the live
        // balance when the wallet actually holds tokens.
        const hasHoldings = w.holdings.length > 0
        const currentValue = hasHoldings
          ? (liveByWallet.get(w.id) ??
             w.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0))
          : 0
        const deposited = depositedByTier.get(w.riskTier!) ?? 0
        const withdrawnUser = userWdByTier.get(w.riskTier!) ?? 0
        const withdrawnAutoTp = autoTpByTier.get(w.riskTier!) ?? 0

        // Proportional basis: fraction of original capital still invested
        // is currentValue / (currentValue + withdrawnUser). AUTO_TP
        // payouts are above-basis gains, so they don't enter the denominator.
        const paths = currentValue + withdrawnUser
        const effectiveBasis = paths > 0 ? deposited * (currentValue / paths) : deposited
        const basisConsumed = deposited - effectiveBasis
        const realized = (withdrawnUser - basisConsumed) + withdrawnAutoTp
        const unrealized = currentValue - effectiveBasis
        const totalPnl = realized + unrealized // = currentValue + withdrawnUser + withdrawnAutoTp − deposited
        const pnlPct = deposited > 0 ? (totalPnl / deposited) * 100 : 0
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          currentValueSol: currentValue.toFixed(9),
          costBasisSol: effectiveBasis.toFixed(9),
          realizedSol: realized.toFixed(9),
          unrealizedSol: unrealized.toFixed(9),
          totalPnlSol: totalPnl.toFixed(9),
          pnlPct: pnlPct.toFixed(2),
          autoTakeProfitPct: w.autoTakeProfitPct,
        }
      })
      const totals = tiers.reduce(
        (acc, t) => ({
          currentValueSol: acc.currentValueSol + Number(t.currentValueSol),
          costBasisSol: acc.costBasisSol + Number(t.costBasisSol),
          realizedSol: acc.realizedSol + Number(t.realizedSol),
          unrealizedSol: acc.unrealizedSol + Number(t.unrealizedSol),
          totalPnlSol: acc.totalPnlSol + Number(t.totalPnlSol),
        }),
        { currentValueSol: 0, costBasisSol: 0, realizedSol: 0, unrealizedSol: 0, totalPnlSol: 0 },
      )
      return { success: true, data: { tiers, totals } }
    } catch (err) {
      app.log.error(err, 'Failed to get pnl')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/pnl-history?hours=168
   * Hourly PnL snapshot history for each of the user's sub-wallets.
   * Ownership-scoped: only returns rows belonging to wallets owned by
   * the authenticated user.
   */
  app.get<{ Querystring: { hours?: string } }>('/pnl-history', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        select: { id: true, address: true, riskTier: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: { tiers: [] } }
      }

      const snapshots = await db.pnlSnapshot.findMany({
        where: {
          subWalletId: { in: wallets.map((w) => w.id) },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          subWalletId: true,
          totalValueSol: true,
          totalCostSol: true,
          unrealizedSol: true,
          realizedSol: true,
          createdAt: true,
        },
      })

      const byWallet = new Map<string, typeof snapshots>()
      for (const s of snapshots) {
        const arr = byWallet.get(s.subWalletId) ?? []
        arr.push(s)
        byWallet.set(s.subWalletId, arr)
      }

      const tiers = wallets.map((w) => ({
        riskTier: w.riskTier,
        walletAddress: w.address,
        points: (byWallet.get(w.id) ?? []).map((s) => ({
          t: s.createdAt,
          valueSol: s.totalValueSol.toString(),
          costSol: s.totalCostSol.toString(),
          unrealizedSol: s.unrealizedSol.toString(),
          realizedSol: s.realizedSol.toString(),
        })),
      }))

      return { success: true, data: { tiers, hours } }
    } catch (err) {
      app.log.error(err, 'Failed to get pnl history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/twr-history?hours=168
   *
   * Time-weighted return for the authenticated user's portfolio. Same logic
   * as /admin/vault-twr-history but scoped to the user — neutralizes
   * deposit and withdrawal cashflows so the resulting line reflects pure
   * price performance, regardless of when the user added or pulled funds.
   *
   *   step = (V_end - (deposits_in_period - withdrawals_in_period)) / V_start
   *
   * Index normalized to 100 at the first snapshot in range. Aggregates
   * across all the user's sub-wallets (sums totalValueSol per timestamp).
   */
  app.get<{ Querystring: { hours?: string } }>('/twr-history', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        select: { id: true, riskTier: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: { tiers: [], points: [], hours, cashflowCount: 0 } }
      }

      const snapshots = await db.pnlSnapshot.findMany({
        where: {
          subWalletId: { in: wallets.map((w) => w.id) },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        select: { subWalletId: true, totalValueSol: true, createdAt: true },
      })

      // Build wallet→tier lookup
      const walletTier = new Map<string, string | null>()
      for (const w of wallets) walletTier.set(w.id, w.riskTier)

      // Cashflows: deposits in - withdrawals out, both gross.
      const [deposits, withdrawals] = await Promise.all([
        db.deposit.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] }, createdAt: { gte: since } },
          select: { amountSol: true, riskTier: true, confirmedAt: true, createdAt: true },
        }),
        db.withdrawal.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] }, createdAt: { gte: since } },
          select: { amountSol: true, riskTier: true, confirmedAt: true, createdAt: true },
        }),
      ])

      // --- Per-tier TWR ---
      const tierNames = [...new Set(wallets.map((w) => w.riskTier).filter(Boolean))] as string[]
      const tierResults: { riskTier: string; points: { t: string; twr: number }[] }[] = []

      for (const tier of tierNames) {
        const tierWalletIds = wallets.filter((w) => w.riskTier === tier).map((w) => w.id)
        const tierSnaps = snapshots.filter((s) => tierWalletIds.includes(s.subWalletId))

        const bucket = new Map<number, number>()
        for (const s of tierSnaps) {
          const t = s.createdAt.getTime()
          bucket.set(t, (bucket.get(t) ?? 0) + Number(s.totalValueSol))
        }
        const merged = [...bucket.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([t, v]) => ({ t: new Date(t), v }))
        if (merged.length < 2) continue

        const tierCashflows: { t: number; amount: number }[] = []
        for (const d of deposits) {
          if (d.riskTier === tier) {
            tierCashflows.push({ t: (d.confirmedAt ?? d.createdAt).getTime(), amount: Number(d.amountSol) })
          }
        }
        for (const w of withdrawals) {
          if (w.riskTier === tier) {
            tierCashflows.push({ t: (w.confirmedAt ?? w.createdAt).getTime(), amount: -Number(w.amountSol) })
          }
        }

        const MIN_STEP = 0.5, MAX_STEP = 3.0
        const pts: { t: string; twr: number }[] = []
        let idx = 100
        pts.push({ t: merged[0].t.toISOString(), twr: 100 })
        for (let i = 1; i < merged.length; i++) {
          const prev = merged[i - 1], cur = merged[i]
          let cf = 0
          for (const c of tierCashflows) {
            if (c.t > prev.t.getTime() && c.t <= cur.t.getTime()) cf += c.amount
          }
          let step = 1
          if (prev.v > 0) {
            const adj = cur.v - cf
            step = adj / prev.v
            if (!isFinite(step) || step <= 0) step = 1
            if (step < MIN_STEP || step > MAX_STEP) step = 1
          }
          idx *= step
          pts.push({ t: cur.t.toISOString(), twr: idx })
        }
        tierResults.push({ riskTier: tier, points: pts })
      }

      // --- Aggregate (all wallets) TWR for backwards compat ---
      const bucket = new Map<number, number>()
      for (const s of snapshots) {
        const t = s.createdAt.getTime()
        bucket.set(t, (bucket.get(t) ?? 0) + Number(s.totalValueSol))
      }
      const merged = [...bucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ t: new Date(t), v }))

      const allCashflows: { t: number; amount: number }[] = []
      for (const d of deposits) {
        allCashflows.push({ t: (d.confirmedAt ?? d.createdAt).getTime(), amount: Number(d.amountSol) })
      }
      for (const w of withdrawals) {
        allCashflows.push({ t: (w.confirmedAt ?? w.createdAt).getTime(), amount: -Number(w.amountSol) })
      }

      const MIN_STEP = 0.5, MAX_STEP = 3.0
      const points: { t: string; twr: number; valueSol: number }[] = []
      if (merged.length >= 2) {
        let index = 100
        points.push({ t: merged[0].t.toISOString(), twr: 100, valueSol: merged[0].v })
        for (let i = 1; i < merged.length; i++) {
          const prev = merged[i - 1], cur = merged[i]
          let cf = 0
          for (const c of allCashflows) {
            if (c.t > prev.t.getTime() && c.t <= cur.t.getTime()) cf += c.amount
          }
          let step = 1
          if (prev.v > 0) {
            const adj = cur.v - cf
            step = adj / prev.v
            if (!isFinite(step) || step <= 0) step = 1
            if (step < MIN_STEP || step > MAX_STEP) step = 1
          }
          index *= step
          points.push({ t: cur.t.toISOString(), twr: index, valueSol: cur.v })
        }
      }

      return { success: true, data: { tiers: tierResults, points, hours, cashflowCount: allCashflows.length } }
    } catch (err) {
      app.log.error(err, 'Failed to compute portfolio TWR')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/pnl-money-weighted?hours=168
   *
   * "Real" dollar-PnL per tier:
   *    pnlSol(t) = valueSol(t) - (cumulativeDeposits(t) - cumulativeWithdrawals(t))
   *
   * Unlike TWR (which neutralizes cashflows to measure pure price return),
   * this reflects the user's actual money — if they deposited 1 SOL and
   * the vault is worth 0.6 SOL, the line reads -0.4 SOL. Per-tier.
   * Ownership-scoped.
   */
  app.get<{ Querystring: { hours?: string } }>('/pnl-money-weighted', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        select: { id: true, address: true, riskTier: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: { tiers: [], hours } }
      }

      const [snapshots, deposits, withdrawals] = await Promise.all([
        db.pnlSnapshot.findMany({
          where: {
            subWalletId: { in: wallets.map((w) => w.id) },
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'asc' },
          select: { subWalletId: true, totalValueSol: true, createdAt: true },
        }),
        db.deposit.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          select: { riskTier: true, amountSol: true, confirmedAt: true, createdAt: true },
        }),
        db.withdrawal.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          select: { riskTier: true, amountSol: true, confirmedAt: true, createdAt: true },
        }),
      ])

      // Cashflows grouped per tier, sorted ascending. We keep flows from
      // before `since` too so the starting cumulative netflow is accurate.
      type Flow = { t: number; amount: number }
      const flowsByTier = new Map<string, Flow[]>()
      for (const d of deposits) {
        const arr = flowsByTier.get(d.riskTier) ?? []
        arr.push({
          t: (d.confirmedAt ?? d.createdAt).getTime(),
          amount: Number(d.amountSol),
        })
        flowsByTier.set(d.riskTier, arr)
      }
      for (const w of withdrawals) {
        const arr = flowsByTier.get(w.riskTier) ?? []
        arr.push({
          t: (w.confirmedAt ?? w.createdAt).getTime(),
          amount: -Number(w.amountSol),
        })
        flowsByTier.set(w.riskTier, arr)
      }
      for (const arr of flowsByTier.values()) arr.sort((a, b) => a.t - b.t)

      const snapsByWallet = new Map<string, typeof snapshots>()
      for (const s of snapshots) {
        const arr = snapsByWallet.get(s.subWalletId) ?? []
        arr.push(s)
        snapsByWallet.set(s.subWalletId, arr)
      }

      const tiers = wallets.map((w) => {
        const flows = flowsByTier.get(w.riskTier!) ?? []
        const snaps = snapsByWallet.get(w.id) ?? []
        const points = snaps.map((s) => {
          const tMs = s.createdAt.getTime()
          let netDeposited = 0
          for (const f of flows) {
            if (f.t <= tMs) netDeposited += f.amount
            else break
          }
          const value = Number(s.totalValueSol)
          return {
            t: s.createdAt,
            valueSol: value.toFixed(9),
            netDepositedSol: netDeposited.toFixed(9),
            pnlSol: (value - netDeposited).toFixed(9),
          }
        })
        return { riskTier: w.riskTier, walletAddress: w.address, points }
      })

      return { success: true, data: { tiers, hours } }
    } catch (err) {
      app.log.error(err, 'Failed to compute money-weighted pnl')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/token-price-history?hours=168
   * Per-token SOL price history (one sample per hour) for every token the
   * authenticated user currently holds. Each series is normalized to base
   * 100 at the first sample so lines are comparable across tokens.
   * Ownership scoped: only mints present in the user's wallets.
   */
  app.get<{ Querystring: { hours?: string } }>('/token-price-history', async (req, reply) => {
    try {
      const userId = req.authUser!.userId
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        include: { holdings: { select: { tokenMint: true } } },
      })
      const mints = new Set<string>()
      for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
      if (mints.size === 0) return { success: true, data: { tokens: [], hours } }

      // Resolve symbol/name via most recent TokenScore
      const scores = await db.tokenScore.findMany({
        where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
        orderBy: { scoredAt: 'desc' },
        select: { tokenMint: true, tokenSymbol: true, tokenName: true },
      })
      const metaByMint = new Map<string, { symbol: string; name: string }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint)) metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName })
      }

      const samples = await db.tokenPriceSnapshot.findMany({
        where: { tokenMint: { in: [...mints] }, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { tokenMint: true, priceSol: true, createdAt: true },
      })

      const byMint = new Map<string, typeof samples>()
      for (const s of samples) {
        const arr = byMint.get(s.tokenMint) ?? []
        arr.push(s)
        byMint.set(s.tokenMint, arr)
      }

      const tokens = [...mints].map((mint) => {
        const series = byMint.get(mint) ?? []
        const base = series.length > 0 ? Number(series[0].priceSol) : 0
        return {
          tokenMint: mint,
          tokenSymbol: metaByMint.get(mint)?.symbol ?? null,
          tokenName: metaByMint.get(mint)?.name ?? null,
          points: series.map((p) => ({
            t: p.createdAt,
            priceSol: p.priceSol.toString(),
            indexed: base > 0 ? (Number(p.priceSol) / base) * 100 : 100,
          })),
        }
      })

      return { success: true, data: { tokens, hours } }
    } catch (err) {
      app.log.error(err, 'Failed to get token price history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /portfolio/transactions
   * Swap execution history across all the user's sub-wallets.
   */
  app.get('/transactions', async (req, reply) => {
    try {
      const userId = req.authUser!.userId

      const wallets = await db.subWallet.findMany({
        where: { userId, riskTier: { not: null } },
        select: { id: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: [] }
      }

      const executions = await db.swapExecution.findMany({
        where: { subWalletId: { in: wallets.map((w) => w.id) } },
        orderBy: { executedAt: 'desc' },
        take: 100,
      })

      return {
        success: true,
        data: executions.map((e) => ({
          id: e.id,
          inputMint: e.inputMint,
          outputMint: e.outputMint,
          inputAmount: e.inputAmount.toString(),
          outputAmount: e.outputAmount?.toString() ?? null,
          txSignature: e.txSignature,
          status: e.status,
          executedAt: e.executedAt,
        })),
      }
    } catch (err) {
      app.log.error(err, 'Failed to get transactions')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

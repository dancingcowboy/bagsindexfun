import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import {
  RISK_TIERS,
  createSwitchSchema,
} from '@bags-index/shared'
import { requireAuth } from '../middleware/auth.js'
import { switchQueue } from '../queue/queues.js'

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
        where: { userId },
        include: { holdings: true },
      })

      if (wallets.length === 0) {
        return { success: true, data: { totalValueSol: '0', tiers: [] } }
      }

      // Live read from chain + price APIs is now opt-in via ?live=1. The DB
      // holdings table is kept fresh by post-swap reconcile in every worker,
      // so the default path is instant and uses zero external API calls. A
      // "Refresh Holdings" button on the dashboard re-requests with ?live=1.
      const liveByAddress = new Map<
        string,
        Awaited<ReturnType<typeof import('@bags-index/solana').getLiveHoldings>> | null
      >()
      // Native SOL per wallet — fetched in the DB-fallback path so the
      // 12% SOL anchor on CONSERVATIVE (and any un-redeployed sell proceeds)
      // is not silently excluded from totalValueSol.
      const nativeSolByAddress = new Map<string, number>()
      if (wantsLive) {
        const { getLiveHoldings } = await import('@bags-index/solana')
        await Promise.all(
          wallets.map(async (w) => {
            try {
              liveByAddress.set(w.address, await getLiveHoldings(w.address))
            } catch (err) {
              app.log.warn({ err, wallet: w.address }, '[portfolio] live fetch failed')
              liveByAddress.set(w.address, null)
            }
          }),
        )
      } else {
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
      }

      // Pull token symbol/name from recent TokenScore rows so the UI has
      // labels for every mint we display (live or DB).
      const mints = new Set<string>()
      for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
      for (const live of liveByAddress.values()) {
        if (live) for (const h of live.holdings) mints.add(h.tokenMint)
      }
      const scores = mints.size
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: [...mints] } },
            orderBy: { scoredAt: 'desc' },
            select: { tokenMint: true, tokenSymbol: true, tokenName: true, marketCapUsd: true },
          })
        : []
      const metaByMint = new Map<string, { symbol: string | null; name: string | null; marketCapUsd: number }>()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint))
          metaByMint.set(s.tokenMint, { symbol: s.tokenSymbol, name: s.tokenName, marketCapUsd: Number(s.marketCapUsd) })
      }

      const tiers = wallets.map((w) => {
        const live = liveByAddress.get(w.address)
        if (live) {
          const tokenValueSol = live.holdings.reduce((s, h) => s + h.valueSol, 0)
          // Only include native SOL when the wallet holds tokens — the gas
          // reserve in an empty wallet is not user value.
          const totalValueSol = live.holdings.length > 0
            ? tokenValueSol + live.nativeSol
            : 0
          return {
            riskTier: w.riskTier,
            walletAddress: w.address,
            totalValueSol: totalValueSol.toFixed(9),
            nativeSol: live.holdings.length > 0 ? live.nativeSol.toFixed(9) : '0',
            holdings: live.holdings.map((h) => {
              const meta = metaByMint.get(h.tokenMint)
              return {
                tokenMint: h.tokenMint,
                tokenSymbol: meta?.symbol ?? null,
                tokenName: meta?.name ?? null,
                amount: h.amount,
                valueSol: h.valueSol.toFixed(9),
                priceSource: h.source,
                marketCapUsd: meta?.marketCapUsd ?? 0,
                allocationPct:
                  tokenValueSol > 0
                    ? ((h.valueSol / tokenValueSol) * 100).toFixed(2)
                    : '0',
              }
            }),
          }
        }

        // Fallback to DB if live read failed.
        const tokenValueSol = w.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0)
        // Include native SOL (fetched above for the non-live path, or zero if
        // the balance read failed). Only count it when the wallet holds tokens
        // — an empty wallet's gas reserve is not user value.
        const nativeSol = w.holdings.length > 0 ? (nativeSolByAddress.get(w.address) ?? 0) : 0
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          totalValueSol: (tokenValueSol + nativeSol).toFixed(9),
          nativeSol: nativeSol.toFixed(9),
          holdings: w.holdings.map((h) => {
            const meta = metaByMint.get(h.tokenMint)
            return {
              tokenMint: h.tokenMint,
              tokenSymbol: meta?.symbol ?? null,
              tokenName: meta?.name ?? null,
              amount: h.amount.toString(),
              valueSol: Number(h.valueSolEst).toFixed(9),
              marketCapUsd: meta?.marketCapUsd ?? 0,
              allocationPct:
                tokenValueSol > 0
                  ? ((Number(h.valueSolEst) / tokenValueSol) * 100).toFixed(2)
                  : '0',
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
        where: { userId },
        include: { holdings: true },
      })

      // Live value per wallet (token value + native SOL). Falls back to the
      // DB snapshot when the Helius/price fetch fails so the PnL card never
      // goes blank on a transient RPC hiccup.
      const { getLiveHoldings } = await import('@bags-index/solana')
      const liveByWallet = new Map<string, number>()
      await Promise.all(
        wallets.map(async (w) => {
          try {
            const live = await getLiveHoldings(w.address)
            const tokenValue = live.holdings.reduce((s, h) => s + h.valueSol, 0)
            liveByWallet.set(w.id, tokenValue + live.nativeSol)
          } catch (err) {
            app.log.warn({ err, wallet: w.address }, '[pnl] live fetch failed')
          }
        }),
      )

      // Cost basis per tier = net user cashflow (deposits − withdrawals).
      // The holdings.costBasisSol column only tracks the portion that
      // actually got swapped into tokens, so it understates cost whenever
      // capInputToLiquidity leaves part of the deposit sitting as native
      // SOL in the sub-wallet — that native SOL is still the user's money.
      const [depositRows, withdrawalRows] = await Promise.all([
        db.deposit.groupBy({
          by: ['riskTier'],
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          _sum: { amountSol: true, feeSol: true },
        }),
        db.withdrawal.groupBy({
          by: ['riskTier'],
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] } },
          _sum: { amountSol: true, feeSol: true },
        }),
      ])
      // Cost basis = net capital in the vault (deposits minus fees minus withdrawals).
      // Fees never enter the vault so excluding them prevents an instant
      // negative PnL equal to the fee amount.
      const netDepositedByTier = new Map<string, number>()
      for (const d of depositRows) {
        const gross = Number(d._sum.amountSol ?? 0)
        const fee = Number(d._sum.feeSol ?? 0)
        netDepositedByTier.set(d.riskTier, gross - fee)
      }
      for (const w of withdrawalRows) {
        netDepositedByTier.set(
          w.riskTier,
          (netDepositedByTier.get(w.riskTier) ?? 0) - Number(w._sum.amountSol ?? 0),
        )
      }

      const tiers = wallets.map((w) => {
        // When a wallet has zero holdings, its value is 0 — any remaining
        // native SOL is a gas reserve, not user value. Only count the live
        // balance when the wallet actually holds tokens.
        const hasHoldings = w.holdings.length > 0
        const currentValue = hasHoldings
          ? (liveByWallet.get(w.id) ??
             w.holdings.reduce((s, h) => s + Number(h.valueSolEst), 0))
          : 0
        const costBasis = netDepositedByTier.get(w.riskTier) ?? 0
        const realized = Number(w.realizedPnlSol)
        // `costBasis` here is net user capital still in the vault
        // (deposits - withdrawals). That already bakes realized cashflows
        // into the base, so total PnL is simply current value minus net
        // capital, and unrealized is the remainder after realized PnL.
        const totalPnl = currentValue - costBasis
        const unrealized = totalPnl - realized
        const pnlPct = costBasis > 0 ? (totalPnl / costBasis) * 100 : 0
        return {
          riskTier: w.riskTier,
          walletAddress: w.address,
          currentValueSol: currentValue.toFixed(9),
          costBasisSol: costBasis.toFixed(9),
          realizedSol: realized.toFixed(9),
          unrealizedSol: unrealized.toFixed(9),
          totalPnlSol: totalPnl.toFixed(9),
          pnlPct: pnlPct.toFixed(2),
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
        where: { userId },
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
        where: { userId },
        select: { id: true },
      })
      if (wallets.length === 0) {
        return { success: true, data: { points: [], hours, cashflowCount: 0 } }
      }

      const snapshots = await db.pnlSnapshot.findMany({
        where: {
          subWalletId: { in: wallets.map((w) => w.id) },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'asc' },
        select: { totalValueSol: true, createdAt: true },
      })

      // Sum across all sub-wallets per timestamp bucket (snapshot worker
      // writes one row per wallet at the same instant).
      const bucket = new Map<number, number>()
      for (const s of snapshots) {
        const t = s.createdAt.getTime()
        bucket.set(t, (bucket.get(t) ?? 0) + Number(s.totalValueSol))
      }
      const merged = [...bucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ t: new Date(t), v }))
      if (merged.length < 2) {
        return { success: true, data: { points: [], hours, cashflowCount: 0 } }
      }

      // Cashflows: deposits in - withdrawals out, both gross. Slippage is
      // an internal cost that should hit the return, not be neutralized
      // as a "user cashflow".
      const [deposits, withdrawals] = await Promise.all([
        db.deposit.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] }, createdAt: { gte: since } },
          select: { amountSol: true, confirmedAt: true, createdAt: true },
        }),
        db.withdrawal.findMany({
          where: { userId, status: { in: ['CONFIRMED', 'PARTIAL' as any] }, createdAt: { gte: since } },
          select: { amountSol: true, confirmedAt: true, createdAt: true },
        }),
      ])
      const cashflows: { t: number; amount: number }[] = []
      for (const d of deposits) {
        cashflows.push({
          t: (d.confirmedAt ?? d.createdAt).getTime(),
          amount: Number(d.amountSol),
        })
      }
      for (const w of withdrawals) {
        cashflows.push({
          t: (w.confirmedAt ?? w.createdAt).getTime(),
          amount: -Number(w.amountSol),
        })
      }

      // Outlier guard: clamp implausible single-hour returns to step=1.
      // Pre-allocation zero snapshots, reconciled amount drift, and RPC
      // blips would otherwise poison the chain.
      const MIN_STEP = 0.5
      const MAX_STEP = 3.0
      const points: { t: string; twr: number; valueSol: number }[] = []
      let index = 100
      points.push({ t: merged[0].t.toISOString(), twr: 100, valueSol: merged[0].v })
      for (let i = 1; i < merged.length; i++) {
        const prev = merged[i - 1]
        const cur = merged[i]
        let cf = 0
        for (const c of cashflows) {
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

      return { success: true, data: { points, hours, cashflowCount: cashflows.length } }
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
        where: { userId },
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
        const flows = flowsByTier.get(w.riskTier) ?? []
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
        where: { userId },
        include: { holdings: { select: { tokenMint: true } } },
      })
      const mints = new Set<string>()
      for (const w of wallets) for (const h of w.holdings) mints.add(h.tokenMint)
      if (mints.size === 0) return { success: true, data: { tokens: [], hours } }

      // Resolve symbol/name via most recent TokenScore
      const scores = await db.tokenScore.findMany({
        where: { tokenMint: { in: [...mints] } },
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
        where: { userId },
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

import type { FastifyInstance } from 'fastify'
import { db } from '@bags-index/db'
import { blacklistTokenSchema, whitelistWalletSchema, RISK_TIERS, TWEET_PLAN, type RiskTier } from '@bags-index/shared'
import { createSolanaServerWallet } from '@bags-index/solana'
import { requireAdmin } from '../middleware/auth.js'
import {
  scoringQueue,
  rebalanceQueue,
  priceSnapshotQueue,
  dexScoringQueue,
} from '../queue/queues.js'

/** Tweet posting interval in hours — 84 tweets every 4h = 14 days */
const TWEET_INTERVAL_HOURS = 4

const SYSTEM_VAULT_PRIVY_ID = 'system:protocol-vault'

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  /**
   * GET /admin/vault-pnl-history?hours=168
   * Hourly PnL snapshot history for the protocol vault's sub-wallets.
   * Admin-gated; mirrors the user-scoped /portfolio/pnl-history shape so
   * the same chart component renders it.
   */
  app.get<{ Querystring: { hours?: string } }>('/vault-pnl-history', async (req, reply) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: { subWallets: { select: { id: true, address: true, riskTier: true } } },
      })
      if (!user || user.subWallets.length === 0) {
        return { success: true, data: { tiers: [], hours } }
      }

      const snapshots = await db.pnlSnapshot.findMany({
        where: {
          subWalletId: { in: user.subWallets.map((w) => w.id) },
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

      const tiers = user.subWallets.map((w) => ({
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
      app.log.error(err, 'Failed to load vault pnl history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/vault-twr-history?hours=168
   *
   * Time-weighted return for the protocol vault, indexed to 100 at the
   * first snapshot in range. The vault is continuously funded by fee-claim
   * deposits, so raw value goes up both when prices rise AND when new fees
   * arrive — which makes raw value useless as a "performance" measure.
   *
   * TWR neutralizes that: for each consecutive pair of hourly PnlSnapshots
   * (t_i → t_{i+1}), we subtract any cashflow C that arrived in the
   * interval before computing the return:
   *     step = (V_{i+1} - C) / V_i
   * Then we chain: index_{i+1} = index_i * step. Cashflows are sourced
   * from VAULT_FEE_CLAIM audit-log entries (the same canonical source the
   * vault dashboard uses for "Recent Claims"), so manual seed deposits
   * don't show up as phantom cashflows.
   */
  app.get<{ Querystring: { hours?: string } }>('/vault-twr-history', async (req, reply) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: { subWallets: { select: { id: true } } },
      })
      if (!user || user.subWallets.length === 0) {
        return { success: true, data: { points: [], hours } }
      }

      const subWalletIds = user.subWallets.map((w) => w.id)

      // Snapshots — sum across sub-wallets per timestamp bucket (currently
      // one sub-wallet, but tier flips create new rows over time).
      const snapshots = await db.pnlSnapshot.findMany({
        where: { subWalletId: { in: subWalletIds }, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { totalValueSol: true, createdAt: true },
      })
      if (snapshots.length < 2) {
        return { success: true, data: { points: [], hours } }
      }

      // Cashflows — only real fee claims (filter via audit log).
      const claimLogs = await db.auditLog.findMany({
        where: { action: 'VAULT_FEE_CLAIM', createdAt: { gte: since } },
        select: { resource: true, createdAt: true },
      })
      const claimDepositIds = claimLogs
        .map((l) => (l.resource ?? '').replace(/^deposit:/, ''))
        .filter(Boolean)
      const claimDeposits = claimDepositIds.length
        ? await db.deposit.findMany({
            where: { id: { in: claimDepositIds }, userId: user.id },
            select: { amountSol: true, createdAt: true, confirmedAt: true },
            orderBy: { createdAt: 'asc' },
          })
        : []
      const cashflows = claimDeposits.map((d) => ({
        t: (d.confirmedAt ?? d.createdAt).getTime(),
        amount: Number(d.amountSol),
      }))

      // Chain TWR. Snapshots already include the cashflow in totalValueSol,
      // so subtract any flows that arrived in (prev, cur] before computing
      // the return.
      //
      // Outlier guard: any sub-period return outside [-50%, +200%] in a
      // single hour is almost certainly a snapshot artifact (pre-allocation
      // zero, drifted amount that got reconciled, RPC blip, etc.) — not a
      // real price move. Clamp it to step=1 so it can't poison the chain.
      const MIN_STEP = 0.5
      const MAX_STEP = 3.0
      const points: { t: string; twr: number; valueSol: number }[] = []
      let index = 100
      points.push({
        t: snapshots[0].createdAt.toISOString(),
        twr: 100,
        valueSol: Number(snapshots[0].totalValueSol),
      })
      for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1]
        const cur = snapshots[i]
        const v0 = Number(prev.totalValueSol)
        const v1 = Number(cur.totalValueSol)
        const lo = prev.createdAt.getTime()
        const hi = cur.createdAt.getTime()
        let cf = 0
        for (const c of cashflows) {
          if (c.t > lo && c.t <= hi) cf += c.amount
        }
        let step = 1
        if (v0 > 0) {
          const adj = v1 - cf
          step = adj / v0
          if (!isFinite(step) || step <= 0) step = 1
          if (step < MIN_STEP || step > MAX_STEP) step = 1
        }
        index *= step
        points.push({ t: cur.createdAt.toISOString(), twr: index, valueSol: v1 })
      }

      return { success: true, data: { points, hours, cashflowCount: cashflows.length } }
    } catch (err) {
      app.log.error(err, 'Failed to compute vault TWR')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/vault-token-price-history?hours=168
   * Per-token SOL price history for the protocol vault's current holdings.
   * Admin-gated. Mirrors the shape of /portfolio/token-price-history.
   */
  app.get<{ Querystring: { hours?: string } }>('/vault-token-price-history', async (req, reply) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1), 24 * 90)
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: { subWallets: { include: { holdings: { select: { tokenMint: true } } } } },
      })
      if (!user) return { success: true, data: { tokens: [], hours } }

      const mints = new Set<string>()
      for (const w of user.subWallets) for (const h of w.holdings) mints.add(h.tokenMint)
      if (mints.size === 0) return { success: true, data: { tokens: [], hours } }

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
      app.log.error(err, 'Failed to load vault token price history')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

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
   * POST /admin/rebuild-vault-pnl?hours=48 — wipe the last N hours of
   * PnlSnapshot + TokenPriceSnapshot rows for the protocol vault's
   * sub-wallets and enqueue a fresh snapshot. Use this after fixing a
   * pricing bug so the charts don't keep showing the stale history.
   * Admin-only (preHandler enforces).
   */
  app.post<{ Querystring: { hours?: string } }>(
    '/rebuild-vault-pnl',
    async (req, reply) => {
      try {
        const hours = Math.min(
          Math.max(parseInt(req.query.hours ?? '48', 10) || 48, 1),
          24 * 30,
        )
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)

        const vaultUser = await db.user.findFirst({
          where: { privyUserId: 'system:protocol-vault' },
          include: { subWallets: { select: { id: true } } },
        })
        if (!vaultUser) {
          return reply.status(404).send({ error: 'Protocol vault not found' })
        }
        const wids = vaultUser.subWallets.map((w) => w.id)
        if (wids.length === 0) {
          return { success: true, data: { deleted: 0, jobId: null } }
        }

        const deleted = await db.pnlSnapshot.deleteMany({
          where: { subWalletId: { in: wids }, createdAt: { gte: since } },
        })

        const job = await priceSnapshotQueue.add('manual-snapshot', {})
        return {
          success: true,
          data: { deletedSnapshots: deleted.count, hours, jobId: job.id },
        }
      } catch (err) {
        app.log.error(err, 'Failed to rebuild vault pnl')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * GET /admin/vault — protocol vault holdings and deposits summary.
   * Admin-only; returns the system:protocol-vault user's sub-wallets,
   * token holdings, and fee-claim history.
   */
  app.get<{ Querystring: { live?: string } }>('/vault', async (req, reply) => {
    try {
      const wantsLive = req.query.live === '1' || req.query.live === 'true'
      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: {
          subWallets: { include: { holdings: true } },
        },
      })
      if (!user) return { success: true, data: null }

      // Real fee claims write a VAULT_FEE_CLAIM audit log row pointing at the
      // resulting Deposit. Use that as the source of truth for "claims" so
      // manual seed/synthetic deposits don't pollute the dashboard.
      const claimLogs = await db.auditLog.findMany({
        where: { action: 'VAULT_FEE_CLAIM' },
        orderBy: { createdAt: 'desc' },
        select: { resource: true },
      })
      const claimDepositIds = claimLogs
        .map((l) => (l.resource ?? '').replace(/^deposit:/, ''))
        .filter(Boolean)
      const claimDeposits = claimDepositIds.length
        ? await db.deposit.findMany({
            where: { id: { in: claimDepositIds }, userId: user.id },
            orderBy: { createdAt: 'desc' },
          })
        : []

      // Live read-through is opt-in via ?live=1. DB holdings are kept
      // fresh by post-swap reconcile in every worker, so the default
      // page render just uses them — no Helius DAS hit per visit.
      // Admin dashboard's "Refresh Holdings" button sets ?live=1 to force
      // a fresh read when needed.
      let live: Awaited<ReturnType<typeof import('@bags-index/solana').getLiveHoldings>> | null = null
      if (wantsLive) {
        try {
          const { getLiveHoldings } = await import('@bags-index/solana')
          live = await getLiveHoldings(user.walletAddress)
        } catch (err) {
          app.log.warn({ err }, '[admin/vault] live holdings fetch failed')
        }
      }

      // Fetch native SOL balance per sub-wallet so each tier card can
      // surface its idle gas reserve the same way the user dashboard does.
      // `live` already carries nativeSol for the first wallet; for others
      // (or when live is off) do a cheap per-wallet RPC read in parallel.
      const { getNativeSolBalance } = await import('@bags-index/solana')
      const nativeSolByAddress = new Map<string, number>()
      if (live) nativeSolByAddress.set(user.subWallets[0]?.address ?? '', live.nativeSol)
      await Promise.all(
        user.subWallets.map(async (w) => {
          if (nativeSolByAddress.has(w.address)) return
          try {
            nativeSolByAddress.set(w.address, await getNativeSolBalance(w.address))
          } catch {
            nativeSolByAddress.set(w.address, 0)
          }
        }),
      )

      // Resolve symbol/name/MC per mint from the most recent TokenScore row.
      // Include both DB holdings and (if available) live on-chain mints.
      const mints = new Set<string>()
      for (const w of user.subWallets) for (const h of w.holdings) mints.add(h.tokenMint)
      if (live) for (const h of live.holdings) mints.add(h.tokenMint)
      const scores = mints.size
        ? await db.tokenScore.findMany({
            where: { tokenMint: { in: [...mints] }, source: 'BAGS' },
            orderBy: { scoredAt: 'desc' },
            select: {
              tokenMint: true,
              tokenSymbol: true,
              tokenName: true,
              marketCapUsd: true,
            },
          })
        : []
      const metaByMint = new Map<
        string,
        { symbol: string; name: string; marketCapUsd: number }
      >()
      for (const s of scores) {
        if (!metaByMint.has(s.tokenMint)) {
          metaByMint.set(s.tokenMint, {
            symbol: s.tokenSymbol,
            name: s.tokenName,
            marketCapUsd: Number(s.marketCapUsd ?? 0),
          })
        }
      }

      const tokenValueSol = user.subWallets.reduce(
        (sum, w) => sum + w.holdings.reduce((h, x) => h + Number(x.valueSolEst || 0), 0),
        0,
      )

      const nativeSol = live?.nativeSol ?? 0
      const totalValueSol = live?.totalValueSol ?? tokenValueSol + nativeSol

      const totalClaimedSol = claimDeposits.reduce(
        (s, d) => s + Number(d.amountSol || 0),
        0,
      )

      return {
        success: true,
        data: {
          walletAddress: user.walletAddress,
          subWallets: user.subWallets.map((w, idx) => {
            // First sub-wallet uses live on-chain holdings (the vault
            // currently has a single sub-wallet). Any additional wallets
            // fall back to DB rows.
            const liveRows =
              idx === 0 && live
                ? live.holdings.map((h) => ({
                    tokenMint: h.tokenMint,
                    amount: h.amount,
                    valueSol: h.valueSol,
                    priceSource: h.source as string | undefined,
                  }))
                : w.holdings.map((h) => ({
                    tokenMint: h.tokenMint,
                    amount: h.amount.toString(),
                    valueSol: Number(h.valueSolEst ?? 0),
                    priceSource: undefined as string | undefined,
                  }))
            const tierTokenValueSol = liveRows.reduce((s, h) => s + h.valueSol, 0)
            const wNativeSol =
              liveRows.length > 0 ? nativeSolByAddress.get(w.address) ?? 0 : 0
            const totalValueSol = tierTokenValueSol + wNativeSol
            return {
              riskTier: w.riskTier,
              address: w.address,
              walletAddress: w.address, // dashboard-parity alias
              totalValueSol: totalValueSol.toFixed(9),
              nativeSol: wNativeSol.toFixed(9),
              holdings: liveRows.map((h) => {
                const meta = metaByMint.get(h.tokenMint)
                return {
                  tokenMint: h.tokenMint,
                  tokenSymbol: meta?.symbol ?? null,
                  tokenName: meta?.name ?? null,
                  amount: h.amount,
                  // Dashboard-shape fields (valueSol + allocationPct + MC).
                  valueSol: h.valueSol.toFixed(9),
                  // Keep legacy field name for existing admin consumers.
                  valueSolEst: h.valueSol.toFixed(9),
                  marketCapUsd: meta?.marketCapUsd ?? 0,
                  allocationPct:
                    tierTokenValueSol > 0
                      ? ((h.valueSol / tierTokenValueSol) * 100).toFixed(2)
                      : '0',
                  priceSource: h.priceSource,
                }
              }),
            }
          }),
          totals: {
            totalValueSol: totalValueSol.toFixed(6),
            tokenValueSol: tokenValueSol.toFixed(6),
            nativeSol: nativeSol.toFixed(6),
            totalClaimedSol: totalClaimedSol.toFixed(6),
            claimCount: claimDeposits.length,
          },
          recentClaims: claimDeposits.slice(0, 10).map((d) => ({
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
   * POST /admin/vault/reconcile — sync DB holdings to on-chain balances.
   *
   * DB `Holding.amount` is tracked optimistically from swap quote outAmounts,
   * which can drift from reality (slippage, partial fills, external sends,
   * rounding). This endpoint fetches actual SPL balances from Helius for
   * the protocol vault wallet and rewrites the holdings rows to match:
   *   - existing holding + on-chain balance → update amount
   *   - holding with zero on-chain balance → delete
   *   - on-chain balance with no holding row → insert (valueSolEst=0 until
   *     the next price-snapshot tick computes it)
   *
   * Safe to call anytime. Cost basis and realized PnL are preserved.
   */
  app.post('/vault/reconcile', async (_req, reply) => {
    try {
      const { getTokenBalances } = await import('@bags-index/solana')
      const user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: { subWallets: { include: { holdings: true } } },
      })
      if (!user || user.subWallets.length === 0) {
        return reply.status(404).send({ error: 'Protocol vault not initialized' })
      }
      const vault = user.subWallets[0]

      const chain = (await getTokenBalances(vault.address)) as {
        tokens?: Array<{ mint: string; amount: number | string; decimals: number }>
      }
      const onChain = new Map<string, bigint>()
      for (const t of chain.tokens ?? []) {
        const raw = typeof t.amount === 'string' ? BigInt(t.amount) : BigInt(Math.floor(t.amount))
        if (raw > 0n) onChain.set(t.mint, raw)
      }

      let updated = 0
      let deleted = 0
      let inserted = 0
      const dbByMint = new Map(vault.holdings.map((h) => [h.tokenMint, h]))

      // Update or delete existing rows
      for (const h of vault.holdings) {
        const onChainAmt = onChain.get(h.tokenMint) ?? 0n
        if (onChainAmt === 0n) {
          await db.holding.delete({ where: { id: h.id } })
          deleted++
        } else if (onChainAmt !== h.amount) {
          await db.holding.update({
            where: { id: h.id },
            data: { amount: onChainAmt },
          })
          updated++
        }
      }

      // Insert new rows for mints present on-chain but missing in DB
      for (const [mint, amt] of onChain) {
        if (dbByMint.has(mint)) continue
        await db.holding.create({
          data: {
            subWalletId: vault.id,
            tokenMint: mint,
            amount: amt,
            valueSolEst: '0',
            costBasisSol: '0',
          },
        })
        inserted++
      }

      await db.auditLog.create({
        data: {
          action: 'VAULT_RECONCILE',
          resource: `subwallet:${vault.id}`,
          metadata: { updated, deleted, inserted, onChainMints: onChain.size },
        },
      })

      return {
        success: true,
        data: { updated, deleted, inserted, onChainMints: onChain.size },
      }
    } catch (err) {
      app.log.error(err, 'Failed to reconcile vault')
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
  app.post<{ Querystring: { tier?: string } }>('/trigger-scoring', async (req, reply) => {
    try {
      // With per-tier scheduling, a manual trigger fans out into 3 jobs
      // (one per tier). Pass ?tier=DEGEN|BALANCED|CONSERVATIVE to run a
      // single tier. No body → all three.
      const tierArg = (req.query.tier ?? '').toUpperCase()
      const targets: RiskTier[] =
        tierArg && RISK_TIERS.includes(tierArg as RiskTier)
          ? [tierArg as RiskTier]
          : [...RISK_TIERS]
      for (const tier of targets) {
        await scoringQueue.add(
          `manual-scoring-${tier}`,
          { tier },
          { priority: 1 },
        )
      }
      return {
        success: true,
        data: { message: `Scoring queued`, tiers: targets },
      }
    } catch (err) {
      app.log.error(err, 'Failed to trigger scoring')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/trigger-dex-scoring
   * Enqueue an on-demand DexScreener admin hotlist scoring cycle.
   */
  app.post('/trigger-dex-scoring', async (_req, reply) => {
    try {
      const job = await dexScoringQueue.add(
        'manual-dex-scoring',
        {},
        { priority: 1 },
      )
      return {
        success: true,
        data: { jobId: job.id, message: 'DexScreener scoring queued' },
      }
    } catch (err) {
      app.log.error(err, 'Failed to trigger dex-scoring')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/dex-price-history?tier=BALANCED&hours=168
   * Admin-only per-token price series for the latest DexScreener top-10 of a
   * given tier. Powers the chart on /admin/dex.
   */
  app.get<{ Querystring: { tier?: string; hours?: string } }>(
    '/dex-price-history',
    async (req, reply) => {
      try {
        const tier = (req.query.tier ?? 'BALANCED').toUpperCase() as
          | 'CONSERVATIVE'
          | 'BALANCED'
          | 'DEGEN'
        if (!['CONSERVATIVE', 'BALANCED', 'DEGEN'].includes(tier)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        const hours = Math.min(
          Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1),
          24 * 90,
        )
        const since = new Date(Date.now() - hours * 60 * 60 * 1000)

        const cycle = await db.scoringCycle.findFirst({
          where: { status: 'COMPLETED', tier, source: 'DEXSCREENER' },
          orderBy: { completedAt: 'desc' },
          include: {
            scores: {
              where: {
                riskTier: tier,
                source: 'DEXSCREENER',
                rank: { gte: 1, lte: 10 },
              },
              orderBy: { rank: 'asc' },
              select: {
                tokenMint: true,
                tokenSymbol: true,
                tokenName: true,
              },
            },
          },
        })
        if (!cycle || cycle.scores.length === 0) {
          return { success: true, data: { tier, tokens: [], hours } }
        }

        const mints = cycle.scores.map((s) => s.tokenMint)
        const metaByMint = new Map<
          string,
          { symbol: string | null; name: string | null }
        >(
          cycle.scores.map((s) => [
            s.tokenMint,
            { symbol: s.tokenSymbol, name: s.tokenName },
          ]),
        )

        const samples = await db.tokenPriceSnapshot.findMany({
          where: { tokenMint: { in: mints }, createdAt: { gte: since } },
          orderBy: { createdAt: 'asc' },
          select: { tokenMint: true, priceSol: true, createdAt: true },
        })
        const byMint = new Map<string, typeof samples>()
        for (const s of samples) {
          const arr = byMint.get(s.tokenMint) ?? []
          arr.push(s)
          byMint.set(s.tokenMint, arr)
        }

        const tokens = mints.map((mint) => {
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

        return { success: true, data: { tier, tokens, hours } }
      } catch (err) {
        app.log.error(err, 'Failed to get dex price history')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

  /**
   * GET /admin/dex-hotlist
   * Latest DexScreener-sourced scoring results across all 3 tiers.
   * Admin-only (preHandler enforces).
   */
  app.get('/dex-hotlist', async (_req, reply) => {
    try {
      const tiers = ['CONSERVATIVE', 'BALANCED', 'DEGEN'] as const
      const results = await Promise.all(
        tiers.map(async (tier) => {
          const cycle = await db.scoringCycle.findFirst({
            where: { status: 'COMPLETED', tier, source: 'DEXSCREENER' },
            orderBy: { completedAt: 'desc' },
            select: { id: true, completedAt: true },
          })
          if (!cycle) return { tier, scoredAt: null, tokens: [] }
          const scores = await db.tokenScore.findMany({
            where: {
              cycleId: cycle.id,
              riskTier: tier,
              source: 'DEXSCREENER',
            },
            orderBy: [{ rank: 'asc' }],
          })
          return {
            tier,
            scoredAt: cycle.completedAt,
            tokens: scores.map((s) => ({
              tokenMint: s.tokenMint,
              tokenSymbol: s.tokenSymbol,
              tokenName: s.tokenName,
              rank: s.rank,
              compositeScore: Number(s.compositeScore),
              volume24h: Number(s.volume24h),
              holderCount: s.holderCount,
              holderGrowthPct: Number(s.holderGrowthPct),
              priceUsd: Number(s.priceUsd),
              liquidityUsd: Number(s.liquidityUsd),
              marketCapUsd: Number(s.marketCapUsd),
              safetyVerdict: s.safetyVerdict,
              isBlacklisted: s.isBlacklisted,
            })),
          }
        }),
      )
      return { success: true, data: results }
    } catch (err) {
      app.log.error(err, 'Failed to get dex-hotlist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/dex-aggregate-history?tier=BALANCED&hours=168
   *
   * Honest-replay index line for the DexScreener-sourced admin hotlist —
   * same algorithm as the public BAGS /index/aggregate-history but scoped
   * to `source: 'DEXSCREENER'` so the chart on /admin/dex reflects the
   * actual tokens in the list below, not the live BAGS vaults. Pure
   * top-10 weighted by compositeScore (no BAGSX, no SOL anchor — those
   * concepts don't exist in the dex product). Normalized to 100 at the
   * first bucket in range; marks basket switches with `rebalance: true`.
   */
  app.get<{ Querystring: { tier?: string; hours?: string } }>(
    '/dex-aggregate-history',
    async (req, reply) => {
      try {
        const tier = (req.query.tier ?? 'BALANCED').toUpperCase() as
          | 'CONSERVATIVE'
          | 'BALANCED'
          | 'DEGEN'
        if (!['CONSERVATIVE', 'BALANCED', 'DEGEN'].includes(tier)) {
          return reply.status(400).send({ error: 'Invalid tier' })
        }
        const hours = Math.min(
          Math.max(parseInt(req.query.hours ?? '168', 10) || 168, 1),
          24 * 90,
        )
        const HOUR_MS = 60 * 60 * 1000
        const since = new Date(Date.now() - hours * HOUR_MS)

        const [activeAtStart, withinRange] = await Promise.all([
          db.scoringCycle.findFirst({
            where: {
              status: 'COMPLETED',
              source: 'DEXSCREENER',
              tier,
              completedAt: { not: null, lte: since },
            },
            orderBy: { completedAt: 'desc' },
            select: { id: true, completedAt: true },
          }),
          db.scoringCycle.findMany({
            where: {
              status: 'COMPLETED',
              source: 'DEXSCREENER',
              tier,
              completedAt: { gt: since },
            },
            orderBy: { completedAt: 'asc' },
            select: { id: true, completedAt: true },
          }),
        ])
        const cycles = [...(activeAtStart ? [activeAtStart] : []), ...withinRange]
        if (cycles.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }

        const allScores = await db.tokenScore.findMany({
          where: {
            cycleId: { in: cycles.map((c) => c.id) },
            riskTier: tier,
            source: 'DEXSCREENER',
            isBlacklisted: false,
            rank: { gte: 1, lte: 10 },
          },
          select: { cycleId: true, tokenMint: true, compositeScore: true },
        })
        const basketByCycle = new Map<string, Map<string, number>>()
        const allMints = new Set<string>()
        for (const c of cycles) {
          const scores = allScores.filter((s) => s.cycleId === c.id)
          const total = scores.reduce((a, s) => a + Number(s.compositeScore), 0) || 1
          const basket = new Map<string, number>()
          for (const s of scores) {
            basket.set(s.tokenMint, Number(s.compositeScore) / total)
            allMints.add(s.tokenMint)
          }
          basketByCycle.set(c.id, basket)
        }

        const priceSince = new Date(since.getTime() - 24 * HOUR_MS)
        const samples = await db.tokenPriceSnapshot.findMany({
          where: {
            tokenMint: { in: [...allMints] },
            createdAt: { gte: priceSince },
          },
          orderBy: { createdAt: 'asc' },
          select: { tokenMint: true, priceSol: true, createdAt: true },
        })
        if (samples.length === 0) {
          return { success: true, data: { tier, points: [] } }
        }
        const seriesByMint = new Map<string, { t: number; price: number }[]>()
        for (const s of samples) {
          const arr = seriesByMint.get(s.tokenMint) ?? []
          arr.push({ t: s.createdAt.getTime(), price: Number(s.priceSol) })
          seriesByMint.set(s.tokenMint, arr)
        }
        const priceAt = (mint: string, t: number): number | null => {
          const arr = seriesByMint.get(mint)
          if (!arr || arr.length === 0) return null
          let lo = 0
          let hi = arr.length - 1
          let chosen = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (arr[mid].t <= t) {
              chosen = mid
              lo = mid + 1
            } else {
              hi = mid - 1
            }
          }
          if (chosen < 0) return null
          return arr[chosen].price
        }

        const cycleTimes = cycles.map((c) => ({
          t: c.completedAt!.getTime(),
          id: c.id,
        }))
        const activeCycleAt = (t: number): string | null => {
          let lo = 0
          let hi = cycleTimes.length - 1
          let chosen = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (cycleTimes[mid].t <= t) {
              chosen = mid
              lo = mid + 1
            } else {
              hi = mid - 1
            }
          }
          return chosen < 0 ? null : cycleTimes[chosen].id
        }

        const startBucket = new Date(since)
        startBucket.setMinutes(0, 0, 0)
        const nowFloor = new Date()
        nowFloor.setMinutes(0, 0, 0)
        const orderedTimes: number[] = []
        for (let t = startBucket.getTime(); t <= nowFloor.getTime(); t += HOUR_MS) {
          orderedTimes.push(t)
        }

        const points: { t: string; indexed: number; rebalance?: boolean }[] = []
        let index = 100
        let prevTime = -1
        let prevCycleId: string | null = null
        for (const t of orderedTimes) {
          const cycleId = activeCycleAt(t)
          if (!cycleId) continue
          const basket = basketByCycle.get(cycleId)
          if (!basket) continue

          if (prevTime < 0) {
            let any = false
            for (const mint of basket.keys()) {
              if (priceAt(mint, t) !== null) { any = true; break }
            }
            if (!any) continue
            points.push({ t: new Date(t).toISOString(), indexed: 100 })
            prevTime = t
            prevCycleId = cycleId
            continue
          }

          if (cycleId !== prevCycleId) {
            points.push({ t: new Date(t).toISOString(), indexed: index, rebalance: true })
            prevTime = t
            prevCycleId = cycleId
            continue
          }

          let stepRet = 0
          let wSum = 0
          for (const [mint, w] of basket) {
            const p0 = priceAt(mint, prevTime)
            const p1 = priceAt(mint, t)
            if (p0 !== null && p1 !== null && p0 > 0) {
              stepRet += w * (p1 / p0 - 1)
              wSum += w
            }
          }
          if (wSum > 0) {
            stepRet /= wSum
            index = index * (1 + stepRet)
          }
          points.push({ t: new Date(t).toISOString(), indexed: index })
          prevTime = t
          prevCycleId = cycleId
        }

        return { success: true, data: { tier, points } }
      } catch (err) {
        app.log.error(err, 'Failed to compute dex aggregate index history')
        return reply.status(500).send({ error: 'Internal server error' })
      }
    },
  )

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
   * One-shot dashboard payload — users, volumes, fees, queues, latest cycles.
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
        subWalletsByTier,
        depositTotals,
        depositAgg,
        deposit24hAgg,
        withdrawalAgg,
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
        db.subWallet.groupBy({
          by: ['riskTier'],
          _count: true,
        }),
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
        db.projectVault.count(),
        db.projectVault.aggregate({
          _sum: { totalSolReceived: true, currentValueSol: true },
        }),
        db.tokenBlacklist.count(),
        db.scoringCycle.findFirst({ where: { source: 'BAGS' }, orderBy: { startedAt: 'desc' } }),
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
          projectVaults: {
            total: projectVaultCount,
            totalSolReceived: projectVaultAgg._sum.totalSolReceived?.toString() ?? '0',
            currentValueSol: projectVaultAgg._sum.currentValueSol?.toString() ?? '0',
          },
          blacklist: { count: blacklistCount },
          capacity: (() => {
            // These constants must match worker/src/workers/rebalance.worker.ts
            // (REBALANCE_BATCH_SIZE × REBALANCE_BATCH_INTERVAL_MS) and
            // worker/src/index.ts (per-tier scheduler intervals).
            const BATCH_SIZE = 25
            const BATCH_INTERVAL_HOURS = 1
            const TIER_INTERVAL_HOURS: Record<RiskTier, number> = {
              DEGEN: 4 + 23 / 60,
              BALANCED: 12 + 8 / 60,
              CONSERVATIVE: 23 + 23 / 60,
            }
            const countByTier: Record<string, number> = {}
            for (const row of subWalletsByTier) {
              countByTier[row.riskTier] = row._count
            }
            return RISK_TIERS.map((tier) => {
              const intervalH = TIER_INTERVAL_HOURS[tier]
              const max = Math.floor((BATCH_SIZE * intervalH) / BATCH_INTERVAL_HOURS)
              const current = countByTier[tier] ?? 0
              return {
                tier,
                current,
                max,
                pct: max > 0 ? Math.round((current / max) * 100) : 0,
                intervalHours: Number(intervalH.toFixed(2)),
                batchSize: BATCH_SIZE,
                batchIntervalHours: BATCH_INTERVAL_HOURS,
              }
            })
          })(),
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

  // ─── Wallet Whitelist ──────────────────────────────────────────────────

  /**
   * GET /admin/whitelist — list all whitelisted wallets
   */
  app.get('/whitelist', async (_req, reply) => {
    try {
      const entries = await db.walletWhitelist.findMany({
        orderBy: { createdAt: 'desc' },
      })
      return { success: true, data: entries }
    } catch (err) {
      app.log.error(err, 'Failed to load whitelist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/whitelist — add a wallet to the whitelist
   */
  app.post('/whitelist', async (req, reply) => {
    try {
      const { walletAddress, maxDepositSol, note } = whitelistWalletSchema.parse(req.body)
      const entry = await db.walletWhitelist.create({
        data: {
          walletAddress,
          maxDepositSol,
          note,
          addedBy: req.authUser!.walletAddress,
        },
      })
      return { success: true, data: entry }
    } catch (err) {
      app.log.error(err, 'Failed to add to whitelist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * PATCH /admin/whitelist/:wallet — update cap or note
   */
  app.patch('/whitelist/:wallet', async (req, reply) => {
    try {
      const { wallet } = req.params as { wallet: string }
      const body = req.body as { maxDepositSol?: number; note?: string }
      const data: Record<string, unknown> = {}
      if (typeof body.maxDepositSol === 'number') data.maxDepositSol = body.maxDepositSol
      if (typeof body.note === 'string') data.note = body.note
      const updated = await db.walletWhitelist.update({
        where: { walletAddress: wallet },
        data,
      })
      return { success: true, data: updated }
    } catch (err) {
      app.log.error(err, 'Failed to update whitelist entry')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * DELETE /admin/whitelist/:wallet — remove from whitelist
   */
  app.delete('/whitelist/:wallet', async (req, reply) => {
    try {
      const { wallet } = req.params as { wallet: string }
      await db.walletWhitelist.delete({ where: { walletAddress: wallet } })
      return { success: true }
    } catch (err) {
      app.log.error(err, 'Failed to remove from whitelist')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })

  /**
   * POST /admin/vault-expand
   * One-time: ensure the protocol vault has 3 sub-wallets (one per tier).
   * Creates new Privy server wallets for any missing tiers. Idempotent —
   * safe to call multiple times. The existing single sub-wallet keeps its
   * current tier; new wallets are created for the remaining two.
   */
  app.post('/vault-expand', async (_req, reply) => {
    try {
      let user = await db.user.findUnique({
        where: { privyUserId: SYSTEM_VAULT_PRIVY_ID },
        include: { subWallets: true },
      })
      if (!user) {
        return reply.status(404).send({ error: 'Protocol vault user not found' })
      }

      const existingTiers = new Set(user.subWallets.map((w) => w.riskTier))
      const allTiers: RiskTier[] = ['CONSERVATIVE', 'BALANCED', 'DEGEN']
      const created: Array<{ tier: string; address: string }> = []

      for (const tier of allTiers) {
        if (existingTiers.has(tier)) continue
        const wallet = await createSolanaServerWallet()
        const sub = await db.subWallet.create({
          data: {
            userId: user.id,
            privyWalletId: wallet.walletId,
            address: wallet.address,
            riskTier: tier,
          },
        })
        created.push({ tier, address: sub.address })
        app.log.info({ tier, address: sub.address }, '[vault-expand] Created sub-wallet')
      }

      if (created.length > 0) {
        await db.auditLog.create({
          data: {
            action: 'VAULT_EXPAND',
            resource: `user:${user.id}`,
            metadata: { created },
          },
        })
      }

      // Return all sub-wallets
      const final = await db.subWallet.findMany({
        where: { userId: user.id },
        select: { id: true, riskTier: true, address: true },
      })

      return {
        success: true,
        data: {
          created: created.length,
          subWallets: final,
        },
      }
    } catch (err) {
      app.log.error(err, 'Failed to expand vault')
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}

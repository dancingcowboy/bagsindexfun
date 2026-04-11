# bags index

An AI-powered, non-custodial index vault on Solana built for the [Bags](https://bags.fm) ecosystem.

Deposit SOL → choose a risk tier → the AI agent allocates across the top 10 performing tokens on Bags → daily rebalance → every vault holds a fixed 8% exposure to $BAGSX, the platform token.

---

## Bags Hackathon Submission

**One-liner:** Deposit SOL, get instant exposure to the top 10 performing tokens on Bags, rebalanced daily — fully non-custodial, with a fixed 8% $BAGSX exposure in every vault and an autonomous Claude agent in the loop.

**Categories:** Bags API · Fee Sharing · AI Agents · Claude Skills

### Deep Bags integration

bags-index isn't just *built on* Bags — it plugs into the Bags stack in three places at once:

1. **Bags API for discovery** — token universe pulled live from `/token-launch/feed`, MIGRATED tokens only
2. **Native Bags swaps** — every allocation, rebalance, and liquidation routes through `/trade/quote` + `/trade/swap`, signed by Privy and submitted on-chain
3. **Bags fee sharing** — the protocol registers fee-share vaults on Bags tokens, auto-claims the creator fee split, and routes claimed SOL straight back into the index pipeline

$BAGSX itself is a Bags-launched token, so platform-token exposure is fully native to the ecosystem.

### Autonomous Claude agent

On top of the quant ranking, an **autonomous Claude agent** reviews the candidate set every cycle — reading holder distribution, liquidity depth, recent price action, and on-chain signals to flag rug risk, sanity-check the top 10, and eject tokens that look compromised before they hit user vaults. The quant filter does the ranking; the agent adds a second layer of judgment that a pure formula can't. Every decision is logged for auditability.

### Every vault holds 8% $BAGSX

A flat rule applies to **every vault** in the system — user vaults and the protocol's own fee-share vault alike:
- **8% of every vault** is held in $BAGSX, the platform token
- **No deposit, withdrawal, or switch fees.** 100% of every deposit is allocated; 100% of every withdrawal returns to the user (BAGSX sold back to SOL alongside the rest of the holdings)
- **Auto-claimed Bags fee revenue** flows through the same deposit pipeline into the protocol's own vault, so the protocol accumulates more $BAGSX on every claim

As TVL grows, the protocol accumulates more $BAGSX on every deposit and rebalance. The token captures value from the vault's own activity.

### Fair execution

Rebalances use a seeded Fisher-Yates shuffle with historical weighting, so no wallet is consistently front-run or back-run. The shuffle seed is stored with every rebalance cycle for full auditability.

### Non-custodial by design

Every user gets a Privy Server Wallet as their vault sub-wallet. Transactions are signed by Privy's HSM via API — **zero private keys ever touch our database**. Users can withdraw on demand at any time. We hold custody of nothing.

### Shipped & verifiable

bags-index is live, not a prototype. The $BAGSX contract is deployed on Bags, the vault is a real Privy Server Wallet with a public address, every deposit, rebalance swap, and fee claim is an on-chain transaction with a signature you can look up. The team wallet, the platform token, and the protocol vault are all publicly verifiable.

### Why it matters for Bags

bags-index turns Bags into an index-investable ecosystem. Instead of picking one token and hoping, users get diversified, rules-based exposure to whatever is actually working on Bags right now — quant-scored, AI-reviewed, and fairly executed — and every vault holds a fixed 8% slice of $BAGSX, so the protocol accumulates more of the platform token as TVL grows. It's a passive product that makes the whole Bags launchpad more investable.

### What's next — Bags App Store integration

We'd love to turn bags-index into a standalone app for the **Bags App Store**, so any creator can plug an index vault directly into their own token's fee structure. The standalone version would be **fully configurable**: creators pick their own platform-token exposure weight (or disable it entirely), and route auto-claimed fees wherever they want. The autonomous Claude agent and the non-custodial Privy architecture come along for the ride.

---

## How It Works

### The Three Risk Tiers

Each user gets **one sub-wallet per tier** — you can deposit into any combination. The tiers do not share tokens or holdings; each runs its own universe filter, its own scoring weights, and its own rebalance schedule.

| Tier | Universe filter | Scoring weights | SOL anchor | Rebalance |
|------|-----------------|------------------|------------|-----------|
| **Conservative** | ≥ $8k liquidity, ≥ 200 holders, ≥ 5d old, vol₇d ≤ 0.6 | 0.30 vol · 0.40 growth · **0.30 liq** | **12% SOL + 8% $BAGSX** | every **24h** |
| **Balanced** | ≥ $10k liquidity, ≥ 150 holders, ≥ 3d old, vol₇d ≤ 1.5 | **0.50 vol** · 0.30 growth · 0.20 liq | 8% $BAGSX | every **12h** |
| **Degen** | ≥ $5k liquidity, ≥ 50 holders, **≤ 90d old**, vol₇d ≤ 5.0 | 0.35 vol · **0.55 growth** · 0.10 liq | 8% $BAGSX | every **4h** |

A token can appear in more than one tier, but the filters and weights make each basket behave very differently: Conservative is "SOL + the boring winners", Degen is "fresh momentum with velocity."

### Scoring (Layer 0 → Layer A)

Scoring runs daily and produces three independent top-10 baskets. Each pass has two layers:

**Layer 0 — Quant.** Deterministic, auditable. For every candidate token in the tier's universe, the worker normalizes three signals and computes a composite:

```
composite = w_volume    · (volume24h     / maxVolume)
          + w_growth    · (holderGrowth  / maxGrowth)      ← blend: 40% 24h + 60% 7d
          + w_liquidity · (liquidityUsd  / maxLiquidity)
```

- **Holder growth blend** — 60% weight on 7-day, 40% on 24h. Catches both fresh momentum and sustained traction while smoothing single-day noise.
- **Wash-trade sanity filter** — if volume-per-unique-trader exceeds 10× the median, the token's volume component is penalized by 0.25. Filters pump wallets hitting the same pool.
- **Minimum unique traders 24h** — 25, filters out dead tokens that would otherwise rank on stale liquidity.

**Layer A — AI Safety Review.** The top-(N+5) candidates are sent one-by-one to Claude with a strict contract: **the agent can only mark a token `PASS` or `REMOVED`**. It cannot add tokens and it cannot reorder. For each token it returns a one-line reason which is:
- stored on `TokenScore.safety_verdict` / `safety_reason`
- written to `AuditLog` with the cycleId + tier
- rendered as a badge on the landing page ("✓ AI Pass — LP locked 12mo, holders dispersed")

The reviewer flags obvious rug patterns (dev wallet concentration, unlocked LP, live mint authority, top-10 holder >60%), sudden holder/liquidity drains, symbol impersonation, and known exploit chatter. **It fails open** — if Claude is unreachable or returns garbage, the token passes with the error logged in the reason, so a proxy outage never silently empties the index.

After review, the first 10 survivors become the index for that tier; removed tokens are persisted with `rank = 0` so the UI can show "why rejected" for transparency.

### Rebalance Execution

Each tier has its own rebalance queue and its own cadence. Scoring only enqueues a rebalance if the tier's top-N actually changed **and** at least `REBALANCE_MIN_RANK_CHANGES = 2` positions flipped (prevents fee bleed from noisy boundary tokens).

When a rebalance fires:

1. **Create cycle** with a cryptographic random seed (`crypto.randomBytes(32)`). Seed is persisted so the entire shuffle is reproducible and auditable.
2. **Load all active sub-wallets** for that tier (only wallets with holdings).
3. **Fisher-Yates shuffle** with a seeded PRNG — so no wallet is systematically first or last in line. Fair execution order across cycles.
4. **Per wallet, compute deltas**: for each current holding, `diff = currentWeight - targetWeight`. If `diff > 2%`, queue a sell of the excess. Then for each target token, if `targetWeight - currentWeight > 2%`, queue a buy for the shortfall. The 2% band prevents micro-shuffling fees.
5. **Execute sequentially** (concurrency=1 per wallet) via the Bags native swap endpoint. Each swap is signed by the user's Privy Server Wallet (HSM) — zero keys in our DB.
6. **Record every execution** in `SwapExecution` with `inputMint`, `outputMint`, amounts, slippageBps, txSignature. Failed swaps are logged; the cycle continues with the next wallet.
7. **Crash-safe**: progress (`walletsComplete`, `walletsFailed`) is persisted after each wallet, so a killed worker resumes cleanly.

### Deposit Flow

```
User picks tier → POST /deposits { riskTier, amountSol }
      ↓
API resolves the user's sub-wallet via (userId, riskTier) compound key
Returns { depositId, subWalletAddress, netAmountSol }
      ↓
User signs SOL transfer via Privy → POST /deposits/:id/confirm { txSignature }
      ↓
API verifies on-chain, marks CONFIRMED, enqueues deposit-allocation.
      ↓
Allocation worker loads latestCycle.scores filtered by riskTier:
  reserves 8% of the vault for $BAGSX (and, on CONSERVATIVE, a 12% SOL anchor)
  for each score: weight = composite / totalComposite × (remaining %)
                  solForToken = allocatableSol × weight
                  build buy via Bags, sign via Privy, submit, update holdings
```

### Withdrawal Flow

```
POST /withdrawals { riskTier }
      ↓
API looks up the user's sub-wallet for that tier, checks it has holdings,
estimates totalValueSol and feeSol, creates a Withdrawal row (PENDING),
enqueues liquidation.
      ↓
Withdrawal worker:
  - for each holding (including the $BAGSX slice): build sell via Bags, sign via Privy, submit
  - on partial failure: sell what you can, mark PARTIAL, keep stragglers
  - transfer 100% of resulting SOL to the user's connected wallet — no fees
      ↓
Withdrawal marked COMPLETED (or PARTIAL with a list of stuck tokens)
```

Users can withdraw at any time — funds are never pooled. Each tier withdraws independently.

### Platform token exposure

- **Every vault holds a fixed 8% slice of $BAGSX**, user vaults and the protocol vault alike
- **No deposit, withdrawal, or switch fees** — 100% of every flow goes to the user
- **Auto-claimed Bags fee revenue** flows through the same deposit pipeline into the protocol's own vault, so the protocol accumulates more $BAGSX every time it claims
- Withdrawals sell the $BAGSX slice back to SOL alongside every other holding — no special casing

### Rug Protection

- Tokens losing > 20% holders in 4h → auto-ejected and added to `TokenBlacklist`
- Universe filter enforces per-tier minimum liquidity and holder floors (see table above)
- Layer-A AI review catches dev concentration, LP not locked, live mint authority, impersonation
- Manual admin blacklist for confirmed rugs (admin routes gated by `ADMIN_WALLETS`)

## Architecture

```
bags-index/
├── apps/
│   ├── web/        # Next.js 15 — landing page + dashboard
│   ├── api/        # Fastify — REST API with HttpOnly cookie JWT auth
│   └── worker/     # BullMQ — scoring, AI review, rebalance, fee-claim
├── packages/
│   ├── db/         # Prisma schema + client
│   ├── shared/     # Types, constants, Zod schemas
│   └── solana/     # Bags API client, Helius integration, swap execution
└── infra/
    └── docker/     # Postgres + Redis for local dev
```

### Non-Custodial Design

Funds never pool. Each user gets a personal sub-wallet via [Privy Server Wallets](https://docs.privy.io/guide/server-wallets/) — HSM-backed signing with zero private keys in our database. Users can withdraw at any time.

### Rug Protection

- Tokens losing >20% holders in 4 hours → auto-ejected from index
- Minimum $50K liquidity required for inclusion
- Manual admin blacklist for confirmed rugs

## Tech Stack

- **Bags API** — token discovery + native swaps
- **Helius** — holder counts (DAS API), market data
- **Privy** — wallet auth + non-custodial server wallets
- **Claude AI** — autonomous safety-review agent on every scoring cycle
- **Solana** — mainnet-beta

## Local Development

```bash
# Prerequisites: Node 22+, pnpm, Docker

# Start Postgres + Redis
docker compose -f infra/docker/docker-compose.yml up -d

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Fill in: PRIVY_APP_ID, HELIUS_API_KEY, BAGS_API_KEY

# Generate Prisma client + push schema
pnpm --filter @bags-index/db run generate
pnpm --filter @bags-index/db exec prisma db push

# Run all apps
pnpm dev
```

Web runs on `localhost:3002`, API on `localhost:3001`.

## Deployment

```bash
# First time (sets up nginx, SSL, DB, PM2)
bash deploy.sh setup

# Ongoing deploys
git push && bash deploy.sh deploy

# Other commands
bash deploy.sh status          # PM2 status
bash deploy.sh logs web        # View web logs
bash deploy.sh logs api        # View API logs
bash deploy.sh restart worker  # Restart worker only
```

## For Projects (Bags App primitive)

Any token launched on Bags can route a slice of trading fees directly into a Bags Index vault using the native Bags fee-share primitive — no middleman, no manual routing.

- **New launches**: include the vault address in your initial `claimersArray` when calling `POST /fee-share/config`.
- **Existing tokens**: your fee admin calls `POST /fee-share/admin/update-config` to add the vault to `claimersArray` / `basisPointsArray` at any time. Adoption is not gated to launch time.
- 1–100 claimers supported, BPS must sum to 10000.
- Each registered project gets a BALANCED-tier vault and a public leaderboard slot at `/projects`.
- Register via `POST /projects` (rate-limited 5/min/IP). Real authorization is on-chain: without the fee admin's signature, no fees flow.
- Auto-claimed fee SOL is routed through the same deposit pipeline as any user deposit, so the protocol vault grows its $BAGSX slice on every claim.

## Environment Variables

See [`.env.example`](.env.example) for all required variables with inline documentation.

## Security

- Auth check on every route (Privy JWT verification, HttpOnly cookie sessions)
- Ownership validation on all user-scoped queries
- Redis-backed rate limiting (100 req/min global and on `/auth`)
- Generic error messages to clients; real errors server-side only
- No private keys in database (Privy HSM)
- On-chain verification before crediting deposits
- Max 5% slippage cap on all swaps
- Admin routes gated by wallet whitelist + server-side `isAdmin` check
- `/admin` and `/dashboard` gated at the middleware layer by the auth cookie
- Audit log for all state-changing operations
- Passed a 20-point pre-launch security audit

## Emergency Sweep

If the protocol ever needs to be wound down — planned sunset, critical bug, compromise, or any other scenario where users should get their funds out without waiting for the normal withdrawal pipeline — there's a standalone script that liquidates every sub-wallet and returns the resulting SOL to each user's connected wallet.

**Location:** [`scripts/emergency-sweep.ts`](scripts/emergency-sweep.ts)

**What it does, per sub-wallet:**
1. Live-reads on-chain holdings (not the DB — so drift/reconcile gaps don't matter)
2. Sells every SPL token back to SOL via the Bags trade API
3. Transfers the resulting SOL to the user's `User.walletAddress` (the wallet they connected with)
4. Leaves ~0.01 SOL behind per sub-wallet for rent/fees

**Requirements** (can run from any laptop with network access):
- `PRIVY_APP_ID` + `PRIVY_APP_SECRET` (for sub-wallet signing)
- `DATABASE_URL` pointing at a reachable Postgres (or a restored snapshot)
- `HELIUS_API_KEY` + `BAGS_API_KEY` (for quotes and on-chain reads)

**Usage:**

```bash
# Dry run — prints the full plan, touches nothing
pnpm tsx scripts/emergency-sweep.ts

# Single user (smoke test before mass sweep)
pnpm tsx scripts/emergency-sweep.ts --execute --user <userId>

# Single sub-wallet
pnpm tsx scripts/emergency-sweep.ts --execute --wallet <subWalletId>

# Full protocol-wide sweep
pnpm tsx scripts/emergency-sweep.ts --execute
```

**Safety rails built in:**
- Dry run is the default — `--execute` required to send transactions
- 5-second abort window before live execution starts
- Per-wallet error isolation — one failed sell doesn't halt the sweep
- Skips placeholder rows (`address LIKE 'pending-%'` from failed Privy provisioning)
- Final summary reports wallets processed, sells ok/failed, total SOL returned, and a list of errored wallets

**Recommended test cadence:** dry-run against production before every public-beta milestone, and at least once against a single test wallet end-to-end (`--execute --user <test-user-id>`) so the script stays in working order.

## License

MIT

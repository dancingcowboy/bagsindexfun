# bags-index — Full Security Audit Overview

*Last updated 2026-04-15*

---

## 1. Scope

bags-index is a non-custodial Solana index-vault protocol. Users deposit SOL into per-user Privy sub-wallets (three risk tiers), the system auto-buys the top-10 tokens by score, rebalances on a schedule, and lets users withdraw anytime. Security boundaries we care about:

- **User funds** held in per-user Privy server wallets (auto-signed by the worker).
- **Protocol vault** holding 10% BAGSX and TVL-derived fees.
- **Admin plane** (scoring config, vault ops, tweet publishing).
- **Public web surface** (Next.js), **API** (Fastify), **worker** (BullMQ), **Postgres**, **Redis**.
- **Third-party**: Privy (auth + signing), Helius (RPC), Bags API, Jupiter API, Dexscreener, GrowthBook, Twitter/Telegram.

---

## 2. Pen-testing rig

Built a Docker image (`kalilinux/kali-rolling`) on the production server running as a dedicated pen-test worker. Installed the standard OSS suite:

| Tool | Purpose |
|---|---|
| **OWASP ZAP** | web-app dynamic scan (XSS, SSRF, open redirect, auth flaws) |
| **nmap** | host/service enumeration |
| **nikto** | misconfig + known CVE fingerprinting |
| **sqlmap** | SQLi probing on every query-string / JSON endpoint |
| **nuclei** | community-template CVE & misconfig templates |
| **subfinder / Assetfinder** | subdomain enumeration |
| **testssl** | TLS cipher/version + cert chain audit |
| **OSV Scanner** | walks `pnpm-lock.yaml` against OSV DB, highest signal-to-noise for deps |

Runs are scripted so we can re-scan after any infra change.

---

## 3. Critical findings (all fixed)

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **Critical** | **Prisma Studio on `*:5555`** — unauthenticated full-CRUD UI on the prod DB. Prisma 6 defaults to `0.0.0.0`. | Killed process, removed `prisma studio` from `package.json`, iptables DROP on 5555, verified via external scan |
| 2 | **Critical (10.0)** | axios SSRF via header-injection → cloud metadata exfil (GHSA-fvcv-3m26-pcqx) | Bumped `axios` across `packages/solana`, `apps/*` |
| 3 | **Critical (9.3)** | axios NO_PROXY hostname normalization bypass → SSRF (GHSA-3p68-rc4w-qgx5) | Same bump |
| 4 | **Critical** | `fast-jwt` CVE in Privy auth path | Patched via resolutions pin |
| 5 | **High (7.5)** | Next.js DoS via Server Components (GHSA-q4gf-8mx6-v5v3) | `next` 15.1 → 15.5.15 |
| 6 | **High** | `elliptic` / `bigint-buffer` crypto issues | Patched where upgradable |
| 7 | **Medium** | Docker-compose exposed Postgres 5432 + Redis 6379 on `0.0.0.0` | Rebound to `127.0.0.1` only |

Accepted: one **Low** — `ethers` signing-key risky-crypto primitive, deep `privy` transitive, unused EVM path, no upstream fix.

---

## 4. Application-layer hardening

### Authentication & authorization
- **Privy JWT** verified server-side on every authenticated route.
- **Wallet whitelist**: DB-backed table (`allowed_wallets`) + env-var allowlist; checked on auth.
- **Per-user caps**: per-tier deposit cap of 30 SOL current value.
- **Ownership checks**: every route that fetches/updates/deletes a resource by ID scopes the query to `{ id, userId }` — never `{ id }` alone.
- **Worker ownership check**: withdrawal worker re-verifies sub-wallet ∈ user before signing.
- **Admin gating**: admin wallet list enforced server-side; `/admin` silent redirect for non-admins; rejected wallet logged for forensics.
- **AuthBridge race** fixed: waits for Privy ready + retries `/auth/me` before redirect.

### Rate limiting
- Global Fastify `@fastify/rate-limit`.
- `/auth` tightened to 100/min after AuthBridge lockout incident.
- **Solana RPC proxy**: 20 req/min/IP to stop free-tier drain.
- `trustProxy` enabled so limits key on real client IP, not nginx loopback.

### Input validation
- Body typed via Fastify generics + manual guards (int range, mint format, enum membership).
- File uploads (admin tweet images): MIME whitelist + 5 MB cap.
- No `err.message` in HTTP responses — generic strings to client, full error logged server-side.

### Transport & headers
- HTTPS enforced (nginx), HSTS preload-ready, TLS 1.2+ only.
- CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy set in `next.config.ts`.
- `/.well-known/security.txt` published with contact + disclosure policy.

### Secret hygiene
- No `NEXT_PUBLIC_*` secrets; client bundle audited.
- All API keys server-side, read from PM2 env.
- `.env.example` documents every var with inline comments.

---

## 5. Protocol / on-chain safety

### Signing model
- Each user has a Privy-managed server wallet; private key never touches our infra.
- Signing requests go through Privy REST, scoped to the user-owned wallet ID.

### Transaction integrity
- **Slippage guards** on every Jupiter/Bags swap.
- **Rate-limit cascade**: Bags → Jupiter → fail (not silent).
- **Retry + confirm**: 3× retries with exponential backoff; tx confirmation by signature + on-chain balance delta (not just sig return).
- **Idempotency**: withdrawal worker checks prior CONFIRMED sells so job re-runs don't double-sell.
- **Jito MEV protection** on sensitive paths.

### Accounting integrity
- Withdrawals written to DB **before** the transfer; updated to CONFIRMED/PARTIAL/FAILED only after on-chain confirmation.
- Sweep scripts now required to write a `Withdrawal` row + clear holdings + reset `realizedPnlSol` — prevents phantom losses on re-deposit.
- PnL model: proportional cost basis, separates USER cash-outs from AUTO_TP (no cost-basis drain on auto-take-profit).
- Reconciliation: post-withdrawal job syncs DB holdings to on-chain SPL balances.

### Withdrawal safety net
- Per-tier `Force Reshuffle` and per-holding `Liquidate` with inflight-block (one PENDING withdrawal per tier at a time).
- Withdrawal reserve (`10M lamports`) prevents rent-exempt bricking on future retries.

### Emergency/ops paths
- Admin `rebuild-vault-pnl` endpoint for manual reconciliation.
- `/vault/reconcile` syncs DB holdings to on-chain balances.
- Dust-sweep skips `pending-*` placeholder wallets.

---

## 6. Infrastructure

- Postgres + Redis bound to `127.0.0.1` only; no public ports.
- Server doesn't run as root for app processes.
- PM2 `--update-env` on deploy; `.env` loaded once per boot, never client-exposed.
- Deploy pipeline: `git push` → server `git pull` → `pnpm build` → PM2 restart. Strict rule to always push before deploying to prevent silent stale deploys.
- No CI secrets stored in repo; all in production server env.

---

## 7. Third-party attack surface

| Dep | Risk | Mitigation |
|---|---|---|
| Privy | Signing outage / account takeover | Whitelist enforced; per-user wallet scoping; monitored |
| Helius RPC | Rate-limit exhaustion / DoS | API key, exponential backoff, proxy rate-limit |
| Bags API | 429 storms, downtime | Jupiter fallback cascade |
| Jupiter API | 429, 400 on new tokens | Bags fallback, retry w/ backoff |
| GrowthBook | Feature-flag compromise | Flags are non-sensitive (UI only, not auth gates) |
| Twitter/Telegram | Posting account compromise | App-specific tokens, no user data |

---

## 8. What we tested for and didn't find

- **SQL injection** — Prisma parameter binding across every query; sqlmap negative.
- **Stored/reflected XSS** — React auto-escape + CSP; ZAP negative on all user routes.
- **CSRF** — JWT in `Authorization` header (no cookies), immune by construction.
- **Open redirect** — no `?next=` style redirects in code.
- **Open S3/GCS buckets** — none used.
- **Secrets in client bundle** — audited `NEXT_PUBLIC_*`, clean.
- **TLS weak ciphers** — testssl A grade.
- **Exposed `.git`, `.env`, `.DS_Store`** on public web — none found.

---

## 9. Still open / planned

- **Trust minimization**: long-term plan documented (`PLAN-trust-minimization.md`) to move to PDA-escrowed non-custodial model. Current model still requires users to trust our Privy signer.
- **Pre-check on `/holdings/:mint/liquidate`**: reject if vault SOL balance < 0.003 SOL (avoid queueing doomed jobs).
- **Automated re-scan**: ZAP + OSV cron on the Kali worker so new deps / routes are auto-audited on every merge.
- **Bug-bounty**: `security.txt` points to a mailbox; formal program deferred until mainnet scale.

---

## 10. Standing security rules in `CLAUDE.md`

- Auth check on first line of every new API route.
- Every resource query scoped to `userId`.
- Generic error messages to client; real errors logged server-side only.
- Rate-limit on every unauthenticated endpoint.
- MIME + extension validation on uploads.
- `/audit` skill + `pnpm audit` run before first deploy and after major dep bumps.

---

*Red-team runs, OSV scans, and patch cadence documented per release. Sample scan reports available on request.*

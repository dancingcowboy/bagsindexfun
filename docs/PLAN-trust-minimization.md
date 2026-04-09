# Trust Minimization Plan — bags-index

**Status:** Draft, pending decision
**Owner:** Markus
**Last updated:** 2026-04-09

---

## Problem

Today, bags-index is architecturally a custodian-with-extra-steps:

- Sub-wallets are Privy Server Wallets. Keys live in Privy's HSM, not in our DB.
- Our server stores only `privyWalletId` + `address`.
- To move funds out, we must call `privy.walletApi.signTransaction(walletId, tx)` with our Privy **app secret**.

### Disaster scenarios

| Scenario | Recoverable? |
|---|---|
| VPS dies, disk intact → restore from backup | ✅ Yes |
| VPS + DB gone, Privy account + app secret intact | ✅ Yes (re-derive via Privy API) |
| Privy app secret lost | ❌ **Funds bricked** |
| Markus hit by a bus | ❌ Nobody else has credentials |
| Privy the company shuts down | ❌ Depends on their wind-down policy |

The landing page *used* to say "non-custodial" — softened on 2026-04-09 to "Privy-Secured Sub-Wallets" + flagged PDA escrow as roadmap.

---

## Decisions already made

- **Option 1 (DR hardening)** — partially shipped 2026-04-09:
  - ✅ `scripts/emergency-sweep.ts` — standalone sweep script, dry-run by default
  - ⬜ Nightly DB backup to 2 offsite locations (Backblaze B2 + user's Mac, encrypted)
  - ⬜ Privy credentials in 2 offline locations (password manager + paper backup)
  - ⬜ Static `recovery.bagsindex.fun` page on Vercel independent from main API
- **PK-paste in UI** — rejected. Trains users into phishing patterns, worse custody than today, one XSS = extinction, regulatory nightmare, UX inferior to Phantom/Backpack.
- **Full user-signed rebalance (Option 2)** — rejected. Every 4h push notification to sign a swap kills the auto-rebalance product.

---

## The plan to actually decide on: Option 3 — PDA escrow + pre-signed permits

### What it is

A small Anchor program where:

- Each user has one PDA per risk tier, derived from `["vault", user_pubkey, tier]`.
- Funds live in the PDA, not in a server wallet.
- User deposits by signing **one transaction** that (a) transfers SOL to the PDA and (b) approves a rebalance permit.
- The permit encodes: token whitelist, max slippage (5%), min interval between rebalances (4h/12h/24h by tier), max weight per token (25%).
- The keeper (our worker) triggers rebalances by calling a program instruction that does a CPI to Jupiter. The program **rejects** anything that violates the permit rules — even a compromised keeper cannot exceed what the user pre-approved.
- Withdraw is always a user-signed instruction. No server involvement.

### User flow (identical to today, from their POV)

1. Connect Phantom → "Deposit 1 SOL to Balanced tier"
2. **One** Phantom signature: deposit + approve rules
3. Auto-rebalance happens every 12h in background — no notifications, no signatures
4. "Withdraw" → one Phantom signature → funds return

### What we gain

- **Actually non-custodial.** We can put the word back on the landing page without lying.
- **No Privy dependency.** No app secret to lose, no vendor risk, no ToS changes.
- **No custody liability.** We operate a Solana program, like Jupiter/Kamino. Not a money transmitter.
- **Disaster recovery is free.** Server dies → users withdraw directly from the program with any Solana client. No sweep script, no runbook.
- **Composability.** Other dApps can integrate bags-index positions.
- **Audit-friendly.** Rebalance rules are Rust, not TypeScript on a server. Anyone can verify what the protocol can and can't do.

### What we pay

- **~3-6 weeks of Rust/Anchor work.** Program is ~800-1500 LOC; plus tests, devnet, migration.
- **~$15-40k audit** before meaningful mainnet TVL. OtterSec / Zellic / Neodyme.
- **Compute cost** for rebalances (~$0.0001-0.001/rebalance). Keeper pays. Fine at our scale.
- **Less flexibility.** Changing rebalance logic requires program upgrade (or new program + migration). Slower iteration. This is a feature for users.
- **One-time migration**: existing Privy sub-wallet users → new PDAs. Users connect Phantom, sign one "migrate" tx, funds move. Chunk of work but straightforward.

### What stays the same

**Literally everything except custody.** Scoring engine, AI analysis, tweet bot, admin dashboard, PnL tracking, burn worker, frontend, fees — all unchanged. The program replaces *only* the "where funds live + who signs rebalances" layer.

### The honest caveat

"Rules in the program" has a spectrum:

**Loose rules (v1, what we'd ship):**
> Keeper can call `rebalance` ≤1× per tier interval. Swaps only via Jupiter CPI. Slippage ≤5%. Output must be in the `top_n` whitelist account, which the keeper updates from scoring.

With loose rules, we (the keeper) still control scoring → whitelist → we could theoretically add a rug to the whitelist and rebalance into it. **Not custody, but "operator trust".** Can't steal, but can misbehave in bounded ways.

**Tight rules (v3, eventual endgame):**
> Whitelist updates require 48h timelock + multisig + on-chain proof that scoring inputs match public data feeds (Switchboard / Pyth / zkTLS).

For v1, **loose rules are the right call** — shippable, massive improvement over today, can tighten later. Same trust model as Yearn, Beefy, every yield aggregator.

---

## Alternative considered but not chosen

### Option 4 — fully trustless from day 1

Same program but with tight rules immediately: on-chain oracles for scoring, committee-based whitelist updates, timelock on all governance, etc.

**Why not:** 3-6 months instead of 3-6 weeks. We don't have the user count to justify it yet. Ship loose, earn trust, tighten as TVL grows.

---

## Open questions to resolve before committing

1. **Upgrade authority** — do we keep the program upgradeable initially (faster fixes, less trustless) or ship with `--final` (more trustless, no fixes)? Consensus in Solana land: upgradeable for first 6 months, then freeze or move to multisig.
2. **Fee routing** — where do deposit/withdraw/switch fees go? Probably a fixed `FEE_VAULT` address in the program, non-upgradable, our hot wallet. Easy.
3. **Platform token buy-and-burn** — currently the burn worker buys $BAGSX and burns it. Does that stay off-chain (keeper pulls fees out of the fee vault) or does the program handle it directly? Off-chain is simpler and has no downside.
4. **Switching tiers** — currently `/portfolio/switch` is a fast-path that avoids withdraw+deposit fees. In the PDA world, switching means moving funds from one PDA to another. Still doable, needs a dedicated `switch_tier` instruction.
5. **Keeper identity** — single hardcoded pubkey (simple, SPOF), or a set of keepers (resilient, more complex)? Probably start with one, add set later.
6. **Partial withdrawals** — can users withdraw X% of their position without closing the PDA? Should be easy, just an amount parameter.
7. **Rebalance frequency enforcement** — store `last_rebalance_slot` in the PDA and check `current_slot - last_rebalance_slot >= min_slots_per_tier`. Standard pattern.
8. **Slippage check location** — on-chain (program rejects if output < min_out) vs off-chain (keeper builds tx with min_out already baked in). On-chain is stronger and cheap.

---

## Reference implementations to study before writing code

- **Jupiter DCA** — open source. User-approved keeper-executed swaps on a schedule. Closest conceptual match to our rebalance. Repo: `github.com/jup-ag/dca-sdk` + their program source.
- **Kamino Vaults** — on-chain vault program with off-chain keeper, Jupiter CPI for swaps, user withdraws directly. Very similar architecture.
- **Drift Vaults** — similar, with delegate authorities and permit-like patterns.
- **Sanctum Infinity** — PDA-per-user, on-chain whitelist, keeper rebalances. Good reference for tight-rules version later.

---

## Phased rollout (if we commit)

**Phase 0 — spec & research (1 week)**
- Read Jupiter DCA, Kamino Vaults, Drift Vaults program source
- Write full Anchor program spec: accounts, instructions, PDAs, seeds, errors
- Decide open questions above
- Architecture doc reviewed & approved before any code

**Phase 1 — program MVP on devnet (2 weeks)**
- `anchor init` scaffold
- Instructions: `initialize_tier_vault`, `deposit`, `withdraw`, `rebalance`, `switch_tier`
- Jupiter CPI integration
- Unit tests + integration tests on devnet
- TypeScript client generated from IDL

**Phase 2 — worker migration (1 week)**
- Replace `rebalance.worker.ts` Privy calls with program client calls
- Keeper identity setup
- Dry-run against devnet with test wallets

**Phase 3 — frontend migration (1 week)**
- Deposit/withdraw flows call program instructions via wallet adapter
- Remove Privy server wallet code from deposit path
- Migration modal for existing users ("move your funds to the new vault program")

**Phase 4 — mainnet soft launch (1 week + audit)**
- Deploy program to mainnet with small TVL cap (e.g. 10 SOL total)
- Audit before removing the cap
- Gradually raise cap as audit findings clear

**Phase 5 — sunset Privy sub-wallets (ongoing)**
- Old Privy wallets remain functional for migration
- Once all active users migrated, deprecate the Privy code path
- Delete Privy credentials from the ops runbook

**Total realistic timeline:** 5-6 weeks engineering + 2-4 weeks audit before opening the TVL cap. Can launch on devnet / small mainnet limits without waiting for audit.

---

## Decision log

- **2026-04-09** — Plan drafted. Markus wants to think about it. No commitment yet.
- [ ] Decision needed: commit to Option 3 after hackathon? Or stay on Privy + Option 1 hardening indefinitely?
- [ ] If committing: budget approved for audit? (~$15-40k)
- [ ] If committing: hire a Solana/Anchor dev, or Markus writes it himself?

---

## Next action when we resume

1. Re-read this doc
2. Decide: commit / defer / reject
3. If commit → kick off Phase 0: I'll read the Jupiter DCA and Kamino Vaults source and come back with a concrete architecture doc (accounts, instructions, PDA seeds, error codes) before any code gets written

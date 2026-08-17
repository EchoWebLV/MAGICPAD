# MagicPad MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devnet MVP of MagicPad — a bonding-curve launchpad where the whole trading phase runs gasless inside a MagicBlock Ephemeral Rollup (dark bonding), with 1 SOL launch fee, zero trading fees, rakeback on realized losses, and graduation that reconciles to L1 (Meteora migration via script, best-effort on devnet).

**Architecture:** Clone the proven BullStakeHouse money rails: escrow on L1 → ledger-only mutations in the ER → reconcile home on undelegation. A `Launch` PDA is the curve + pot (like `Round`); a per-(launch, wallet) `TradeSession` PDA is the escrow + position ledger (like `BetSession`); trades are session-key-signed ER instructions with zero lamport movement inside the rollup. Tokens are ledger claims until graduation; the SPL mint exists from creation but mints only at L1 claim time. Keeper is a janitor/crank, not a market maker.

**Tech Stack:** Anchor (toolchain 0.31.1), `anchor-lang =1.0.2`, `anchor-spl =1.0.2`, `ephemeral-rollups-sdk =0.14.3` (anchor feature) — the exact BullStakeHouse-proven graph, minus VRF (curve is deterministic). Standalone LiteSVM test crate (same split, same reason). Next.js web terminal + node scripts (keeper, demo trader). Devnet + `devnet-router.magicblock.app`.

---

## Locked decisions (from spec + working session 2026-08-17/18)

| Decision | Choice | Why |
|---|---|---|
| Escrow model | Per-(launch, wallet) `TradeSession`, deposit at open | Exact `BetSession` shape, proven; global balance is v2 |
| Tokens during bonding | Ledger claims in session (`tokens_held`), no SPL in ER | Mint authority never leaves L1; no token CPIs in rollup |
| Mint | Created at `create_launch` (decimals 6, authority = platform PDA), minted only on L1 claims | Dark bonding; supply appears at graduation |
| Curve | Constant-product with virtual reserves (pump-style), u128 intermediates | Standard, deterministic, no oracle |
| Anti-snipe | First-window per-session buy cap, enforced in ER `buy` | Program-enforced; invisibility handles the toolchain |
| Rakeback | `realized_loss` accumulates on sells (avg-cost basis); L1 claim pays bps from segregated pool PDA | Unfarmable (bots can't profit by losing); pool-capped |
| Graduation | Crossing buy freezes curve in ER → commit/undelegate → per-session reconcile on L1 → claims | Same commit/reconcile flow as stakehouse rounds |
| Meteora | `scripts/migrate.mjs` via SDK, best-effort on devnet; NOT in-program CPI for MVP | Devnet Meteora availability unverified; don't block MVP |
| Same-ER constraint | One `ER_VALIDATOR` env; launch + its sessions delegated to the same node | `buy` touches launch + session atomically (stakehouse lesson) |
| Wallet (web) | localStorage burner + devnet airdrop button | Fastest demoable path; adapter/Privy is v2 |
| Fees | Launch fee 1 SOL → platform PDA. Zero trading fees. | The whole pitch |

Reference sources (read before implementing, do not import from):
- `~/Documents/GitHub/BullStakeHouse/programs/stakehouse/src/instructions/session.rs` (escrow/ledger/reconcile shape)
- `~/Documents/GitHub/BullStakeHouse/programs/stakehouse/src/instructions/delegation.rs` (`#[delegate]` / `#[commit]` usage)
- `~/Documents/GitHub/BullStakeHouse/litesvm-tests/` (test harness shape)
- `~/Documents/GitHub/BullStakeHouse/scripts/keeper.mjs` + `session-bettor.mjs` (ER discovery, crank patterns)
- `~/Documents/GitHub/BullStakeHouse/apps/web/lib/live-bets.ts` (session keys, ER connection, smart routing)

## File structure

```
magicpad/
  Anchor.toml                      # toolchain 0.31.1, cluster devnet
  Cargo.toml                       # workspace = programs/magicpad
  package.json                     # scripts workspace deps (@solana/web3.js, @coral-xyz/anchor)
  programs/magicpad/
    Cargo.toml                     # the =1.0.2 / =0.14.3 pinned graph, NO dev-deps
    src/
      lib.rs                       # entrypoints only, #[ephemeral]
      constants.rs                 # seeds, curve defaults, windows
      error.rs                     # append-only error enum
      state.rs                     # Platform, Launch, TradeSession
      curve.rs                     # pure math: buy_quote, sell_quote (unit-testable)
      instructions/
        mod.rs                     # flat pub mod + pub use (stakehouse convention)
        admin.rs                   # init_platform, fund_rakeback
        launch.rs                  # create_launch (pays fee, creates mint), delegate_launch
        session.rs                 # open_trade_session (+deposit), delegate_trade_session
        trade.rs                   # buy, sell (ER, ledger-only)
        graduate.rs                # commit_launch, commit_trade_sessions (ER→L1)
        reconcile.rs               # reconcile_trade_session, claim_tokens, claim_rakeback, claim_launch_proceeds
  litesvm-tests/                   # standalone crate (NOT a workspace member)
    Cargo.toml
    tests/rail.rs                  # full lifecycle on L1 (no delegation transport, like stakehouse)
    tests/common/mod.rs
  scripts/
    keeper.mjs                     # watch FROZEN launches → commit → reconcile (janitor only)
    demo-trader.mjs                # e2e prover: launch → session → ER buys/sells → graduate → claim
    migrate.mjs                    # Meteora pool creation post-graduation (best-effort devnet)
  apps/web/                        # Next.js terminal (Phase 4)
    app/page.tsx                   # three columns: New / Final Stretch / Migrated
    app/launch/[id]/page.tsx       # trade panel
    app/create/page.tsx            # 1 SOL launch form
    lib/magicpad.ts                # PDAs, fetchLaunches, tx builders (read side)
    lib/trade-live.ts              # session keys, ER discovery, buy/sell send (live-bets.ts shape)
    lib/burner.ts                  # localStorage burner signer + airdrop
  docs/spec-negative-fee-launchpad.md
```

## Program constants (constants.rs — exact values)

```rust
pub const PLATFORM_SEED: &[u8] = b"platform";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const SESSION_SEED: &[u8] = b"tsession";
pub const RAKEBACK_SEED: &[u8] = b"rakeback";

pub const LAUNCH_FEE_LAMPORTS: u64 = 1_000_000_000;        // 1 SOL, the pitch
pub const TOKEN_DECIMALS: u8 = 6;
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1B tokens * 1e6
pub const CURVE_TOKEN_ALLOC: u64 = 793_100_000_000_000;    // 79.31% sellable on curve (pump-style)
pub const VIRTUAL_SOL_INIT: u64 = 30_000_000_000;          // 30 SOL virtual
pub const VIRTUAL_TOK_INIT: u64 = 1_073_000_000_000_000;   // 1.073e15 (pump-style)
pub const GRADUATION_LAMPORTS: u64 = 5_000_000_000;        // 5 SOL on devnet MVP (mainnet: ~85)
pub const FIRST_WINDOW_SECS: i64 = 60;
pub const FIRST_WINDOW_MAX_BUY: u64 = 500_000_000;         // 0.5 SOL per session in window
pub const RAKEBACK_BPS: u16 = 1_000;                       // 10% of realized losses
pub const MIN_DEPOSIT: u64 = 10_000_000;                   // 0.01 SOL
```

## State (state.rs — exact structs)

```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    pub launch_seq: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    pub created_ts: i64,
    pub first_window_end_ts: i64,
    pub state: u8,            // 0 BONDING, 1 FROZEN, 2 RECONCILED, 3 GRADUATED
    pub virtual_sol: u64,     // virtual reserve, starts VIRTUAL_SOL_INIT
    pub virtual_tok: u64,     // virtual reserve, starts VIRTUAL_TOK_INIT
    pub real_sol_raised: u64, // net ledger SOL into curve (graduation gauge)
    pub tokens_sold: u64,     // net ledger tokens out (claims outstanding)
    pub sessions_reconciled: u64,
    pub sessions_opened: u64,
    pub bump: u8,
}
pub const LAUNCH_BONDING: u8 = 0;
pub const LAUNCH_FROZEN: u8 = 1;
pub const LAUNCH_RECONCILED: u8 = 2;
pub const LAUNCH_GRADUATED: u8 = 3;

#[account]
#[derive(InitSpace)]
pub struct TradeSession {
    pub launch_id: u64,
    pub trader: Pubkey,       // the real wallet, payout target — pinned at open
    pub session_key: Pubkey,  // throwaway ER signer
    pub deposit: u64,         // lamports escrowed in this PDA on L1
    pub sol_spent: u64,       // ledger: gross SOL into curve (invariant: net <= deposit)
    pub sol_proceeds: u64,    // ledger: gross SOL back from sells
    pub tokens_held: u64,     // ledger claim, becomes SPL at claim_tokens
    pub cost_basis: u64,      // lamports basis of tokens_held (avg cost)
    pub realized_loss: u64,   // lamports, accumulates on losing sells → rakeback
    pub reconciled: bool,
    pub tokens_claimed: bool,
    pub rakeback_claimed: bool,
    pub bump: u8,
}
```

**Invariants (enforce in code, assert in tests):**
- ER `buy`: `sol_spent - sol_proceeds + amount_in <= deposit` (net exposure never exceeds escrow — the BetSession invariant generalized for sells).
- ER `sell`: `tokens_out <= tokens_held`.
- `reconcile_trade_session`: net = `sol_spent - sol_proceeds`; move `net` session→launch, `deposit - net` session→trader. Anchor `Account<'info, TradeSession>` owner check IS the undelegation gate (stakehouse trick — a still-delegated session cannot pass).
- Sum over sessions of net == `launch.real_sol_raised` (conservation; assert in LiteSVM test).

## Curve math (curve.rs — exact, pure, no accounts)

```rust
/// Constant-product bonding curve with virtual reserves, pump-style.
/// All intermediates u128. Rounds AGAINST the trader (house never leaks).
pub fn buy_quote(virtual_sol: u64, virtual_tok: u64, sol_in: u64) -> Option<u64> {
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let s = sol_in as u128;
    let k = vs.checked_mul(vt)?;
    let new_vs = vs.checked_add(s)?;
    let new_vt = k.checked_div(new_vs)?.checked_add(1)?; // ceil → fewer tokens out
    let out = vt.checked_sub(new_vt)?;
    u64::try_from(out).ok()
}

pub fn sell_quote(virtual_sol: u64, virtual_tok: u64, tok_in: u64) -> Option<u64> {
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let t = tok_in as u128;
    let k = vs.checked_mul(vt)?;
    let new_vt = vt.checked_add(t)?;
    let new_vs = k.checked_div(new_vt)?.checked_add(1)?; // ceil → fewer lamports out
    let out = vs.checked_sub(new_vs)?;
    u64::try_from(out).ok()
}
```

Unit tests live in `curve.rs` `#[cfg(test)]` (pure math — this is the ONE place in-crate tests are fine; no litesvm/solana deps needed):
- round-trip loses to rounding: `sell_quote(after buy) <= sol_in`
- monotonic: bigger `sol_in` → bigger out; zero in → zero out
- no overflow at extremes (`u64::MAX` guards return None)

---

## Phase 1 — Program skeleton + curve (Tasks 1–3)

### Task 1: Scaffold workspace

**Files:** Create `Anchor.toml`, root `Cargo.toml`, `programs/magicpad/Cargo.toml`, `.gitignore`, empty module tree from File structure.

- [ ] Copy the pinned dep block from `~/Documents/GitHub/BullStakeHouse/programs/stakehouse/Cargo.toml`, drop `ephemeral-vrf-sdk`, rename package `magicpad`.
- [ ] `Anchor.toml`: toolchain 0.31.1, cluster devnet, wallet `~/.config/solana/id.json`, `test = "cd litesvm-tests && cargo test"`.
- [ ] `anchor keys sync` after first build generates the program id; commit it.
- [ ] `.gitignore`: `target/`, `node_modules/`, `.env`, `**/.DS_Store`, `test-ledger/`, `.anchor/`, `*-keypair.json` EXCEPT `target/deploy/` handled by anchor default.
- [ ] Run: `cd ~/Documents/GitHub/magicpad && anchor build` → compiles empty program.
- [ ] Commit: `chore: anchor workspace, pinned ER dep graph (stakehouse-proven)`

### Task 2: curve.rs with unit tests (TDD — the only pure-math file)

- [ ] Write `curve.rs` tests first (cases above), `cargo test -p magicpad` → fails.
- [ ] Implement `buy_quote`/`sell_quote` exactly as specified. Tests pass.
- [ ] Commit: `feat: bonding curve math, trader-adverse rounding, overflow-safe`

### Task 3: state.rs, constants.rs, error.rs

- [ ] Exact structs/constants from this plan. Errors (append-only, stakehouse rule):

```rust
#[error_code]
pub enum MagicPadError {
    LaunchNotBonding,       // 6000
    LaunchNotFrozen,        // 6001
    DepositTooSmall,        // 6002
    ExceedsDeposit,         // 6003
    InsufficientTokens,     // 6004
    FirstWindowCap,         // 6005
    NotGraduatable,         // 6006
    AlreadyReconciled,      // 6007
    NotReconciled,          // 6008
    AlreadyClaimed,         // 6009
    SessionKeyMismatch,     // 6010
    BadQuote,               // 6011
    NothingToClaim,         // 6012
}
```

- [ ] `anchor build` clean. Commit: `feat: state + constants + errors`

## Phase 2 — Instructions (Tasks 4–9)

### Task 4: admin.rs — `init_platform`, `fund_rakeback`

- [ ] `init_platform`: init Platform PDA (payer = admin). `fund_rakeback`: permissionless `system_program::transfer` into `[RAKEBACK_SEED]` PDA (a bare system PDA holding lamports; create with `init_if_needed` zero-data account owned by program, space 8).
- [ ] `create_launch` fee destination is the Platform PDA itself (lamports on the account, rent-floor-guarded withdrawals later — stakehouse pot pattern).

### Task 5: launch.rs — `create_launch`, `delegate_launch`

- [ ] `create_launch(name, symbol)`: transfer `LAUNCH_FEE_LAMPORTS` payer→platform; init Launch PDA `[LAUNCH_SEED, seq_le]` with curve defaults, `first_window_end_ts = now + FIRST_WINDOW_SECS`; init SPL mint (anchor-spl, decimals 6, `mint::authority = platform`) in the same ix; `launch_seq += 1`.
- [ ] `delegate_launch(id)`: `#[delegate]` + `del` UncheckedAccount, validator = `remaining_accounts.first()` — copy delegation.rs shape verbatim. Creator-or-admin gated.
- [ ] LiteSVM later asserts: fee moved, seq bumped, mint authority = platform PDA.

### Task 6: session.rs — `open_trade_session`, `delegate_trade_session`

- [ ] `open_trade_session(launch_id, session_key, deposit)`: seeds `[SESSION_SEED, launch_id_le, payer]` (payer-bound, un-hijackable); require `deposit >= MIN_DEPOSIT`, launch BONDING (hand-deserialize launch as UncheckedAccount — it may already be delegated/DLP-owned, stakehouse `session.rs:79-87` trick); escrow deposit payer→session PDA.
- [ ] `delegate_trade_session(launch_id)`: same `#[delegate]` shape, payer-gated by seeds, same validator.
- [ ] Web/scripts bundle both in ONE tx (one approval).

### Task 7: trade.rs — `buy`, `sell` (ER, the heart)

```rust
// buy(amount_in): signer = session.session_key (throwaway), ledger-only
require!(launch.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
require_keys_eq!(session.session_key, signer.key(), MagicPadError::SessionKeyMismatch);
let net = session.sol_spent - session.sol_proceeds; // both start 0, spent >= proceeds enforced by construction
require!(net + amount_in <= session.deposit, MagicPadError::ExceedsDeposit);
let now = Clock::get()?.unix_timestamp;
if now < launch.first_window_end_ts {
    require!(session.sol_spent + amount_in <= FIRST_WINDOW_MAX_BUY, MagicPadError::FirstWindowCap);
}
let out = curve::buy_quote(launch.virtual_sol, launch.virtual_tok, amount_in).ok_or(BadQuote)?;
require!(launch.tokens_sold + out <= CURVE_TOKEN_ALLOC, MagicPadError::BadQuote);
launch.virtual_sol += amount_in; launch.virtual_tok -= out;
launch.real_sol_raised += amount_in; launch.tokens_sold += out;
session.sol_spent += amount_in; session.tokens_held += out; session.cost_basis += amount_in;
if launch.real_sol_raised >= GRADUATION_LAMPORTS { launch.state = LAUNCH_FROZEN; } // crossing buy freezes
```

```rust
// sell(tokens_in): avg-cost realized PnL → rakeback ledger
require!(launch.state == LAUNCH_BONDING, ...); // no sells after freeze
require!(tokens_in <= session.tokens_held, InsufficientTokens);
let out = curve::sell_quote(launch.virtual_sol, launch.virtual_tok, tokens_in)?;
// avg-cost slice of basis for the sold portion (u128 mul/div):
let basis_slice = (session.cost_basis as u128 * tokens_in as u128 / session.tokens_held as u128) as u64;
if out < basis_slice { session.realized_loss += basis_slice - out; }
launch.virtual_sol -= out; launch.virtual_tok += tokens_in;
launch.real_sol_raised -= out; launch.tokens_sold -= tokens_in;
session.sol_proceeds += out; session.tokens_held -= tokens_in; session.cost_basis -= basis_slice;
```

- [ ] Note: `real_sol_raised -= out` keeps the pot honest — sells drain the curve, so reconcile conservation holds.
- [ ] Commit after LiteSVM lifecycle test passes (Task 10).

### Task 8: graduate.rs — `commit_launch`, `commit_trade_sessions`

- [ ] `commit_launch(id)`: require FROZEN; `#[commit]` + `commit_and_undelegate_accounts` (raider's lightweight free-function form — smaller .so). Permissionless.
- [ ] `commit_trade_sessions(launch_id)`: remaining_accounts batch of session PDAs, batches of 8 (stakehouse `commit_bet_sessions` shape). Permissionless.

### Task 9: reconcile.rs — the L1 landing

- [ ] `reconcile_trade_session`: NO signer field (fully permissionless, stakehouse shape). `Account<'info, TradeSession>` typed = undelegation gate. Compute `net = sol_spent - sol_proceeds`; lamport-borrow: session→launch `net`, session→trader `deposit - net` (rent floor stays until close). Set `reconciled`, bump `launch.sessions_reconciled`; when `sessions_reconciled == sessions_opened` and launch FROZEN → `LAUNCH_RECONCILED`.
- [ ] `claim_tokens`: require session.reconciled && !tokens_claimed; `mint_to` (platform PDA signs) `tokens_held` to trader ATA (`init_if_needed` ATA, payer = cranker); mark claimed. Recipient pinned `#[account(address = session.trader)]` — stranger-crank-safe (bull_machine rule).
- [ ] `claim_rakeback`: require reconciled && !rakeback_claimed && realized_loss > 0; pay `min(realized_loss * RAKEBACK_BPS / 10_000, rakeback_pool_balance - rent_floor)` pool→trader; mark claimed.
- [ ] `claim_launch_proceeds`: creator-only after RECONCILED — MVP: proceeds stay in launch PDA awaiting `migrate.mjs`; this ix only marks GRADUATED after migration signature (admin-gated for MVP; on-chain Meteora CPI is v2).

## Phase 3 — Tests + devnet e2e (Tasks 10–12)

### Task 10: LiteSVM lifecycle suite (`litesvm-tests/tests/rail.rs`)

Copy the harness shape from `~/Documents/GitHub/BullStakeHouse/litesvm-tests/` (standalone crate, loads `target/deploy/magicpad.so`). Cases, in order, one test fn each:
- [ ] `create_launch_takes_fee_and_makes_mint` — platform lamports +1 SOL, seq bumped, mint decimals 6, authority = platform.
- [ ] `full_lifecycle_two_traders` — open 2 sessions (deposits 3 SOL + 3 SOL) → buys cross graduation (state FROZEN on crossing buy) → reconcile both → conservation: `launch lamports gained == Σ net == real_sol_raised`; refunds correct; `claim_tokens` mints exactly `tokens_held`.
- [ ] `sell_realizes_loss_and_rakeback_pays` — buy high, second trader buys, first sells into own slippage → `realized_loss > 0`; after reconcile, `claim_rakeback` pays `loss * 10%` from funded pool; double-claim fails `AlreadyClaimed`.
- [ ] `first_window_cap_enforced` — buy over 0.5 SOL inside window → `FirstWindowCap`; warp clock past window → succeeds.
- [ ] `exceeds_deposit_rejected` + `stranger_cannot_hijack_session` (wrong session_key signer → `SessionKeyMismatch`; reconcile pays only `session.trader`).
- [ ] `no_trades_after_freeze` — buy/sell on FROZEN launch → `LaunchNotBonding`.
- [ ] Run: `cd litesvm-tests && cargo test` → all green. Commit: `test: full rail lifecycle green in litesvm`

### Task 11: devnet deploy + demo-trader e2e

- [ ] `solana balance` → airdrop if < 4 SOL (`solana airdrop 2`, repeat; devnet faucet limits apply).
- [ ] `anchor build && anchor deploy` → record program id in Anchor.toml + README.
- [ ] `scripts/demo-trader.mjs` (session-bettor.mjs shape): `init` (platform) → `launch NAME SYM` → `delegate` → `trade` (open session ONE L1 tx incl. delegate; N buys + sells straight at ER endpoint from `devnet-router.magicblock.app` discovery, session-key fee payer = gasless) → `graduate` (buy over threshold) → `settle` (commit launch+sessions, wait undelegation, reconcile, claim tokens + rakeback) → print full lamport math table.
- [ ] Acceptance = the printed conservation table balances to the lamport, and the trader wallet holds real SPL tokens at the end. Commit + push.

### Task 12: keeper.mjs (janitor only)

- [ ] Poll launches; on FROZEN: commit launch + session batches, wait undelegation (≤90s, stakehouse timing), reconcile all sessions, crank `claim_tokens` for reconciled sessions. Retry ×3, `ER_VALIDATOR`/`RPC_URL` env, no market-making, no seeding. Commit.

## Phase 4 — Web terminal (Tasks 13–15, after e2e proof)

- [ ] Task 13 `lib/`: `magicpad.ts` (PDAs, `fetchLaunches` via one `getProgramAccounts` memcmp on Launch discriminator, 2.5s memo — stakehouse RPC frugality rules), `burner.ts` (localStorage keypair + airdrop button), `trade-live.ts` (per-launch session key localStorage, `ensureEr` router discovery, `openAndDelegate` one-tx, `buyLive`/`sellLive` session-key-signed at ER, `ensureTradeSession` auto-open).
- [ ] Task 14 pages: home = three columns New (BONDING, age < 1h) / Final Stretch (BONDING, `real_sol_raised >= 60%` of graduation) / Migrated (FROZEN+), 4s poll, dark Axiom-ish density (row: name, symbol, MC from spot price × supply, raised bar, age); `create/` form (1 SOL, name+symbol); `launch/[id]` = position, deposit-and-trade panel, trades implied from launch deltas (MVP: poll snapshot, no event feed).
- [ ] Task 15: `pnpm build` clean; screenshot-verified via dev server; README quickstart (launch → trade → graduate in 3 commands). Final commit + push.

## Self-review notes

- Spec coverage: 1 SOL fee ✓ (T5), zero trading fees ✓ (no fee lines in trade.rs), rakeback-on-losses ✓ (T7 sell + T9 claim, segregated pool ✓ T4), dark bonding ✓ (ledger-only ER, no mint until claims), unsnipable layers ✓ (first-window cap T7; invisibility is architectural), graduation → Meteora: script-level MVP, honestly scoped ✓, curation gate: OUT of MVP (open question in spec) ✓, platform-token fee feed: replaced by `fund_rakeback` stand-in for MVP ✓.
- Conservation invariant is the load-bearing test (T10) — it's what made stakehouse's rail trustworthy.
- Type consistency pass done: seeds/fields/errors referenced in tasks match state.rs/constants.rs/error.rs definitions above.

# Pump.fun migration mode — design

**Date:** 2026-09-09 · **Branch:** `pump-migration` · **Status:** approved for planning

## Goal

A per-launch option where a Mooner dark-bonding market graduates at **1 SOL** and
migrates to **pump.fun** instead of Meteora, such that the resulting holder map
(Bubblemaps / Solscan) shows N unrelated buyers with **zero transfer edges and no
deployer or keeper hub** — every holder's tokens arrive via a pump.fun `buy`
signed by a unique PDA, never via a transfer or airdrop.

## Hard facts this design rests on (verified 2026-09-09 against the live pump IDL)

- pump.fun program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. `create` takes
  `mint` as a **signer** → a fresh keypair per token. Pump cannot adopt an existing
  mint; the Mooner PDA mint stays at supply 0 forever in this mode.
- `create(name, symbol, uri, creator)`; `creator` earns pump creator fees and owns
  `creator_vault`. Decision: `creator = launch.creator` (the Mooner deployer).
- `buy(amount, max_sol_cost, track_volume)`; `user` is a **writable signer that pays
  SOL** (system transfer) and rent for `user_volume_accumulator`
  (`["user_volume_accumulator", user]`). Errors `BuyNotEnoughSolToCoverRent` /
  `BuyNotEnoughSolToCoverFees` exist → `user` must be a **system-owned** account.
- **`buy` takes 18 accounts** (verified byte-for-byte against `@pump-fun/pump-sdk@1.36.0`
  and a mainnet `simulateTransaction`, `err: null`): `global`(ro), `fee_recipient`(W),
  `mint`(ro), `bonding_curve`(W), `associated_bonding_curve`(W), `associated_user`(W),
  `user`(W,S), system program, token program (`Tokenkeg…`), `creator_vault`(W)
  (`["creator-vault", creator]`), `__event_authority`(ro)
  `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1`, pump program(ro),
  `global_volume_accumulator`(ro) `Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y`,
  `user_volume_accumulator`(W), `fee_config`(ro)
  `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`, fee program(ro), then two
  *remaining* accounts the IDL does not list: `bonding_curve_v2`(ro)
  (`["bonding-curve-v2", mint]` under pump — uninitialised for a v1 coin) and
  `buyback_fee_recipient`(W), one of eight fixed addresses hard-coded in the SDK.
  Omit either → error 6062 `BuybackFeeRecipientMissing`. Data = discriminator
  `[102,6,61,18,1,218,235,234]` ‖ `amount: u64 LE` ‖ `max_sol_cost: u64 LE` ‖ `0x01`
  (`track_volume`: the IDL's `OptionBool` is a one-byte newtype, not a two-byte
  `Option<bool>`; 25 bytes total). `buy` CPIs the fee program
  (`GetFees`), so a local SVM needs **both** ELFs.
- **`associated_user` may be owned by a wallet other than `user`** (mainnet sim
  `err: null`): the PDA vault pays, the tokens land straight in the trader's own
  canonical ATA. No `SetAuthority` hand-off is needed.
- `close_user_volume_accumulator` (discriminator `[249,69,164,218,150,103,84,138]`,
  accounts `user`(W,S), `user_volume_accumulator`(W), `__event_authority`, pump program)
  succeeds in the same transaction right after `buy` and returns the accumulator's
  rent to `user`.
- Live `fee_config` (`["fee_config", pump_program]` under
  `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`): one tier, **125 bps**
  (95 protocol + 30 creator). `Global.creatorFeeBasisPoints = 5` is superseded.
- Mainnet rent is **6,333 lamports × (128 + data_len)** (measured; not litesvm's
  default): trader ATA (165 B) 1,855,569 — permanent, paid per holder;
  `user_volume_accumulator` (137 B) 1,678,245 — fronted, recovered by the close;
  `creator_vault` (0 B) 810,624 — pump tops it up out of the first buy for that
  creator. The program reads `Rent::get()`; nothing is hard-coded.
- v1 `create` (14 accounts, classic Token program) costs 19,389,173 lamports of
  rent + fees and ≈104k CU on mainnet; `create_v2` mints Token-2022 with
  `ImmutableOwner` ATAs and is **not** used. Compute, measured against the real
  mainnet ELF (`litesvm-tests/tests/pump.rs`, `compute_units_consumed`): a funded
  `pump_claim` runs **139,997–168,497 CU** over 20 runs (mean 148,247 — the
  spread is `find_program_address` bump-search depth at 1,500 CU per failed step,
  every sample congruent to 497 mod 1,500), `pump_graduate` **145,861**, a flat
  claim **27,310** → every CLI transaction sets a 400k CU limit, **2.37×** the
  observed worst case.
- Pump curve constants == Mooner's: virtual 30 SOL / 1.073e15, real 793.1T, supply
  1e15, 6 decimals. Constant-product ⇒ SOL raised determines tokens sold
  (path-independent), so replaying Mooner's final ledger onto a fresh pump curve
  costs exactly `real_sol_raised` pre-fee, in any order.
- At 1 SOL the Mooner curve has sold 34,612,903,225,806 raw (34.6M tokens, 3.46% of
  supply). End-to-end price move across the whole replay is 3.3%.

## Non-goals

- No change to standard (Meteora) launches or the 85 SOL threshold. `keeper.mjs`
  keeps committing/absorbing/reconciling pump launches and only skips their
  claim/graduate/migrate steps; `migrate.mjs` skips them.
- No browser-side self-crank of pump claims (CLI cranks; the web shows status).
- No creator dev-buy on pump; the Mooner creator first-buy rule is unchanged.

## Program changes (`programs/magicpad`)

### State — new PDA, `Launch` layout untouched

```rust
// seeds = ["pump", launch_id.to_le_bytes()]
pub struct PumpLaunch {
    pub launch_id: u64,
    pub pump_mint: Pubkey,   // Pubkey::default() until set_pump_mint
    pub claims_done: u64,    // traded sessions whose pump_claim landed
    pub bump: u8,
}
```

Existence of this PDA == pump mode. No field is added to `Launch` or
`TradeSession` (all 4 mainnet launches keep decoding; no realloc).

Per-holder vault: `["pumpvault", launch_id, trader]` — **system-owned, no data**,
never `init`ed; the program signs for it with `invoke_signed`. Launch-level vault
for the flip pot: `["pumpvault", launch_id]`.

### Constants

```rust
pub const PUMP_SEED: &[u8] = b"pump";
pub const PUMP_VAULT_SEED: &[u8] = b"pumpvault";
pub const PUMP_GRADUATION_LAMPORTS: u64 = 1_000_000_000; // 1 SOL
pub const PUMP_HAIRCUT_BPS: u16 = 150; // covers pump's 125 bps trade fee + rounding
pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_FEE_PROGRAM: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
```

### Instructions

| ix | lane | signer | effect |
|---|---|---|---|
| `enable_pump(launch_id)` | L1 | `launch.creator` | `init` PumpLaunch. Requires `launch.state == BONDING`, `real_sol_raised == 0`. Must be bundled in the create tx **before** `delegate_launch` (after delegation the Launch is DLP-owned and cannot pass `Account<Launch>`). |
| `buy` (existing) | ER | session key | Gains `pump: Option<Account<PumpLaunch>>`. Threshold = `PUMP_GRADUATION_LAMPORTS` when `Some`, else `GRADUATION_LAMPORTS`. Nothing else changes. The ER clones the non-delegated PDA read-only (Platform precedent in `freeze_launch`). |
| `set_pump_mint(mint)` | L1 | admin | Once. Requires `launch.state ∈ {FROZEN, RECONCILED}`, `pump_mint == default`, and pump `bonding_curve` (`["bonding-curve", mint]` under pump) deserialises with `creator == launch.creator` and `complete == false`. Stores `pump_mint`. |
| `pump_claim(amount, max_sol_cost)` | L1 | admin (keeper CLI) | Replaces `claim_tokens` for pump launches. Not a permissionless crank: caller-chosen `amount` means a stranger could shortchange a holder — one token into the ATA marks `tokens_claimed` and the real share is gone — and `max_sol_cost` is bounded only by the whole pot, so no self-service path exists either: the holder cranking herself could overpay the curve out of everyone's pot. See flow below. |
| `pump_graduate(amount, max_sol_cost)` | L1 | admin | Requires every traded session claimed or bookkept (`claims_done == sessions_opened`, `sessions_reconciled == sessions_opened`, `state ∈ {FROZEN, RECONCILED}`). `amount > 0`: flip pot + pot dust → launch vault → pump `buy` into the vault's own ATA → `burn` → close the ATA → close the accumulator → vault residue back to the launch. `amount == 0`: no buy (the CLI passes 0 when the pot is under the 0.01 SOL floor — rent would eat it), and `max_sol_cost` must then be 0 too (`BadQuote`). The burn is of whatever the vault's ATA **holds**, never of `amount` — see the flow below. Either way the launch is then swept to rent-minimum with the remainder to the platform PDA, the Mooner mint authority is revoked (supply is 0), `state = GRADUATED`. |

`claim_tokens` and `graduate` (the two instructions that mint the Mooner
supply) gain a **required** `pump: UncheckedAccount` constrained to the
`["pump", launch_id]` address and `require!(pump.data_is_empty())` → error
`PumpMode`. An optional account would be no guard at all (omit it and the
Mooner mint gets minted on a pump launch). `lock_mint` needs no guard (supply
is 0, it fails on its own check); `record_pool` (admin-only, `init`-only,
requires GRADUATED) carries no guard either: an admin could pin a
`MigratedPool` record on a pump launch's zero-supply Mooner mint. The keeper
no longer routes pump launches to `migrate.mjs` (Task 8), so it stays an open
item rather than a guard. Callers of `claim_tokens`/`graduate` (`keeper.mjs`,
`migrate.mjs`, `fill-graduate.mjs`, web `claimTokens`, the canary scripts'
pinned IDLs) add the one address.
`pump_claim`/`pump_graduate` require the PDA to exist.

`buy`'s `pump` account stays *optional* (`None` for standard launches — passing
a non-existent L1 address into the ER is untested, and standard launches must
not depend on it). A session-key holder who omits it on a pump launch only makes
the market keep bonding past 1 SOL; the UI always passes it and
`freeze_launch` is the admin recovery. The gate is not a mitigation here: it
gates session *entry* only, and the trader holds the session key, so raw `buy`
transactions that omit the marker are possible. Open items, not in this plan:
a keeper check that freezes a pump launch found BONDING past 1 SOL, and what
`pump_claim`/`pump_graduate` do with a pot far above 1 SOL after such a late
admin freeze.

More open items on the pin itself (found in Task 5 review), also not in this
plan:
- The pin is one-shot and the only on-chain binding is `creator == launch.creator`;
  any pump token by that creator passes. A mispin is irreversible. The CLI must
  therefore pin ONLY the mint it persisted to `scripts/pump-mints/<launch_id>.json`
  and re-read the curve (creator, `complete == false`) right before sending.
- `set_pump_mint`'s `!complete` check is point-in-time. Anyone can buy the pump
  token to completion between the pin and the claims; then every `pump_claim`
  buy CPI fails and the pot is stuck behind `PumpClaimsOutstanding`. No
  recovery path is designed here.
- Two launches by the same creator can pin the same pump mint; nothing on-chain
  forbids it. The CLI's one-mint-per-launch file is the only guard.

Client side: Anchor's JS resolver ignores `optional` when the IDL account has
a `pda` block, so an omitted `pump` key is auto-derived from the seeds (or
throws), never None. Every non-pump `buy` call must pass `pump: null` — the
program-id sentinel the program reads as None.

### `pump_claim` flow

Accounts: cranker (S, the platform admin; pays tx fee only), platform
(readonly; admin check — `cranker == platform.admin`), trader (unchecked,
pinned to `session.trader`), launch (mut — pot debits), pump_launch (mut),
session (mut), vault (mut, system-owned PDA `["pumpvault", launch_id, trader]`),
trader_ata (mut; the trader's canonical ATA for `pump_mint`, created inside the
instruction by the ATA program with **the vault as payer** — `invoke_signed`), the
18 pump `buy` accounts listed under hard facts (with `user = vault`,
`associated_user = trader_ata`), token/ata/system programs.

Args: `amount: u64` (tokens to buy, from the crank's per-holder budget),
`max_sol_cost: u64` (from the crank's live quote plus slack). Both bounded below.

1. `require!(launch.is_settled())` first (RECONCILED, or FROZEN with
   `sessions_reconciled == sessions_opened`, which only happens when nobody
   traded) — `set_pump_mint` may land on a FROZEN launch, but claims must not
   start until every winner has been paid out of the pot (`pot_available`
   reserves nothing for an unreconciled winner, whose `reconcile_trade_session`
   would then fail `PotNotReady` forever). Then `require!(session.reconciled &&
   !session.tokens_claimed)` — the session-level check stays reachable, for a
   session that never traded and so was never counted in `sessions_opened`. If
   `tokens_held == 0` (fully exited during bonding, or never traded at all): mark
   `tokens_claimed` (`amount` must be 0, else `ClaimTooLarge`); bump
   `claims_done` **only if `sol_spent > 0`** (a session that deposited but never
   traded is not in `sessions_opened` and must not be counted); return — no
   vault, no CPI. This is what lets `pump_graduate`'s
   `claims_done == sessions_opened` gate close.
2. `require!(0 < amount <= tokens_held * (10_000 - PUMP_HAIRCUT_BPS) / 10_000)` —
   the on-chain ceiling; nobody can be handed more than their ledger share.
3. `allowance = rent(165) + rent(137) + rent(0)` (trader ATA, accumulator, creator
   vault top-up), all from `Rent::get()`. `need = max_sol_cost + allowance`.
   `require!(need <= pot_available)` where `pot_available = launch.lamports -
   rent_min(launch) - max(flip_pot, 0)` (the flip pot is reserved for
   `pump_graduate`); error `PotTooSmall`.
4. Lamports `launch → vault`: `need` (direct lamport move; the launch is
   program-owned).
5. CPI ATA `create_idempotent(trader_ata, payer = vault, owner = trader)` signed
   with `["pumpvault", launch_id, trader, bump]`.
6. CPI pump `buy(amount, max_sol_cost, Some(true))` with `user = vault`,
   `associated_user = trader_ata`, same signer seeds.
7. If `user_volume_accumulator` is non-empty: CPI pump
   `close_user_volume_accumulator(user = vault)` — its rent returns to the vault.
8. Sweep the vault to zero back to the launch via a signed system transfer.
9. `session.tokens_claimed = true; if session.sol_spent > 0 {
   pump_launch.claims_done += 1 }` (checked add).

The trader ends with exactly `amount` tokens in their own ATA (pump fills the
token side exactly; only the SOL cost varies with order), no SOL back (their
deposit remainder already walked home in `reconcile_trade_session`), and the only
funder in their ATA's history is a one-off PDA that never held tokens.

**Who picks `amount`.** The program enforces the ceiling and the pot guard; the
CLI chooses the size so the pot covers every holder in any order: before each
claim it reads the live pot and pump curve, gives the holder
`budget = pot_available × tokens_held / Σ tokens_held(unclaimed)`, subtracts the
permanent rent (ATA, plus the creator-vault top-up while that vault is below
rent-minimum) and 0.5 % slack, quotes tokens for what is left with the pump
SDK, and takes `min(ceiling, quote)`. Aggregate cost of buying `0.985 ×
tokens_sold` on the fresh pump curve is `≤ 0.985 × 1.0125 × raise` (cost is
convex with cost(0) = 0), so the budget rule only bites by the per-holder rent —
about 1.9 M lamports each on a 1 SOL raise. Cranking in ascending average cost
(`cost_basis / tokens_held`) puts the earliest Mooner buyers first on pump.
There is no self-service claim: the program bounds `max_sol_cost` only by the
pot, so budgeting is the keeper's job, and holders depend on the keeper for
their claims exactly as they do for `set_pump_mint` and `pump_graduate`.
A claim that does not fit fails `PotTooSmall` before any lamport moves (the
guard runs ahead of `fund_vault` and every CPI), and a pump-side failure rolls
the whole instruction back, so a failed crank burns nothing: the keeper simply
retries that holder with a smaller `amount`. A crank that *succeeds* with too
small an `amount` is final — `tokens_claimed` is set unconditionally.

Rent: the vault pays the ATA and the accumulator out of the pot allowance, so
the keeper never appears as a funder of any holder's account.

Platform tax: **waived** in pump mode (`config.launch_tax_bps` not applied). The
62 bps on 1 SOL is 0.0062 SOL; the crank's tx fees exceed it.

### `pump_graduate` flow (measured against the real mainnet pump ELF)

Accounts: admin (S, W), platform (W — the residue lands here), launch (W),
pump (W), the Mooner mint (W), the launch-level vault `["pumpvault",
launch_id]` (W), that vault's ATA for `pump_mint` (W), `pump_mint` (W —
`burn` moves supply), the 13 pump-side accounts with `user = vault`, then
token / ata / system.

Order inside the handler is load-bearing: `is_settled()` → `claims_done ==
sessions_opened` → the `vault_ata` derivation check → `need = max_sol_cost +
claim_allowance()` → the `pot_available` bound (reserving nothing: the flip
pot is exactly what graduation spends) → `fund_vault` → `create_idempotent`
→ pump `buy` → `burn` → `close_account` → `sweep_vault` → `set_authority`
(the never-minted Mooner mint is sealed) → `state = GRADUATED` → residue →
platform. The residue block must come **last**: a program-owned account's
lamports move by direct arithmetic and the runtime learns of such a move
only for the accounts the next CPI names, so a residue moved before
`set_authority` (which names the platform but not the launch) enters that
CPI as an unexplained credit — `UnbalancedInstruction`. Moving it earlier
fails the four graduate tests that existed when it was measured (there are now
seven).

**The burn takes the ATA's whole balance, not `amount`.** The vault's ATA is
`ATA(["pumpvault", launch_id], pump_mint)`, derivable from public state from
`set_pump_mint` on, so anyone — every claimed holder holds raw units — can
open it and park dust in it for the price of the ATA rent (≈0.002 SOL) plus
one raw unit. Burning only `amount` leaves that dust behind and
`close_account` refuses a non-empty account ("Non-native account can only be
closed if its balance is zero", SPL `0xb`), aborting at 130,492 CU. That
jams every `amount > 0` graduation of the launch permanently: the admin's
only remaining exit is `amount = 0`, which hands the platform **558,416,214**
lamports — the whole remainder, ≈50.8 % of the test's 1,100,000,001-lamport
raise — instead of putting it into the curve as burnt liquidity, denying the
curve the **147,304,125** lamports the funded path would have sent pump-side.
Regression test: `pump_graduate_burns_dust_parked_in_the_vault_ata`.

**`max_sol_cost` is an ALL-IN cap** — curve leg + protocol fee + creator fee
+ buyback, not just the curve. Binary search on the captured curve: the buy
succeeds at exactly **147,304,125** lamports and fails `TooMuchSolRequired`
(6002) one lamport below, and 147,304,125 is exactly the sum of the four
deltas (bonding curve, fee recipient, buyback, creator vault). This is why
`need = max_sol_cost + claim_allowance()` cannot be starved by fees: the
fees are inside the cap, and the allowance covers only rent. Conservation is
exact — `launch_before − launch_after == platform gain + Σ pump-side gains`,
558,416,214 = 411,112,089 + 147,304,125, vault and vault ATA both at 0.

**Compute:** a funded graduate consumes **145,861** CU (136,775 when the
vault's ATA already exists and `create_idempotent` no-ops; an `amount = 0`
graduate consumes **26,076** CU); the dust failure path now aborts at
**130,492** CU (130,260 before the `TokenAccount` read was added). The planned
CLI's 400k limit is ≈2.74× headroom (400,000 / 145,861).
(The review's 145,628 was measured before the burn-the-balance change;
deserialising the ATA to read its balance costs the extra ≈233 CU.)

**`amount = 0` is the graduate step's universal escape hatch** — a completed
curve, a repriced curve, a `TooMuchSolRequired`: pass 0 and the launch still
reaches GRADUATED, with the remainder going to the platform instead of the
curve. `pump_claim` has no equivalent for a session with `tokens_held > 0`
(it requires `amount > 0`), so a stuck pump curve strands claims, not
graduation. On the zero branch `max_sol_cost` must be 0 (`BadQuote`
otherwise): nothing is bought, so a cap there can only be a CLI
argument-order slip. Note `pump_claim`'s flat-session branch
(`tokens_held == 0`) does **not** bind `max_sol_cost` — nothing is spent
there either, and Task 6 was closed before this was noticed.

**Trust boundary of the 13 pump-side accounts.** Our program pins by address
only `pump_program` and `pump_fee_program`; `pump_mint` is pinned through
`pump.pump_mint`, and `vault_ata` by ATA derivation over BOTH the vault's
key and the mint — a substituted ATA fails `BadPumpAccount` before a single
lamport moves (`pump_graduate_rejects_a_wrong_vault_ata`). Everything else —
`global`, the bonding curve, the associated bonding curve, the creator
vault, the event authority, both volume accumulators, the fee config,
bonding-curve-v2 and both fee recipients — is validated by pump.fun itself
inside the CPI, not by us.

**`flip_pot` stays non-zero on a GRADUATED pump launch.** Its lamports leave
inside the residue but the field keeps its last value, mirroring
`graduate_handler`. A consumer reading `flip_pot` on a GRADUATED launch is
reading a stale number.

Open items from the Task 7 review, both to resolve before mainnet:

- **Tasks 7 and 8 ship as one unit.** Until Task 8 lands, `claim_tokens`
  (`reconcile.rs`) is permissionless and carries no pump guard: a stranger
  can crank it for any holder of a pump launch. That mints the Mooner token,
  makes that session's `pump_claim` fail `AlreadyClaimed` (6009) and
  `pump_graduate` fail `PumpClaimsOutstanding` (6028) **forever** — the pot
  is stuck, `lock_mint` impossible, the Mooner mint authority live.
  `pump_graduate`'s `claims_done == sessions_opened` gate turns a
  per-session block into a whole-launch brick, so this branch must not reach
  mainnet before Task 8.
- `reconcile.rs:232-235` states that a direct `+=` on a program-owned
  account "doesn't commit in this runtime" and routes the platform tax
  through a system transfer; `pump_graduate` bets its residue on the
  opposite, and the conservation test shows that direct credit to `platform`
  commits exactly, to the lamport. One of the two comments is wrong.
  Resolve it before mainnet — without touching the working path.

### Errors (new)

`PumpMode` (6024, a Meteora ix on a pump launch — "use pump_claim /
pump_graduate"), `PumpMintNotSet` (pump mint not set yet), `PumpMintAlreadySet`
(the pin is one-shot), `WrongPumpMint` (pump mint does not match this launch),
`PumpClaimsOutstanding` (pump claims still outstanding), `PotTooSmall` (the
launch pot cannot cover this pump buy), `ClaimTooLarge` (claim exceeds the
session's share), `BadPumpAccount` (pump-side account is not the one this
launch expects), `PumpTooLate` (pump mode must be enabled before the first trade),
`LaunchNotReconciled` (a claim on a launch whose sessions have not all
settled).

## CLI — `scripts/migrate-pump.mjs`

Same env as `migrate.mjs` (`RPC_URL`, `KEEPER_KEYPAIR`, CU price on every legacy
tx — the MCNFR lesson). Idempotent and resumable: every step reads on-chain state
and skips what already landed; **never** creates a second pump token for a launch
whose `pump_mint` is set.

```
node scripts/migrate-pump.mjs 7            # dry run (default): the CA, per-holder amounts + quotes; sends nothing
node scripts/migrate-pump.mjs 7 --confirm  # sends — the operator runs this by hand, never an agent
node scripts/migrate-pump.mjs 7 --only <trader> --amount <raw> --max-sol <lamports>  # one stuck holder: crank at an operator-chosen size, then rerun without flags
```

Steps per launch: (1) require every session reconciled (`sessions_reconciled ==
sessions_opened` — the keeper's job; the CLI refuses otherwise), (2) pump v1
`create` via `@pump-fun/pump-sdk` (CommonJS `require` — its ESM entry breaks on
`@coral-xyz/anchor`) — name/symbol from the Launch, `uri` = the launch's IPFS
metadata JSON resolved from the creation-tx memo CID (`GATEWAY + cid`, the same
lookup the web's `metadata.ts` does), mint keypair generated and persisted to
`scripts/pump-mints/<launch_id>.json` **before** sending so the CA is known first,
`creator = launch.creator`, `user` = keeper; (3) `set_pump_mint`; (4) `pump_claim`
per session in ascending avg-cost order with `amount` from the budget rule above
and `max_sol_cost` = the session's pro-rata budget (the quote is taken at
budget − 0.5%, so the cap has headroom) — the pot is re-read before **every**
claim and the slice retaken across the holders still waiting, so the slack a
claim leaves behind (the refunded `user_volume_accumulator` rent, and landing
under the cap) reaches them instead of being burnt at graduation; the dry run
cannot know that slack, so its per-holder budgets are a **floor** and its token
counts are a curve-advanced estimate rather than a live quote; sessions with `sol_spent > 0` and
`tokens_held == 0` get the bookkeeping claim (`amount = 0`); sessions that never
bought (`sol_spent == 0`) are skipped — `sessions_opened` never counted them; (5) `pump_graduate` with the pot quote, or
`amount = 0` when the pot is under 0.01 SOL; (6) append to
`scripts/migrations.json` (`{ kind: "pump", pumpMint, ... }`, mirrored to
`apps/web/public/migrations.json`). Every transaction: CU limit 400k + CU price
(`CU_PRICE`, default 50k µlamports).

## Web (`apps/web`)

- Create page: checkbox "graduate on pump.fun at 1◎"; when set, the create tx
  bundles `enable_pump` between `create_launch` and `delegate_launch`.
- Board / launch page: the existing launch sweep fetches PumpLaunch PDAs in one
  `getMultipleAccounts`; presence → threshold 1 SOL for progress/`maxCurveBuy`
  clamps, a "pump.fun" badge, claim button hidden ("tokens land in your wallet at
  migration"), graduated row links to `https://pump.fun/coin/<pump_mint>`.
- `buy` tx builder passes `pump: pumpPda | null`.
- IDL: regenerate `apps/web/lib/idl-v3.json` (mainnet) — the devnet demo IDL is not
  touched.

## Testing (`litesvm-tests`)

Fixtures dumped from mainnet into `litesvm-tests/fixtures/` (gitignored, written
by `scripts/dump-pump-fixtures.mjs`): the pump and `pfee…` program ELFs
(`ProgramData` minus its 45-byte header — both are upgradeable-loader programs),
accounts `Global`, `FeeConfig`, `GlobalVolumeAccumulator`, and — captured from a
mainnet `simulateTransaction` of a v1 `create` for a fixture mint keypair with a
fixture creator keypair — the post-create `mint`, `bonding_curve` and
`associated_bonding_curve`. Tests therefore never run pump `create` or Metaplex;
the program only ever CPIs `buy` and `close_user_volume_accumulator`. Tests
warp the clock to the capture time (the volume accumulator has a time window).
Missing fixtures → the pump tests print how to dump them and return without
asserting.

1. **Spike (first task, gates everything):** in litesvm with the fixtures, a
   funded keypair `user` buys with `associated_user` = a *different* wallet's ATA,
   then closes its volume accumulator; the accumulator rent returns to `user`.
   Records the measured rent numbers against
   `svm.minimum_balance_for_rent_exemption`. Fallback if the pump ELF does not
   load or the foreign-owner buy fails: a design revision, not a silent switch.
2. Lifecycle: launch created with the fixture creator, a buy-and-hold session
   and a flat one (bought, then sold everything), plus a fairest launch where an
   instant flip is taxed into the pot — a claim cannot reach the pot, graduation
   spends it; crossing buy at 1 SOL freezes; reconcile conservation to the lamport; `set_pump_mint` rejects a
   mint whose creator ≠ launch.creator; claims in any order all succeed with each
   holder receiving exactly `amount` tokens in their own ATA; the vault ends at 0
   lamports and the launch's lamport drop equals curve + fees + ATA rent (+ the
   creator-vault top-up) — conservation; the ceiling and the pot guard reject;
   double claim rejected; `pump_graduate` refused while a claim is outstanding;
   pot buy-and-burn leaves the launch at rent-min; Mooner mint supply 0 with no
   authority; `claim_tokens`/`graduate` refused with `PumpMode`.
3. Existing 34 litesvm + 18 unit tests stay green (the optional `buy` account
   defaults to `None`).

## Mainnet rollout

Program upgrade of `27HH…` (all 4 launches are state 3 — no live market to
strand), IDL push, `idl-v3.json` regen, Railway deploy of `web`. First real run is
a 1 SOL canary through the CLI, holder map checked on Bubblemaps before the
option is announced.

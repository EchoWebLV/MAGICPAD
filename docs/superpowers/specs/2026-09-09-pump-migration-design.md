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
- Live `fee_config` (`["fee_config", pump_program]` under
  `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`): **125 bps** on every tier
  (95 protocol + 30 creator). `Global.creatorFeeBasisPoints = 5` is superseded.
- Pump curve constants == Mooner's: virtual 30 SOL / 1.073e15, real 793.1T, supply
  1e15, 6 decimals. Constant-product ⇒ SOL raised determines tokens sold
  (path-independent), so replaying Mooner's final ledger onto a fresh pump curve
  costs exactly `real_sol_raised` pre-fee, in any order.
- At 1 SOL the Mooner curve has sold 34,612,903,225,806 raw (34.6M tokens, 3.46% of
  supply). End-to-end price move across the whole replay is 3.3%.

## Non-goals

- No change to standard (Meteora) launches, `keeper.mjs`, or the 85 SOL threshold.
- No browser-side self-crank of pump claims (CLI cranks; the web shows status).
- No creator dev-buy on pump; the Mooner creator first-buy rule is unchanged.

## Program changes (`programs/magicpad`)

### State — new PDA, `Launch` layout untouched

```rust
// seeds = ["pump", launch_id.to_le_bytes()]
pub struct PumpLaunch {
    pub launch_id: u64,
    pub pump_mint: Pubkey,   // Pubkey::default() until set_pump_mint
    pub claims_done: u64,    // sessions whose pump_claim landed
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
| `pump_claim` | L1 | anyone (cranker) | Replaces `claim_tokens` for pump launches. See flow below. |
| `pump_graduate` | L1 | admin | Requires every traded session claimed or bookkept (`claims_done == sessions_reconciled`, `sessions_reconciled == sessions_opened`, `state ∈ {FROZEN, RECONCILED}`). Flip pot + pot dust → launch vault → pump `buy` → `burn` the received tokens (skip when pot < a 0.01 SOL floor: rent would eat it; sweep to platform instead). Revokes the Mooner mint authority (supply is 0). `state = GRADUATED`. |

`claim_tokens` and `graduate` (the two instructions that mint the Mooner
supply) gain a **required** `pump: UncheckedAccount` constrained to the
`["pump", launch_id]` address and `require!(pump.data_is_empty())` → error
`PumpMode`. An optional account would be no guard at all (omit it and the
Mooner mint gets minted on a pump launch). `lock_mint` needs no guard (supply is
0, it fails on its own check); `record_pool` is harmless. Callers of
`claim_tokens`/`graduate` (`keeper.mjs`, `migrate.mjs`, `fill-graduate.mjs`,
web `claimTokens`, the canary scripts' pinned IDLs) add the one address.
`pump_claim`/`pump_graduate` require the PDA to exist.

`buy`'s `pump` account stays *optional* (`None` for standard launches — passing
a non-existent L1 address into the ER is untested, and standard launches must
not depend on it). A session-key holder who omits it on a pump launch only makes
the market keep bonding past 1 SOL; the UI always passes it, the gate keeps
sessions UI-born, and `freeze_launch` is the admin recovery.

### `pump_claim` flow

Accounts: cranker (S, pays tx fee only), trader (unchecked, pinned to
`session.trader`), platform, launch (mut — pot debits), pump_launch (mut),
session (mut), vault (mut, system-owned PDA), vault_token_account (mut; the
vault's ATA for `pump_mint`, created by the cranker via ATA program in the same
tx **with the vault as payer** — see rent), pump accounts (global,
fee_recipient, mint, bonding_curve, associated_bonding_curve, creator_vault,
event_authority, pump program, global_volume_accumulator,
user_volume_accumulator, fee_config, fee_program), token/ata/system programs.

Args: `max_sol_cost: u64` (from the crank's live quote; bounded below).

1. `require!(session.reconciled && !session.tokens_claimed)`. If
   `tokens_held == 0` (a session that fully exited during bonding): mark
   `tokens_claimed`, `claims_done += 1`, return — no vault, no CPI. This is what
   lets `pump_graduate`'s `claims_done == sessions_reconciled` gate close.
2. `amount = tokens_held * (10_000 - PUMP_HAIRCUT_BPS) / 10_000`.
3. `require!(max_sol_cost <= pot_available)` where `pot_available = launch.lamports - rent_min - flip_pot` (the flip pot is reserved for `pump_graduate`).
4. Lamports `launch → vault`: `max_sol_cost + RENT_ALLOWANCE` (ATA rent 2_039_280 + user_volume_accumulator rent; the exact accumulator size is read in the spike and hard-coded as a constant).
5. CPI pump `buy(amount, max_sol_cost, track_volume = false)` with `user = vault`, seeds `["pumpvault", launch_id, trader, bump]`.
6. CPI SPL `set_authority(vault_token_account, AccountOwner → trader)`, authority = vault (signed).
7. Sweep vault residue (`max_sol_cost` slack + unused allowance) back to the launch pot via signed system transfer; vault ends at 0 lamports.
8. `session.tokens_claimed = true; pump_launch.claims_done += 1`.

Why this is safe in any crank order: buying `0.985 × tokens_sold` in aggregate on
the fresh pump curve costs `≤ 0.985 × 1.0125 × real_sol_raised = 0.9973 × raise`
(cost is convex with cost(0)=0), so the pot always covers every claim. Order only
changes which holder's fill deviates from `tokens_held` by up to the 3.3% curve
move; the CLI cranks in ascending average cost (`cost_basis / tokens_held`) so
the earliest Mooner buyers buy first on pump and fills track the ledger.

Rent: the vault pays its own ATA + accumulator rent out of the pot allowance, so
the keeper never appears as a funder of any holder's account. Net effect per
holder: `amount` tokens, no SOL back (their deposit remainder already walked home
in `reconcile_trade_session`).

Platform tax: **waived** in pump mode (`config.launch_tax_bps` not applied). The
62 bps on 1 SOL is 0.0062 SOL; the crank's tx fees exceed it.

### Errors (new)

`PumpMode` (Meteora ix on a pump launch), `NotPumpMode`, `PumpMintNotSet`,
`PumpMintAlreadySet`, `PumpCreatorMismatch`, `PumpCurveComplete`, `PotTooSmall`,
`PumpClaimsOutstanding`.

## CLI — `scripts/migrate-pump.mjs`

Same env as `migrate.mjs` (`RPC_URL`, `KEEPER_KEYPAIR`, CU price on every legacy
tx — the MCNFR lesson). Idempotent and resumable: every step reads on-chain state
and skips what already landed; **never** creates a second pump token for a launch
whose `pump_mint` is set.

```
node scripts/migrate-pump.mjs            # every FROZEN/RECONCILED pump launch
node scripts/migrate-pump.mjs 7          # one launch id
node scripts/migrate-pump.mjs --dry      # per-holder amounts + quotes, send nothing
```

Steps per launch: (1) ensure sessions committed + reconciled (reuse keeper's
reconcile helper), (2) pump `create` — name/symbol from the Launch, `uri` from the
Mooner Metaplex metadata account (`metadata.rs` already pinned it), mint keypair
persisted to `scripts/pump-mints/<launch_id>.json` **before** sending, `creator =
launch.creator`, (3) `set_pump_mint`, (4) `pump_claim` per session in ascending
avg-cost order, `max_sol_cost` from a live quote against pump's bonding curve and
fee tiers with 0.5% slack, (5) `pump_graduate`, (6) append to
`scripts/migrations.json` (`{ kind: "pump", mint, ... }`, mirrored to
`apps/web/public/migrations.json`).

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

Fixtures dumped from mainnet into `litesvm-tests/fixtures/` (gitignored, fetched by
`scripts/dump-pump-fixtures.sh`): pump program, `pfee…` program, mpl-token-metadata
program, and accounts `Global`, `FeeConfig`, `GlobalVolumeAccumulator`,
`__event_authority`.

1. **Spike (first task, gates everything):** in litesvm, a PDA `user` funded by
   system transfer CPIs pump `buy` successfully, and `SetAuthority(AccountOwner)`
   moves the classic-token ATA to another owner. Records the
   `user_volume_accumulator` rent. Fallback if (a) fails: per-holder *keypair*
   vault generated by the crank (no transfer edges, but a keeper funded-by edge) —
   requires a design revision, not a silent switch.
2. Lifecycle: 3 sessions (buy-and-hold, flipper taxed in fairest mode, net winner
   who fully exited), crossing buy at 1 SOL freezes; reconcile conservation to the
   lamport; `set_pump_mint` rejects a mint whose creator ≠ launch.creator; claims
   in any order all succeed; each fill within `[amount − 3.3%, amount]` of
   `tokens_held × 0.985`; double claim rejected; `pump_graduate` refused while a
   claim is outstanding; pot buy-and-burn leaves the launch at rent-min; Mooner
   mint supply 0 with no authority; `claim_tokens`/`graduate` refused with
   `PumpMode`.
3. Existing 34 litesvm + 18 unit tests stay green (the optional `buy` account
   defaults to `None`).

## Mainnet rollout

Program upgrade of `27HH…` (all 4 launches are state 3 — no live market to
strand), IDL push, `idl-v3.json` regen, Railway deploy of `web`. First real run is
a 1 SOL canary through the CLI, holder map checked on Bubblemaps before the
option is announced.

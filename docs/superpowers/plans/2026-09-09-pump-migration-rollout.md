# pump.fun migration — rollout

Everything below is user-run. Nothing here is executed by an agent.

Written against `pump-migration` at `b8604d7`. Line citations are that tree.

## 1. Program upgrade (mainnet)

The v3 program gains four instructions (`enable_pump`, `set_pump_mint`,
`pump_claim`, `pump_graduate`), one account (`PumpLaunch`), an **optional**
trailing account on `buy`, and a **required** account on `claim_tokens` and
`graduate` that must be *empty*
(`programs/magicpad/src/instructions/reconcile.rs:126-128` and `:196-198` —
`pub pump: UncheckedAccount<'info>`, not an `Option`; the handlers require
`ctx.accounts.pump.data_is_empty()` at `:149` and `:214`, error `PumpMode`
6024). Existing launches are unaffected: no marker → the old line, the old
path (`litesvm-tests/tests/pump.rs`,
`buy_without_the_marker_account_keeps_the_85_sol_line` and
`non_pump_launch_ignores_a_missing_marker`).

Because that account is required rather than optional, **the old keeper and
the old web fail on every `claim_tokens`** the moment the new program is
live — they do not send the key at all. So the web deploy and the keeper
restart happen in the same window as the program upgrade, not after it.
`apps/web/lib/idl-v3.json` is the regenerated IDL (Task 10); the devnet demo
IDL is untouched.

**Tasks 7 and 8 ship as one unit.** Task 7 adds the pump instructions; Task 8
adds the marker guard on `claim_tokens`/`graduate`. `claim_tokens` is
permissionless. A stranger cranking `claim_tokens` on a pump launch before
the guard is live mints that holder's Mooner token, which makes that
session's `pump_claim` fail `AlreadyClaimed` (6009) and, because
`pump_graduate` gates on `claims_done == sessions_opened`
(`programs/magicpad/src/instructions/pump.rs:415-418`), makes
`pump_graduate` fail `PumpClaimsOutstanding` (6028) for that launch
permanently — the pot stranded, `lock_mint` impossible, the Mooner mint
authority still live. Both tasks are on this branch. Never deploy one
without the other.

**Deploy precondition, not an open item.** The web's Meteora line is
env-driven: `apps/web/lib/core.ts:32-33` reads
`NEXT_PUBLIC_GRADUATION_LAMPORTS` and falls back to `5 * LAMPORTS`, while the
program's line is `GRADUATION_LAMPORTS: u64 = 85_000_000_000`
(`programs/magicpad/src/constants.rs:15`). The production web env must
therefore carry `NEXT_PUBLIC_GRADUATION_LAMPORTS=85000000000` alongside the
85◎ program, or every standard launch page draws the wrong line. The pump
line needs no env — it is fixed in code (`PUMP_GRADUATION_LAMPORTS`,
`apps/web/lib/core.ts:35`). As of this tree
`grep -c '^NEXT_PUBLIC_GRADUATION_LAMPORTS=' apps/web/.env.local` prints `0`.

```bash
anchor build
```

```bash
solana program deploy --program-id <PROGRAM_ID> target/deploy/magicpad.so --upgrade-authority <AUTHORITY_KEYPAIR> --url <RPC_URL>
```

```bash
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/magicpad.json --provider.cluster <RPC_URL>
```

Then deploy the web and restart the keeper.

## 2. Canary

1. Create a launch with "graduate on pump.fun at 1◎" ticked. The create tx
   builds `create_launch` → `enable_pump` → `delegate_launch` in that order
   (`apps/web/app/create/page.tsx:121`, `:129`, `:154`/`:163`): the marker
   must exist before the first trade or `enable_pump` refuses with
   `PumpTooLate` (6032), and it must exist before delegation because
   `enable_pump` wants a not-yet-delegated launch.
2. Give it a face. `migrate-pump.mjs` refuses a launch with no
   creator-signed metadata memo (`scripts/migrate-pump.mjs:368-369`).
3. Buy past 1 SOL from two wallets, and sell one of them out entirely — the
   flat (bought, then sold everything) path is worth covering, since it takes
   a different branch (`amount = 0`, no vault, no CPI).
4. Wait for the keeper. It reconciles every session and then stops, printing
   (`scripts/keeper.mjs:223`, verbatim):

   `launch ${id}: pump launch — reconciled; scripts/migrate-pump.mjs ${id} takes it from here`

5. **Run the CLI as the platform admin.** `pump_claim` checks
   `cranker == platform.admin` (`programs/magicpad/src/instructions/pump.rs:220-221`)
   and `pump_graduate` checks `platform.admin == admin.key()` (`:319`); both
   are `Unauthorized` otherwise. The CLI signs with `loadKeeper()`
   (`scripts/migrate.mjs:42-50`): `KEEPER_KEYPAIR` as a path or an inline JSON
   array, falling back to `~/.config/solana/id.json`. `RPC_URL` selects the
   cluster; `CU_PRICE` sets the priority fee (default 50,000 µlamports).

6. Dry run. It sends nothing and prints the CA — the mint from
   `scripts/pump-mints/<id>.json`, generated and persisted before anything is
   sent — before any other work (`scripts/migrate-pump.mjs:296`):

```bash
node scripts/migrate-pump.mjs <id>
```

   **What the CLI does, as it stands at `b8604d7`** (header comment
   `scripts/migrate-pump.mjs:1-33`, usage line `:96-97`):

   - Dry run is the default; `--confirm` sends. Three phases, each idempotent
     on rerun: 1. create the pump token + `set_pump_mint`; 2. `pump_claim`
     per session; 3. `pump_graduate`.
   - The live run **re-reads the pot before every claim** and re-slices it
     pro-rata over the holders still waiting (`:529-543`). Each claim's
     unspent slack therefore flows to the holders behind it, so **every
     per-holder budget the dry run prints except the first is a floor, not a
     promise** — the dry run says so itself (`:453-458`).
   - The dry run's token estimates come from one preview curve advanced
     locally by each planned buy (`:481-517`); the live run re-quotes against
     the real curve before each send.
   - A launch that is already pinned reads its mint **from chain**
     (`:276-278`); the keypair file is needed only for phase 1's `create`
     signature. A leftover file for a pinned launch is not used and is warned
     about loudly (`:283-294`).
   - `--only <trader>` cranks that one session and **never graduates**
     (`:663-665`). Rerun without flags once every session has claimed.
   - `--amount <raw tokens> --max-sol <lamports>` (both required together,
     and both require `--only`) replace the budget rule for that one session.
     The CLI refuses `--amount 0` on a funded session (`:555-558`), an
     `--amount` above the 98.5 % ceiling (`:559-562`), and any `--max-sol`
     that would not leave every waiting holder its allowance (`:574-582`);
     above the session's fair pro-rata share it prints a capitalised warning
     that the difference is final for the holders still waiting (`:583-588`).
   - The sessions-vs-claims coverage guard runs **before the first send**,
     ahead of `create` + `set_pump_mint` (`:353-359`), so a missing session
     PDA is caught before the CA is public and pinned one-shot.
   - Every CLI transaction sets a 400,000 CU limit (`:91`). Measured against
     the real mainnet pump ELF: a funded `pump_claim` 139,997–168,497 CU, a
     flat claim 27,310 CU, `pump_graduate` 145,861 CU.

   **Phases 2 and 3 have never run against a real pump launch.** No
   `scripts/pump-mints/` directory exists in this tree, and phase 1 writes
   one on any dry run of an unpinned launch (`:277`, `loadOrMakeMint()` is
   called before the `--confirm` branch) — so no dry run has ever reached
   past the preconditions on mainnet. `scripts/migrations.json` holds five
   records, all Meteora-shaped (`pool`, `position`, `seedSol`, `seedTok`),
   none of the pump shape. **The first dry run on a real pump launch is the
   pre-flight. Read its output line by line before `--confirm`.**

7. Send it:

```bash
node scripts/migrate-pump.mjs <id> --confirm
```

8. Verify, before calling it live: `getSignaturesForAddress` on the pump mint
   shows the create + buys; `https://frontend-api-v3.pump.fun/coins/<CA>`
   returns the coin; the launch page shows `PUMP.FUN` and the link; each
   trader's wallet holds the pump token; the Mooner mint's authority is
   `None`.

```bash
spl-token display <MOONER_MINT>
```

9. Bubblemaps: `https://app.bubblemaps.io/sol/token/<CA>` — every holder's
   tokens come from the bonding curve, no transfer edges, no hub.

## 3. If something is wrong mid-way

- `set_pump_mint` sent, claims not: rerun the CLI — it skips `create`,
  resumes claims; each claim is atomic (vault funded and swept in the same
  ix).
- **A `PotTooSmall` crank burns nothing.** The pot guard runs ahead of
  `fund_vault` and every CPI (`programs/magicpad/src/instructions/pump.rs:255-259`),
  and a pump-side failure rolls the whole instruction back. The CLI catches
  `PotTooSmall`, **re-quotes and re-slices once**, and then stops loudly
  (`scripts/migrate-pump.mjs:615-643`) — it does not loop.
- **A crank that *succeeds* with too small an `amount` is final for that
  session.** `session.tokens_claimed = true` is set unconditionally
  (`programs/magicpad/src/instructions/pump.rs:305`); there is no top-up
  path. A holder underpaid by a landed claim stays underpaid.
- Pot too thin to claim at all (`quotes 0 tokens`): the launch stays
  RECONCILED; `freeze_launch` is not needed (it is already frozen). The
  admin can `pump_graduate` only after every claim, so the pot stays in the
  launch PDA until the numbers work — there is no drain path.
- **`pump_graduate` with `amount = 0` (and `max_sol_cost = 0`) is the
  universal escape hatch** — a completed curve, a repriced curve, a
  `TooMuchSolRequired`: pass zero and the launch still reaches GRADUATED.
  The remainder then goes **to the platform, not into the curve**. On the
  zero branch `max_sol_cost` must also be 0, or the instruction fails
  `BadQuote`. `pump_claim` has no equivalent for a session with
  `tokens_held > 0`, so a stuck pump curve strands claims, not graduation.
- **The graduate burns whatever the vault ATA holds**, not `amount`
  (`programs/magicpad/src/instructions/pump.rs:476-495`: it deserialises the
  ATA and burns `held`). The ATA address is derivable from public state from
  `set_pump_mint` on, so anyone can park dust in it — and dust left behind
  would make `close_account` fail and jam every `amount > 0` graduation of
  that launch for good. Burning the balance means parked dust cannot jam it.
  Regression test: `pump_graduate_burns_dust_parked_in_the_vault_ata`.
- **`max_sol_cost` is an ALL-IN cap** — curve leg + protocol fee + creator
  fee + buyback, not just the curve. Binary search on the captured curve: the
  buy succeeds at exactly **147,304,125** lamports and fails
  `TooMuchSolRequired` one lamport below, and that figure is exactly the sum
  of the four deltas. This is why `need = max_sol_cost + claim_allowance()`
  cannot be starved by fees: the fees are inside the cap, and the allowance
  covers only rent.
- ER cloning: the marker is never delegated; the ER validator clones
  non-delegated accounts on first use. The precedent is the long-lived
  `platform` PDA read by `freeze_launch`; a marker born in the same tx as
  `delegate_launch` and read by an ER `buy` a slot later is untested. Before
  the mainnet upgrade, run a devnet pass: create + enable_pump +
  open_trade_session + delegate in one tx, then an immediate ER buy carrying
  the marker — assert the FIRST buy lands (not a retry) and that a 1 SOL buy
  freezes (`scripts/prove-buy-deploy.mjs` is the closest harness to extend).
  Every failure mode is fail-closed (tx error or AccountNotInitialized);
  none silently falls back to the 85 SOL line. The tx to reproduce is the one
  the create page already builds: `create_launch` → `enable_pump` →
  `delegate_launch` (`apps/web/app/create/page.tsx:121`, `:129`,
  `:154`/`:163`).

## 4. What never changes

- `scripts/mainnet-canary/` stays gitignored (`.gitignore:20`); never push
  it. Its v1 `run.mjs` loads the live `target/idl/magicpad.json` and calls
  `buy` without `pump`; it is frozen against its pinned `.so`
  (`PINNED_SO_SHA`) and must not be run against the pump-era IDL. `run2`–
  `run4` load pinned pump-free IDLs and are unaffected.
- `scripts/pump-mints/<id>.json` is the pump token's mint secret, gitignored
  (`.gitignore:29`). Back it up off-repo; losing it before phase 1 sends
  means a new CA on the next run — after phase 1 the mint is on-chain and the
  file is only needed for the `create` signature, which is already done.
  **One file per launch id. Never copy a file between launches.**

## 5. Open items before mainnet

- **`reconcile.rs:223-225` contradicts `pump_graduate`.** That comment says
  a direct `+=` on a program-owned account "doesn't commit in this runtime"
  and routes the platform tax through a system transfer; `pump_graduate`
  bets its residue on the opposite, and the conservation test shows direct
  credit to `platform` commits exactly, to the lamport. One of the two is
  wrong. Resolve it — without touching the working path.
- **pump `buy` under-delivery near a complete curve is unverified.** None of
  the 40 tests in `litesvm-tests/tests/pump.rs` covers a buy that fills fewer
  tokens than `amount` on a nearly complete curve. `burn(held)` is safe
  either way (it reads the ATA's actual balance), so the graduate path
  carries no risk from it; what is unknown is only whether a claim can
  under-deliver to a holder.
- **`pump_claim`'s flat path does not bind `max_sol_cost`.** With
  `tokens_held == 0` only `amount == 0` is required
  (`programs/magicpad/src/instructions/pump.rs:247`); nothing is spent
  either way, so the cap is unchecked. The CLI always passes `(0, 0)`.
- **Re-simulate a live pump buy with the real fee and buyback recipients
  before the mainnet dry run.** The CLI hard-codes the buyback wallet as
  element `[0]` of pump's private `CURRENT_FEE_RECIPIENTS_FOR_BUYBACK`
  (`scripts/migrate-pump.mjs:57-63`) because the SDK only exposes a
  *random* picker and a deterministic crank must not randomise. The fee
  recipient comes from the fetched `global`. Both are captured state.
- **`flip_pot` stays non-zero on a GRADUATED pump launch.** Its lamports
  leave inside the residue but the field keeps its last value, mirroring
  `graduate_handler`. Cosmetic — but a consumer reading `flip_pot` on a
  GRADUATED launch is reading a stale number.
- **`record_pool` carries no pump guard.** It is admin-only
  (`reconcile.rs:348-350`), `init`-only on the mint-seeded PDA (`:359-361`),
  and requires `LAUNCH_GRADUATED` (`:367-370`) — so an admin could record a
  Meteora pool against a graduated *pump* launch. Nothing on chain stops it.
- **On an UNPINNED launch the CLI trusts `scripts/pump-mints/<id>.json`.**
  A stale file whose mint already carries a curve by the same creator would
  be pinned one-shot: `set_pump_mint` binds only `creator == launch.creator`
  and `!complete` (`programs/magicpad/src/instructions/pump.rs:108-110`), and
  a mispin is irreversible. Keep one file per launch id; never copy files
  between launches.
- **The CLI's `migrations.json` pump records carry no `pool` field.** The
  record it writes is
  `{ kind: 'pump', pumpMint, creator, launchId, sigs, at }`
  (`scripts/migrate-pump.mjs:724-729`). Task 10 made this moot for the
  launch page: `onPool = l.state === 3 && !l.pump`
  (`apps/web/app/launch/[id]/page.tsx:271`), so a graduated pump launch never
  takes the pool path — it takes the pump.fun link path
  (`apps/web/lib/core.ts:81`, `pumpUrl`), which is what the spec's `## Web`
  section specifies ("graduated row links to
  `https://pump.fun/coin/<pump_mint>`"). `apps/web/lib/pool.ts`'s
  `findPublicMarket` is the only reader of `/migrations.json` and **has no
  callers anywhere in the web today**; the launch page imports only
  `meteoraPoolUrl` from that file (`:44`). If `findPublicMarket` is ever
  wired up, `j?.[mint]?.pool ?? null` resolves `null` for a pump record and
  falls through to the Meteora API for a Mooner mint that has no pool.
- **No pump instruction produces an activity row.** `apps/web/lib/ledger.ts`
  (~`:105-118`) switches on decoded instruction names and has no case for
  `enable_pump`, `set_pump_mint`, `pump_claim` or `pump_graduate`, so they
  fall into `default: break` and the launch page's activity list shows
  nothing for the whole migration.
- **One failed first marker read paints a pump launch as a Meteora one.**
  `apps/web/app/launch/[id]/page.tsx:160-161` holds the last good answer
  (`pv === undefined ? (live?.pump ? … : null) : pv`), but on a freshly
  opened page `live` is `null`, so there is no previous answer to hold and
  the fallback is `null` — the Meteora line, the wrong chip, the claim button
  back — until the next 3 s tick (`:197`). Buys are safe throughout:
  `buyLive` throws on an unread marker (`apps/web/lib/trade-live.ts:546-547`,
  and `quickBuy` asks before the escrow legs at `:580`).
- **The marker memo can lag a just-pinned mint by up to 45 s.**
  `PUMP_MEMO_MS = 45_000` (`apps/web/lib/trade-live.ts:506`). Existence
  cannot change, so it is cached forever once known; `pump_mint` and a
  memoised *absence* are re-read at most every 45 s (`:514`), and a failed
  re-read keeps the last answer (`:522-527`). Consequences: a mint pinned
  while a page is open can lag by that much, and a Meteora launch page costs
  one L1 read per 45 s for as long as it is open.
- **Overlapping marker reads are not de-duplicated.** There is no in-flight
  promise on `readPumpLaunch` — a refresh tick and a buy in the same instant
  each issue their own `getAccountInfo`. Bounded at one extra read per 45 s
  window.
- **The web skips the marker read off mainnet.**
  `if (CLUSTER !== 'mainnet') return null` (`apps/web/lib/trade-live.ts:512`),
  and the board sweep batches pump PDAs on mainnet only
  (`apps/web/lib/magicpad.ts:171-176`). If the pump program were ever
  deployed to devnet, the web would hide every marker there.
- **The claim button's errors are humanised, and 6009's sentence names the
  dominant cause, not the only one.** `PROGRAM_ERROR_TEXT`
  (`apps/web/lib/trade-live.ts:28-51`) maps 6024, 6008, 6009 and 6012 to
  sentences. 6009 reads "a cranker claimed them first", which is right for
  the common case — `scripts/keeper.mjs` cranks `claimTokens` between ticks —
  but a holder's own claim that landed and then errored reaches the same
  code and gets the same sentence.
- The pump.fun link and chip copy is fixed by the plan: `1◎ → PUMP` on the
  board while bonding (`apps/web/components/Board.tsx:125`), `PUMP.FUN` on
  graduation (`:113`, `Featured.tsx:127`, launch page `:352`), `on pump.fun`
  in the launch footer (`:812`). The trade-card note shows from FROZEN on
  (`l.pump && l.state >= 1`, launch page `:632-635`).

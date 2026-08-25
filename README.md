# MagicPad

The launchpad snipers cannot see.

Bonding happens inside a MagicBlock Ephemeral Rollup. One approval escrows your
bankroll, then every buy and sell is a gasless session-key transaction at
rollup speed. The SPL mint exists from second zero but holds zero supply until
graduation, so snipers and copy-traders see nothing to shoot at. Arm the entry
gate and bots cannot even open a session. That is the whole pitch: free to
launch, zero fees to trade, and nothing on L1 to front-run until it is over.

## The rail

- **create_launch** (L1): config-set fee (default 0), PDA mint at supply 0, curve state born
- **delegate_launch** (L1): the market goes dark inside the ER
- **open_trade_session** (L1): one tx escrows the deposit and delegates the
  session. The escrow is the ceiling on what the ER can ever spend.
- **top_up_session + delegate_top_up** (L1): buy bigger than the ceiling? One
  tx parks more lamports in a note PDA and hands it to the ER
- **apply_top_up** (ER): the note raises the session ceiling in place; the
  same buy retries and clears
- **buy / sell** (ER): gasless, signed by a throwaway session key, ledger only
- crossing buy sets FROZEN, or **freeze_launch** closes a market that fizzles
- **commit_trade_sessions / commit_launch** (ER): permissionless, FROZEN-gated
- **absorb_top_up** (L1): permissionless; folds committed note lamports into
  the session escrow. Reconcile refuses to run until every note is home.
- **reconcile_trade_session** (L1): cash follows ledger. Losers fund the pot
  first, winners collect after. Conservation holds to the lamport.
- **claim_tokens** (L1): the first real mint this token ever sees
- **graduate** (L1): raised SOL and leftover supply leave for the Meteora seed
- **migrate** (script): DAMM v2 pool at the frozen curve price, excess burned, LP locked
- **lock_mint** (L1): mint authority revoked once supply is the full graduated amount
- **set_fees / set_gate** (L1, admin): launch fee + graduation tax on a config
  PDA; the gate pins entry to a co-signer, so only the UI can open a session

## Devnet

Program: `27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws`

The full pipeline runs live against MagicBlock devnet infrastructure:

```bash
node scripts/demo-trader.mjs auto
```

Two traders, one launch. trader2 pumps and dumps for a profit, the wallet
buys the top and sells the crater for a real loss. The run proves the
winner-first reconcile fails clean (PotNotReady), the conservation table
balances exactly, and claim_tokens mints real SPL. A killed run picks back up with `resume <id>`.

```bash
node scripts/prove-topup.mjs
```

The escrow-ceiling proof: a buy bounces off the deposit wall (ExceedsDeposit,
live), one L1 tx tops the escrow up, the ER raises the ceiling, the same buy
clears. Reconcile refuses to run while a committed note sits unabsorbed, the
absorb moves the exact note lamports into the session, and the conservation
table still balances to the lamport.

The keeper is the janitor that makes settlement autonomous. It never touches
a live market; once a launch freezes it commits sessions home, reconciles
losers-first, cranks token claims, graduates what qualifies, then
seeds Meteora and locks the mint:

```bash
node scripts/keeper.mjs            # loop; KEEPER_ONCE=1 for a single tick
node scripts/migrate.mjs           # seed any GRADUATED launch still sitting on admin
node scripts/migrate.mjs --dry     # print seed amounts, send nothing
```

## Web terminal

```bash
pnpm install
pnpm --filter @magicpad/web dev    # http://localhost:3020
```

Three columns — New, Final Stretch, Migrated — over a dual sweep: home
launches read from the program, dark launches discovered under the delegation
program and overlaid with their live ER state. Connect any wallet-standard
wallet (Phantom, Solflare, Backpack). The wallet signs only when cash moves —
launching a market, opening a session, topping it up — and every trade is a
gasless session-key transaction with no popup, with quote previews mirroring
the on-chain curve. A buy bigger than the free escrow doesn't error: the
terminal tops the escrow up from the wallet automatically, so the only real
limit is the wallet balance. Dark markets have no public L1 trade
log by design, but the terminal reconstructs full history anyway: deposits
and settlement from L1, the trades themselves from the ER's own ledger, with
session signers joined back to trader wallets. Replaying that history through
the program's exact curve math drives a TradingView candlestick chart, the
bonding totals, and a live holders table — no indexer anywhere.

Set `NEXT_PUBLIC_RPC_URL` in `apps/web/.env.local` to a dedicated devnet RPC
(Helius free tier works) — the public devnet endpoint rate-limits hard.

## Privy login (optional)

Create an app at [dashboard.privy.io](https://dashboard.privy.io) and set its
App ID in `apps/web/.env.local`:

```
NEXT_PUBLIC_PRIVY_APP_ID=your-app-id
```

The terminal gains email and social login with an embedded Solana wallet, and
signing is headless — session opens and escrow top-ups run without a single
popup, so the product is popup-free from login to settlement. Fresh embedded
wallets get a one-click devnet airdrop button in the nav. With the variable
unset the app runs pure wallet-adapter, exactly as before.

## Tests

```bash
cargo test --manifest-path programs/magicpad/Cargo.toml   # curve math
cargo test --manifest-path litesvm-tests/Cargo.toml       # full lifecycle
```

The litesvm suite drives the entire rail in-process: fee and mint checks,
two-trader lifecycle with graduation, loss accounting, the escrow discipline
against hijacks, the no-trades-after-freeze gate, the entry gate (armed,
disarmed, forged, wrong co-signer), session key rotation, and the top-up
lifecycle — ceiling bounce, raise, absorb, and the reconcile-before-absorb
refusal.

## Build

Anchor 0.31.1 toolchain, anchor-lang 1.0.2, ephemeral-rollups-sdk 0.14.3.

```bash
anchor build
```

# MagicPad

The launchpad that pays you to trade.

Bonding happens inside a MagicBlock Ephemeral Rollup. One approval escrows your
bankroll, then every buy and sell is a gasless session-key transaction at
rollup speed. The SPL mint exists from second zero but holds zero supply until
graduation, so snipers and copy-traders see nothing to shoot at. Lose money
during bonding and the rakeback pool pays you 10% of it back. That is the
whole pitch: 1 SOL to launch, zero fees to trade, losses pay rakeback.

## The rail

- **create_launch** (L1): 1 SOL fee, PDA mint at supply 0, curve state born
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
- **claim_rakeback** (L1): 10% of realized losses, paid from a segregated pool
- **graduate** (L1): raised SOL and unsold supply leave to seed Meteora

## Devnet

Program: `27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws`

The full pipeline runs live against MagicBlock devnet infrastructure:

```bash
node scripts/demo-trader.mjs auto
```

Two traders, one launch. trader2 pumps and dumps for a profit, the wallet
buys the top and sells the crater for a real loss. The run proves the
winner-first reconcile fails clean (PotNotReady), the conservation table
balances exactly, rakeback pays real lamports, and claim_tokens mints real
SPL. A killed run picks back up with `resume <id>`.

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
losers-first, cranks token claims and rakeback, and graduates what qualifies:

```bash
node scripts/keeper.mjs            # loop; KEEPER_ONCE=1 for a single tick
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
two-trader lifecycle with graduation, loss and rakeback accounting, the
first-window anti-whale cap, escrow discipline against hijacks, the
no-trades-after-freeze gate, and the top-up lifecycle — ceiling bounce,
raise, absorb, and the reconcile-before-absorb refusal.

## Build

Anchor 0.31.1 toolchain, anchor-lang 1.0.2, ephemeral-rollups-sdk 0.14.3.

```bash
anchor build
```

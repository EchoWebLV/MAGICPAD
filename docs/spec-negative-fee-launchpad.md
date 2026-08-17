# The Negative-Fee Launchpad (working title)

*Captured 2026-08-18 from a working session. One page. Everything here is design intent, not commitment.*

## The pitch

> Launching costs 1 SOL. Trading costs nothing. Losing pays you back.

Every launchpad pays somebody: bonk pays creators, bags pays KOLs, pump.fun pays itself. Nobody pays the trader. This is the first launchpad where the trader — the person who is exit liquidity everywhere else — gets money back.

## Fee flow (who pays, who gets paid)

| Party | Pays | Gets |
|---|---|---|
| Launcher | 1 SOL flat | a launch with no trading-fee drag |
| Trader | nothing (0 trading fees, gasless in ER) | rakeback on realized losses |
| Platform | validator/infra costs | 1 SOL × launches + LP fee share on every graduated token (Meteora position) |
| Platform token | — | its creator fees fund the rakeback pool |

**Structural lock:** the rakeback pool is funded ONLY by the platform token's fees. It is segregated from revenue (launch fees + LP share). Worst case the pool runs dry and rebates pause — the business itself never bleeds.

## The rakeback rule (the one design decision that matters)

Pay a % of **realized losses**, casino-rakeback style. Never pay on volume.

- Bots can't farm losses — farming rakeback means burning money by definition.
- CT can't find the hidden fee, because there isn't one on the trader side.
- It's the strongest emotional frame: every platform farms your losses; this one hands part back.
- Cap per wallet per epoch. Pay from the segregated pool only.

("First platform that pays traders" — Blur and some perp DEXs did trader incentives first. **First launchpad that pays traders** is the defensible claim. Use that one.)

## Architecture (all four pieces have proven precedent in existing repos)

1. **Deposit-escrow, session-key trading.** One L1 approval escrows SOL into the user's delegated PDA; a throwaway session key signs every ER trade after that. Gasless, sub-50ms, no wallet popups. This is the BetSession pattern (BullStakeHouse `session.rs` + `live-bets.ts`) reused verbatim: escrow on L1, ledger-only mutations in the ER, reconcile home.
2. **Ledger claims until migration.** During bonding, buyers hold ledger claims, not SPL tokens. Mint authority never leaves L1; no token CPIs inside the rollup. Claims settle to real tokens at graduation (or on-demand withdrawal).
3. **Graduation crank.** Curve fills → freeze in ER → commit + undelegate → L1 crank creates the Meteora pool, seeds raised SOL + remaining supply, platform keeps the fee-claiming position (revenue stream 2). Standard post-undelegation CPI work; several live launchpads already migrate to Meteora.
4. **Dark bonding, loud graduation.** This is deliberate: while a token bonds in the ER it is invisible to the entire L1 data layer — DexScreener, Photon, copytrade bots, gRPC snipe feeds all go blind. Discovery during bonding happens only on our terminal (human-readable charts on the site; no raw programmatic feed). Graduation to Meteora is the reveal: fully public on L1, announced by our bot, chart born with the bot war already over. Invisibility is the anti-snipe moat AND the reason people camp our terminal.

**Anti-snipe, two layers:** (1) invisibility — the L1 sniping toolchain can't see the curve at all; (2) write-path rules — the only door in is our deposit-escrow + session flow, so first-window per-wallet caps, ordering, and rate limits are program-enforced. The 1 SOL fee separately gates launch spam. "Unsnipable" is an architectural fact, not a marketing claim.

## What's honestly unresolved

- **"Only quality projects"** needs a named gate. 1 SOL filters rug-farms, it doesn't produce quality. Curation (allowlist? stake-to-launch? community jury?) is a social design problem, still open.
- **Distribution.** The model is sound; the war with pump.fun is attention. Founder-market fit is real (we launch tokens daily, we live in Axiom) but the go-to-market is unwritten.
- **MagicBlock RFP alignment.** If their RFP list includes a launchpad/trading item, this becomes a partner-funded build and jumps the queue. Check the bookmarked RFP page and note what it says here.
- **Sequencing.** As of 2026-08-18 the standing commitment is BullStake to mainnet for the MagicBlock partnership. This document exists so the idea is safe to park without losing it.

## Working copy (voice: short, human, present tense)

- Launching costs 1 SOL. Trading costs nothing. Losing pays you back.
- Every launchpad farms you. This one pays you.
- No fees. No snipers. No spam. One SOL and you're live.
- The house takes nothing on the way up.
- Snipers can't snipe what they can't see.
- Bonds in the dark. Graduates in the light.

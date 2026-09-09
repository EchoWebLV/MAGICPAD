#!/usr/bin/env node
/* pump.fun migration for a launch that froze at the 1 SOL line.
 *
 *   node scripts/migrate-pump.mjs <launch id>            dry run: prints the whole plan, sends nothing
 *   node scripts/migrate-pump.mjs <launch id> --confirm  sends it
 *
 * Phases, each idempotent on rerun:
 *   1. create the pump.fun token from scripts/pump-mints/<id>.json (generated
 *      here and persisted BEFORE anything is sent, so the CA is known up
 *      front) with creator = launch.creator and the launch's IPFS metadata,
 *      and pin it on-chain with set_pump_mint (admin).
 *   2. pump_claim for every session that traded: the launch pot funds a
 *      per-session vault which buys the trader's pro-rata share on pump.fun
 *      straight into the trader's wallet. Flat sessions (bought, then sold
 *      everything) get a bookkeeping claim so the count completes.
 *   3. pump_graduate: the remainder becomes a burn buy, residue goes to the
 *      platform, the Mooner mint is sealed, state → GRADUATED.
 *
 * Preconditions checked here: keeper == platform admin, the launch carries
 * the pump marker, state FROZEN/RECONCILED, every session reconciled (the
 * keeper does that — rerun once it has), metadata memo present.
 *
 * env: RPC_URL (mainnet), KEEPER_KEYPAIR (path or JSON array; falls back to
 *      ~/.config/solana/id.json), CU_PRICE (µlamports, default 50000)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, clusterApiUrl,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { loadKeeper, readRecord, writeRecord } from './migrate.mjs';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk'); // CJS only

const { AnchorProvider, Program, Wallet, BN, utils } = anchorPkg;
const bs58 = utils.bytes.bs58;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const MINTS_DIR = path.join(root, 'scripts/pump-mints'); // gitignored (.gitignore:29)
// pump's buyback fee wallet. The SDK keeps CURRENT_FEE_RECIPIENTS_FOR_BUYBACK
// module-private (it is not in dist/index.d.ts) and only exposes
// getStaticRandomFeeRecipientForBuyback(), which picks one at random — a
// deterministic crank must not. This is element [0], the same address as
// litesvm-tests/fixtures/meta.txt buyback_fee_recipient, where every pump
// test in the tree replays the buy against the real mainnet ELF.
const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
const GATEWAY = 'https://tomato-fancy-finch-338.mypinata.cloud/ipfs/'; // apps/web/lib/metadata.ts
const MEMO_RE = /^(?:\[\d+\] )?magicpad:meta:v1:([A-Za-z0-9]+)$/;
const FROZEN = 1, RECONCILED = 2, GRADUATED = 3;
const HAIRCUT_BPS = 150;     // constants.rs PUMP_HAIRCUT_BPS
// Quote against 0.5% less than the budget and pass the budget as max_sol_cost,
// so the cap carries 50 bps of headroom. That is enough because the SDK quote
// is ALL-IN: measured on the captured curve, buying 5,000,000,000,000 tokens
// moved 145,485,555 (curve) + 691,057 (protocol fee) + 691,056 (buyback)
// + 436,457 (creator vault) = 147,304,125 lamports, and
// getBuySolAmountFromTokenAmount returned 147,304,125 — to the lamport. The
// buyback cut is taken OUT of the protocol fee (global.buybackBasisPoints =
// 5000, i.e. half of the 95 bps tier), not on top of it, which is why the
// SDK's protocol+creator model covers it.
const SLACK_BPS = 50;
const MIN_GRADUATE_BUY = 10_000_000; // below 0.01 SOL the remainder is not worth a buy
// Measured (design spec "Compute"): a funded pump_graduate is 145,861 CU
// (136,775 when the vault ATA already exists; an amount = 0 graduate 26,076)
// and a funded pump_claim ≈151k — 400k is ≈2.7× headroom over the worst case.
const CU_LIMIT = 400_000;
const SESSION_DISC = Buffer.from(idl.accounts.find((a) => a.name === 'TradeSession').discriminator);
const ERR = (name) => idl.errors.find((e) => e.name === name)?.code;
const E_POT_TOO_SMALL = ERR('PotTooSmall');

const id = Number(process.argv[2]);
const confirm = process.argv.includes('--confirm');
if (!Number.isInteger(id) || id < 0) {
  console.error('usage: node scripts/migrate-pump.mjs <launch id> [--confirm]');
  process.exit(1);
}

const keeper = loadKeeper();
const conn = new Connection(process.env.RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
const provider = new AnchorProvider(conn, new Wallet(keeper), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const launch = pda(Buffer.from('launch'), le8(id));
const moonerMint = pda(Buffer.from('mint'), le8(id));
const pump = pda(Buffer.from('pump'), le8(id));
const sessionVault = (trader) => pda(Buffer.from('pumpvault'), le8(id), trader.toBuffer());
const launchVault = pda(Buffer.from('pumpvault'), le8(id));
const ata = (owner, mint) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const tok = (n) => (Number(n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

/** true when a failed send carries our program's error `code` */
function isProgramError(e, code) {
  if (code == null) return false;
  const text = [e?.message ?? '', ...(e?.logs ?? [])].join('\n').toLowerCase();
  return text.includes(`custom program error: 0x${code.toString(16)}`)
    || text.includes(`error number: ${code}`);
}

async function send(ixs, signers, label) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.CU_PRICE || 50_000) }),
    ...ixs,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  log(`✓ ${label} ${sig}`);
  return sig;
}

function loadOrMakeMint() {
  fs.mkdirSync(MINTS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(MINTS_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + '\n', { mode: 0o600 });
  log(`new mint keypair persisted at ${path.relative(root, file)}`);
  return kp;
}

/** The launch's metadata URI: newest creator-signed memo on the launch PDA,
 *  verified to resolve (same rule as apps/web/lib/metadata.ts). */
async function metadataUri(creator) {
  const sigs = await conn.getSignaturesForAddress(launch, { limit: 100 }, 'confirmed');
  for (const s of sigs.filter((x) => !x.err && x.memo && MEMO_RE.test(x.memo))) {
    const cid = MEMO_RE.exec(s.memo)[1];
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    if (!keys[0].equals(creator)) continue;
    const uri = GATEWAY + cid;
    const ok = await fetch(uri, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    if (ok) return uri;
    log(`memo ${cid} does not resolve at the gateway — trying an older one`);
  }
  return null;
}

/** pump-side accounts for a buy signed by `user`, in the program's field names */
function pumpSide(pumpMint, creator, user, global) {
  const bc = sdk.bondingCurvePda(pumpMint);
  return {
    pumpGlobal: sdk.GLOBAL_PDA,
    pumpFeeRecipient: global.feeRecipient,
    pumpBondingCurve: bc,
    pumpAssociatedBondingCurve: ata(bc, pumpMint),
    pumpCreatorVault: sdk.creatorVaultPda(creator),
    pumpEventAuthority: sdk.PUMP_EVENT_AUTHORITY_PDA,
    pumpProgram: sdk.PUMP_PROGRAM_ID,
    pumpGlobalVolumeAccumulator: sdk.GLOBAL_VOLUME_ACCUMULATOR_PDA,
    pumpUserVolumeAccumulator: sdk.userVolumeAccumulatorPda(user),
    pumpFeeConfig: sdk.PUMP_FEE_CONFIG_PDA,
    pumpFeeProgram: sdk.PUMP_FEE_PROGRAM_ID,
    pumpBondingCurveV2: sdk.bondingCurveV2Pda(pumpMint),
    pumpBuybackFeeRecipient: BUYBACK,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

async function main() {
  log(`keeper ${keeper.publicKey.toBase58()} · ${conn.rpcEndpoint} · launch ${id} · ${confirm ? 'CONFIRM' : 'dry run'}`);

  // ---- preconditions ----
  const platform = await program.account.platform.fetch(PLATFORM);
  if (!platform.admin.equals(keeper.publicKey)) die(`keeper is not the platform admin (${platform.admin.toBase58()})`);
  let pumpAcc = await program.account.pumpLaunch.fetchNullable(pump);
  if (!pumpAcc) die(`launch ${id} has no pump marker — it graduates on Meteora (scripts/migrate.mjs)`);
  let l = await program.account.launch.fetch(launch);
  if (l.state === GRADUATED) { log(`launch ${id} is already GRADUATED — nothing to do`); return; }
  if (l.state !== FROZEN && l.state !== RECONCILED) die(`launch ${id} is still bonding (state ${l.state})`);

  const raw = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SESSION_DISC) } },
      { memcmp: { offset: 8, bytes: bs58.encode(le8(id)) } },
    ],
  });
  const sessions = raw.map((r) => ({ pubkey: r.pubkey, s: program.coder.accounts.decode('tradeSession', r.account.data) }));
  const pending = sessions.filter((x) => !x.s.reconciled);
  if (pending.length) die(`${pending.length} session(s) not reconciled yet — the keeper does that; rerun afterwards`);
  const settled = l.state === RECONCILED || l.sessionsReconciled.eq(l.sessionsOpened);
  if (!settled) die(`launch not settled: ${l.sessionsReconciled}/${l.sessionsOpened} sessions reconciled`);

  const creator = l.creator;
  const mintKp = loadOrMakeMint();
  const pumpMint = mintKp.publicKey;
  console.log(`\n  CA (pump.fun mint): ${pumpMint.toBase58()}`);
  console.log(`  creator:            ${creator.toBase58()}`);
  console.log(`  name/symbol:        ${l.name} / ${l.symbol}\n`);

  const online = new sdk.OnlinePumpSdk(conn);
  const offline = new sdk.PumpSdk();
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  // `mintSupply` only feeds the fee-tier market-cap lookup, and for a
  // non-mayhem coin pump prices that off the fixed 1e9 supply — which is
  // exactly global.tokenTotalSupply. A null curve makes the SDK synthesise a
  // fresh one, the right preview for a token that does not exist yet.
  const quote = (bondingCurve, lamports) => sdk.getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: bondingCurve ? global.tokenTotalSupply : null,
    bondingCurve, amount: new BN(Math.max(0, Math.floor(lamports))), quoteMint: NATIVE_MINT,
  });
  const liveCurve = async () => {
    const info = await conn.getAccountInfo(sdk.bondingCurvePda(pumpMint), 'confirmed').catch(() => null);
    return info ? offline.decodeBondingCurveNullable(info) : null;
  };

  // ---- phase 1: create + set_pump_mint ----
  if (pumpAcc.pumpMint.equals(PublicKey.default)) {
    const bcAddr = sdk.bondingCurvePda(pumpMint);
    const bcInfo = await conn.getAccountInfo(bcAddr, 'confirmed');
    const curve = bcInfo ? offline.decodeBondingCurveNullable(bcInfo) : null;
    // an account that is there but will not decode must never be created over
    if (bcInfo && !curve) die(`${bcAddr.toBase58()} exists but does not decode as a pump BondingCurve — refusing to create over it`);
    const uri = await metadataUri(creator);
    if (!uri) die('no creator-signed metadata memo on the launch — retrofit metadata first (launch page → "add face")');
    log(`metadata ${uri}`);
    const ixs = [];
    const signers = [keeper];
    if (curve) {
      log(`bonding curve for ${pumpMint.toBase58()} already exists — skipping create`);
      // the curve we just read is derived from the persisted keypair's pubkey,
      // so it is that mint's curve by construction — but assert the mint account
      // itself is real, so a stray curve can never stand in for a token we
      // never created
      const mintInfo = await conn.getAccountInfo(pumpMint, 'confirmed');
      if (!mintInfo || !mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
        die(`bonding curve exists but ${pumpMint.toBase58()} is not an SPL mint — scripts/pump-mints/${id}.json is not this curve's mint`);
      }
      if (!curve.creator.equals(creator)) die(`existing curve creator ${curve.creator.toBase58()} != launch creator`);
      // set_pump_mint rejects a completed curve (pump.rs:110) and the pin is
      // one-shot — fail here rather than burning the attempt on-chain
      if (curve.complete) die(`the pump.fun curve for ${pumpMint.toBase58()} has already completed — it cannot be pinned or bought`);
    } else {
      ixs.push(await offline.createInstruction({
        mint: pumpMint, name: l.name, symbol: l.symbol, uri, creator, user: keeper.publicKey,
      }));
      signers.push(mintKp);
    }
    ixs.push(await program.methods.setPumpMint().accountsPartial({
      admin: keeper.publicKey, platform: PLATFORM, launch, pump,
      pumpMint, pumpBondingCurve: bcAddr,
    }).instruction());
    if (confirm) {
      await send(ixs, signers, `create ${l.symbol} on pump.fun + set_pump_mint`);
      pumpAcc = await program.account.pumpLaunch.fetch(pump);
    } else {
      log(`[dry] would ${curve ? '' : 'create the pump token and '}set_pump_mint (${signers.length} signer(s))`);
    }
  } else {
    if (!pumpAcc.pumpMint.equals(pumpMint)) die(`on-chain pump mint ${pumpAcc.pumpMint.toBase58()} != scripts/pump-mints/${id}.json — do not mix keypairs`);
    log(`pump mint already set: ${pumpMint.toBase58()}`);
  }

  // ---- phase 2: pump_claim per session ----
  const launchAcc = await conn.getAccountInfo(launch);
  const rentMin = await conn.getMinimumBalanceForRentExemption(launchAcc.data.length);
  // the RAW flip pot, exactly as pot_available reads it (pump_vault.rs:30) —
  // migrate.mjs's old-format fingerprint would over-budget the claims here
  const flipPot = l.flipPot.isNeg() ? 0 : l.flipPot.toNumber();
  const allowance = (await conn.getMinimumBalanceForRentExemption(165))
    + (await conn.getMinimumBalanceForRentExemption(137))
    + (await conn.getMinimumBalanceForRentExemption(0));
  // TWO readers, because the two instructions reserve different things:
  // pump_claim reserves the flip pot (pump.rs:257) and pump_graduate reserves
  // nothing (pump.rs:446) — graduation is what burns the pot.
  const potForClaims = () => conn.getBalance(launch).then((b) => b - rentMin - flipPot);
  const potForGraduate = () => conn.getBalance(launch).then((b) => b - rentMin);

  const traded = sessions.filter((x) => x.s.solSpent.gtn(0));
  const holders = traded.filter((x) => x.s.tokensHeld.gtn(0) && !x.s.tokensClaimed)
    // cheapest average entry claims first — they paid least on Mooner, they pay least on pump
    .sort((a, b) => a.s.costBasis.mul(b.s.tokensHeld).cmp(b.s.costBasis.mul(a.s.tokensHeld)));
  const flat = traded.filter((x) => x.s.tokensHeld.isZero() && !x.s.tokensClaimed);
  const skipped = sessions.length - traded.length;
  const totalHeld = holders.reduce((acc, x) => acc.add(x.s.tokensHeld), new BN(0));
  const claimPot0 = await potForClaims();
  const gradPot0 = await potForGraduate();
  const spendable = claimPot0 - holders.length * allowance;
  log(`pot ${sol(claimPot0)} for claims (launch − rent − flip pot ${sol(flipPot)}), ${sol(gradPot0)} for graduation · ${holders.length} holder(s), ${flat.length} flat, ${skipped} never traded · already claimed ${sessions.filter((x) => x.s.tokensClaimed).length}`);
  if (holders.length && spendable <= 0) die(`pot cannot cover ${holders.length} claim allowance(s) of ${sol(allowance)}`);

  const budgetFor = (held, pool, heldTotal) => (heldTotal.isZero() ? 0
    : Math.floor(pool * held.toNumber() / heldTotal.toNumber()));

  const sigs = [];
  const previewCurve = confirm ? null : await liveCurve();
  // what the claims will take out of the launch, worst case: the whole cap
  // plus the whole allowance for each. Feeds the dry-run graduate preview.
  let predictedClaimSpend = 0;
  // live re-slice state for the PotTooSmall retry
  let remainingHeld = totalHeld;
  let remainingHolders = holders.length;

  for (const { pubkey, s } of holders) {
    const budget = budgetFor(s.tokensHeld, spendable, totalHeld);
    const ceiling = s.tokensHeld.muln(10_000 - HAIRCUT_BPS).divn(10_000);
    const curve = confirm ? await liveCurve() : previewCurve; // re-quote against the live curve before every send
    const quoted = quote(curve, Math.floor(budget * (10_000 - SLACK_BPS) / 10_000));
    const amount = BN.min(ceiling, quoted);
    const share = (s.tokensHeld.toNumber() / totalHeld.toNumber() * 100).toFixed(2);
    console.log(`  ${s.trader.toBase58()}  held ${tok(s.tokensHeld)} (${share}%)  budget ${sol(budget)}  → buy ${tok(amount)} ${l.symbol}${amount.eq(ceiling) ? ' (at the 98.5% ceiling)' : ''}`);
    if (amount.isZero()) die(`budget ${sol(budget)} quotes 0 tokens for ${s.trader.toBase58()} — pot too thin to migrate`);
    predictedClaimSpend += budget + allowance;
    if (!confirm) continue;
    const vault = sessionVault(s.trader);
    const claimIx = (amt, cap) => program.methods.pumpClaim(amt, new BN(cap)).accountsPartial({
      cranker: keeper.publicKey, platform: PLATFORM, trader: s.trader, launch, pump, session: pubkey, vault,
      pumpMint, traderAta: ata(s.trader, pumpMint),
      ...pumpSide(pumpMint, creator, vault, global),
    }).instruction();
    const label = (amt, cap) => `pump_claim ${s.trader.toBase58().slice(0, 8)}… ${tok(amt)} ≤ ${sol(cap)}`;
    try {
      sigs.push(await send([await claimIx(amount, budget)], [keeper], label(amount, budget)));
    } catch (e) {
      if (!isProgramError(e, E_POT_TOO_SMALL)) throw e;
      // the pot moved under us (an earlier claim cost more than its cap
      // reserved, or fees drained it). Re-slice against what is actually
      // there and try once more — then give up loudly.
      const fresh = await potForClaims();
      const freshSpendable = fresh - remainingHolders * allowance;
      const retry = Math.min(
        budgetFor(s.tokensHeld, freshSpendable, remainingHeld),
        fresh - allowance,
      );
      log(`PotTooSmall at ${sol(budget)}: pot is ${sol(fresh)}, re-slicing to ${sol(retry)} across ${remainingHolders} holder(s)`);
      if (retry <= 0) die(`pot ${fresh} lamports cannot cover the allowance ${allowance} for ${s.trader.toBase58()}`);
      const curve2 = await liveCurve();
      const amount2 = BN.min(ceiling, quote(curve2, Math.floor(retry * (10_000 - SLACK_BPS) / 10_000)));
      if (amount2.isZero()) die(`re-quote at ${retry} lamports buys 0 tokens for ${s.trader.toBase58()} — the pot is exhausted`);
      try {
        sigs.push(await send([await claimIx(amount2, retry)], [keeper], label(amount2, retry)));
      } catch (e2) {
        console.error(e2.logs ? e2.logs.join('\n') : '');
        die(`pump_claim ${s.trader.toBase58()} failed twice: budget ${budget} then ${retry}, pot ${fresh}, allowance ${allowance}, amounts ${amount} then ${amount2} — ${e2.message ?? e2}`);
      }
    }
    remainingHeld = remainingHeld.sub(s.tokensHeld);
    remainingHolders -= 1;
  }
  for (const { pubkey, s } of flat) {
    console.log(`  ${s.trader.toBase58()}  flat (sold out)  → bookkeeping claim`);
    if (!confirm) continue;
    const vault = sessionVault(s.trader);
    // the flat path never touches the pot: tokens_held == 0 only requires
    // amount == 0 (pump.rs:247), so (0, 0) is the whole instruction
    sigs.push(await send([await program.methods.pumpClaim(new BN(0), new BN(0)).accountsPartial({
      cranker: keeper.publicKey, platform: PLATFORM, trader: s.trader, launch, pump, session: pubkey, vault,
      pumpMint, traderAta: ata(s.trader, pumpMint),
      ...pumpSide(pumpMint, creator, vault, global),
    }).instruction()], [keeper], `pump_claim ${s.trader.toBase58().slice(0, 8)}… (flat)`));
  }

  // ---- phase 3: pump_graduate ----
  if (confirm) pumpAcc = await program.account.pumpLaunch.fetch(pump);
  const claimsAfter = confirm ? pumpAcc.claimsDone.toNumber() : pumpAcc.claimsDone.toNumber() + holders.length + flat.length;
  if (claimsAfter !== l.sessionsOpened.toNumber()) {
    die(`claims ${claimsAfter}/${l.sessionsOpened} — a session is missing; check getProgramAccounts against the ER stragglers`);
  }
  // graduation may spend the flip pot, so the remainder is read off
  // potForGraduate — dry run subtracts the claim spends it just predicted,
  // which is a FLOOR (every claim was charged its full cap and allowance).
  const remaining = confirm ? await potForGraduate() : gradPot0 - predictedClaimSpend;
  let gAmount = new BN(0);
  let gMax = 0;
  let why = `below ${sol(MIN_GRADUATE_BUY)}`;
  if (remaining - allowance >= MIN_GRADUATE_BUY) {
    gMax = remaining - allowance;
    const curve = confirm ? await liveCurve() : previewCurve;
    gAmount = quote(curve, Math.floor(gMax * (10_000 - SLACK_BPS) / 10_000));
    // pump_graduate rejects amount == 0 with a non-zero cap (BadQuote,
    // pump.rs:509), so a dead quote must zero the cap too
    if (gAmount.isZero()) {
      why = curve && curve.virtualTokenReserves.isZero() ? 'the curve has migrated off pump.fun'
        : curve && curve.complete ? 'the curve has completed'
          : `${sol(gMax)} quotes 0 tokens`;
      gMax = 0;
    }
  }
  console.log(`  graduate: remainder ${sol(remaining)}${confirm ? '' : ' (floor)'} → ${gAmount.isZero() ? `no burn buy (${why})` : `buy + burn ≥ ${tok(gAmount)} ${l.symbol} ≤ ${sol(gMax)}`}, residue → platform, Mooner mint sealed`);
  if (!confirm) {
    console.log(`\n[dry] nothing sent. Rerun with --confirm to execute.\n`);
    return;
  }
  // the burn is "whatever the vault ATA holds", not `amount` (pump.rs:480) —
  // read the supply on both sides instead of assuming the delta
  const supplyBefore = await conn.getTokenSupply(pumpMint).then((r) => BigInt(r.value.amount)).catch(() => null);
  sigs.push(await send([await program.methods.pumpGraduate(gAmount, new BN(gMax)).accountsPartial({
    admin: keeper.publicKey, platform: PLATFORM, launch, pump, mint: moonerMint,
    vault: launchVault, vaultAta: ata(launchVault, pumpMint), pumpMint,
    ...pumpSide(pumpMint, creator, launchVault, global),
  }).instruction()], [keeper], `pump_graduate ${tok(gAmount)} ≤ ${sol(gMax)}`));

  const record = readRecord();
  record[moonerMint.toBase58()] = {
    kind: 'pump', pumpMint: pumpMint.toBase58(), creator: creator.toBase58(),
    launchId: id, sigs, at: new Date().toISOString(),
  };
  writeRecord(record);
  l = await program.account.launch.fetch(launch);
  const supplyAfter = await conn.getTokenSupply(pumpMint).then((r) => BigInt(r.value.amount)).catch(() => null);
  const burnt = supplyBefore != null && supplyAfter != null ? supplyBefore - supplyAfter : null;
  log(`launch ${id} state ${l.state} (${l.state === GRADUATED ? 'GRADUATED' : 'NOT graduated — check the tx'})`
    + ` · pump supply ${supplyAfter ?? '?'}${burnt != null ? ` (burnt ${tok(burnt)} ${l.symbol})` : ''}`
    + ` · https://pump.fun/coin/${pumpMint.toBase58()}`);
}

main().catch((e) => { console.error(e.logs ? e.logs.join('\n') : ''); die(e.message ?? e); });

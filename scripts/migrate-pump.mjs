#!/usr/bin/env node
/* pump.fun migration for a launch that froze at the 1 SOL line.
 *
 *   node scripts/migrate-pump.mjs <launch id>            dry run: prints the whole plan, sends nothing
 *   node scripts/migrate-pump.mjs <launch id> --confirm  sends it
 *
 * Operator overrides, for a holder whose claim will not land at the budget the
 * pro-rata rule picks. One un-landable claim blocks graduation forever
 * (pump_graduate needs claims_done == sessions_opened, pump.rs:415-418) and
 * amount = 0 is NOT an escape hatch for a funded session (pump.rs:249), so the
 * only lever is a smaller amount:
 *   --only <trader>                              phase 2 cranks that session alone, phase 3 is skipped
 *   --amount <raw tokens> --max-sol <lamports>   replaces the budget rule for it (needs --only)
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
// what claim_allowance() charges, byte for byte: the trader's ATA
// (TokenAccount::LEN), pump's user_volume_accumulator (PUMP_UVA_LEN) and the
// creator vault's rent-exempt minimum for 0 bytes
const ATA_LEN = 165; // TokenAccount::LEN, pump_vault.rs:25
const UVA_LEN = 137; // PUMP_UVA_LEN, pump_vault.rs:15
// Measured against the real mainnet pump ELF (litesvm-tests/tests/pump.rs,
// TransactionMetadata::compute_units_consumed): a funded pump_claim ranges
// 139,997–168,497 CU over 20 runs (mean 148,247, median 146,747) — every
// sample is congruent to 497 mod 1,500, i.e. the spread is find_program_address
// bump-search depth at 1,500 CU per failed step, not variance in the
// instruction — a pump_graduate 145,861 (deterministic) and a flat claim
// 27,310. 400,000 is 2.37× the observed worst case.
const CU_LIMIT = 400_000;
const SESSION_DISC = Buffer.from(idl.accounts.find((a) => a.name === 'TradeSession').discriminator);
const ERR = (name) => idl.errors.find((e) => e.name === name)?.code;
const E_POT_TOO_SMALL = ERR('PotTooSmall');

const USAGE = 'usage: node scripts/migrate-pump.mjs <launch id> [--confirm]'
  + ' [--only <trader> [--amount <raw tokens> --max-sol <lamports>]]';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagVal = (f) => (has(f) ? argv[argv.indexOf(f) + 1] ?? '' : null);
const id = Number(argv[0]);
const confirm = has('--confirm');
const usageDie = (msg) => { console.error(`✗ ${msg}\n${USAGE}`); process.exit(1); };
if (!Number.isInteger(id) || id < 0) {
  console.error(USAGE);
  process.exit(1);
}
// Operator overrides (I4). Parsed and cross-checked here, before the keeper
// keypair is loaded and before the first RPC, so a bad flag combination costs
// nothing and fetches nothing.
let only = null, ovAmount = null, ovMaxSol = null;
if (has('--only')) {
  const raw = flagVal('--only');
  try { only = new PublicKey(raw); } catch { usageDie(`--only needs a base58 trader pubkey, got "${raw}"`); }
}
if (has('--amount') !== has('--max-sol')) {
  usageDie('--amount and --max-sol go together — pass both or neither');
}
if (has('--amount')) {
  if (!only) usageDie('--amount/--max-sol replace the budget rule for ONE session, so they need --only <trader>');
  const a = flagVal('--amount'), m = flagVal('--max-sol');
  if (!/^\d+$/.test(a)) usageDie(`--amount needs raw token units (6 decimals), got "${a}"`);
  if (!/^\d+$/.test(m)) usageDie(`--max-sol needs lamports, got "${m}"`);
  ovAmount = new BN(a);
  ovMaxSol = Number(m);
  if (!Number.isSafeInteger(ovMaxSol)) usageDie(`--max-sol ${m} is out of range`);
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

/** true when a failed send carries our program's error `code`.
 *  `e.logs` is a DEPRECATED @solana/web3.js getter (1.98.4,
 *  lib/index.cjs.js:2195 "@deprecated Use await getLogs() instead") that hands
 *  back the cached array only while it is not still a promise — so read the
 *  underlying `e.transactionLogs` too. The message also embeds the RPC's
 *  "custom program error: 0x…" for a preflight failure, which is the arm that
 *  actually fires today. */
function isProgramError(e, code) {
  if (code == null) return false;
  const logs = e?.logs ?? e?.transactionLogs ?? [];
  const text = [e?.message ?? '', ...(Array.isArray(logs) ? logs : [])].join('\n').toLowerCase();
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
 *  verified to resolve as a JSON object — the same rule as
 *  apps/web/lib/metadata.ts:131-133, which is stricter than `r.ok`: a gateway
 *  answering 200 with an HTML error page must never be pinned into the pump
 *  token's `uri`, because that pin is permanent. (The web stops after three
 *  candidate memos, metadata.ts:122; the CLI walks every matching memo.) */
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
    const json = await fetch(uri, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (json && typeof json === 'object') return uri;
    log(`memo ${cid} does not resolve to a JSON object at the gateway — trying an older one`);
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
  // I3: once the launch is pinned, the mint address comes from chain. Phases 2
  // and 3 never need the SECRET — mintKp only signs pump's `create` — so a
  // scripts/pump-mints/<id>.json that was lost (the directory is gitignored by
  // design, so it lives on one machine with no backup) must not strand a
  // migration whose money is already committed.
  const pinned = !pumpAcc.pumpMint.equals(PublicKey.default);
  const mintKp = pinned ? null : loadOrMakeMint();
  const pumpMint = pinned ? pumpAcc.pumpMint : mintKp.publicKey;
  if (pinned) {
    // a leftover file from a different launch/attempt is not fatal any more —
    // it is simply not used — but say so loudly so it is never reused
    const file = path.join(MINTS_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      let stale = null;
      // the file is not needed, so nothing about it may be fatal — not even a
      // corrupt one
      try { stale = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')))).publicKey; }
      catch { console.warn(`\n  ⚠ ${path.relative(root, file)} will not parse as a keypair — ignored; the mint comes from chain.\n`); }
      if (stale && !stale.equals(pumpMint)) {
        console.warn(`\n  ⚠⚠ WARNING: ${path.relative(root, file)} holds ${stale.toBase58()}, but launch ${id}`
          + ` is pinned on-chain to ${pumpMint.toBase58()}. That file is STALE and UNUSED — this run reads the`
          + ` mint from chain. Do not mix it into another launch.\n`);
      }
    }
  }
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
  if (!pinned) {
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
        // the only surviving "do not mix keypairs" fatal: unpinned launch, but
        // the keypair we hold already has a curve that is not its own token
        die(`bonding curve exists but ${pumpMint.toBase58()} is not an SPL mint — scripts/pump-mints/${id}.json is not this curve's mint; do not mix keypairs`);
      }
      if (!curve.creator.equals(creator)) die(`existing curve creator ${curve.creator.toBase58()} != launch creator`);
      // set_pump_mint rejects a completed curve (pump.rs:110) and the pin is
      // one-shot — fail here rather than burning the attempt on-chain
      if (curve.complete) die(`the pump.fun curve for ${pumpMint.toBase58()} has already completed — it cannot be pinned or bought`);
    } else {
      // `createInstruction` is @deprecated in the SDK (its sdk.ts:309-311 says
      // "Use `createV2Instruction` instead"), and staying on it is deliberate:
      // the design spec mandates pump v1 `create`
      // (docs/superpowers/specs/2026-09-09-pump-migration-design.md — the
      // "v1 `create`" bullet in `## Hard facts` and step (2) of `## CLI`).
      // create_v2 mints Token-2022 with ImmutableOwner ATAs, which is not the
      // coin type this migration wants. Do not "fix" the deprecation warning.
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
    log(`pump mint already set on chain: ${pumpMint.toBase58()} — the keypair file is not needed from here`);
  }

  // ---- phase 2: pump_claim per session ----
  const launchAcc = await conn.getAccountInfo(launch);
  const rentMin = await conn.getMinimumBalanceForRentExemption(launchAcc.data.length);
  // the RAW flip pot, exactly as pot_available reads it (pump_vault.rs:30) —
  // migrate.mjs's old-format fingerprint would over-budget the claims here
  const flipPot = l.flipPot.isNeg() ? 0 : l.flipPot.toNumber();
  // claim_allowance() to the lamport (pump_vault.rs:23-26)
  const allowance = (await conn.getMinimumBalanceForRentExemption(ATA_LEN))
    + (await conn.getMinimumBalanceForRentExemption(UVA_LEN))
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
  // I4: --only names one session; it has to exist and still be crankable, and
  // the check runs off the same discovered list phase 2 iterates.
  if (only) {
    const hit = sessions.find((x) => x.s.trader.equals(only));
    if (!hit) {
      die(`--only ${only.toBase58()} has no session on launch ${id}. Discovered traders:\n`
        + sessions.map((x) => `      ${x.s.trader.toBase58()}`).join('\n'));
    }
    if (hit.s.tokensClaimed) die(`--only ${only.toBase58()} has already claimed (tokens_claimed) — nothing to crank`);
    if (hit.s.solSpent.isZero()) die(`--only ${only.toBase58()} never bought (sol_spent 0) — sessions_opened never counted it, so there is nothing to claim`);
    if (ovAmount && hit.s.tokensHeld.isZero()) {
      die(`--only ${only.toBase58()} is a flat session (tokens_held 0): pump_claim requires amount == 0 there`
        + ` (pump.rs:245-247), so --amount/--max-sol do not apply — rerun with --only alone`);
    }
  }
  // the pro-rata denominator stays over EVERY unclaimed holder even under
  // --only, so the holders that are not being cranked keep their share and
  // their allowance reserved
  const totalHeld = holders.reduce((acc, x) => acc.add(x.s.tokensHeld), new BN(0));
  const claimPot0 = await potForClaims();
  const gradPot0 = await potForGraduate();
  const spendable = claimPot0 - holders.length * allowance;
  log(`pot ${sol(claimPot0)} for claims (launch − rent − flip pot ${sol(flipPot)}), ${sol(gradPot0)} for graduation · ${holders.length} holder(s), ${flat.length} flat, ${skipped} never traded · already claimed ${sessions.filter((x) => x.s.tokensClaimed).length}`);
  if (holders.length && spendable <= 0) die(`pot cannot cover ${holders.length} claim allowance(s) of ${sol(allowance)}`);

  // I5: every input to the completeness check is already in hand, so run it
  // BEFORE the first claim rather than after the last. A session PDA that
  // getProgramAccounts missed (a paginating or rate-limited RPC is the
  // realistic cause) means the launch can never reach GRADUATED — and the
  // operator should learn that before N claims have spent the pot.
  const predicted = pumpAcc.claimsDone.toNumber() + holders.length + flat.length;
  if (predicted !== l.sessionsOpened.toNumber()) {
    const msg = `plan covers ${predicted}/${l.sessionsOpened} sessions`
      + ` (claims_done ${pumpAcc.claimsDone} + ${holders.length} holder(s) + ${flat.length} flat)`
      + ` — a session is missing; check getProgramAccounts against the ER stragglers`;
    if (only) console.warn(`  ⚠ ${msg} — warning only under --only, which never graduates`);
    else die(`${msg}. Refusing to send.`);
  }
  if (only) {
    console.log(`\n  *** --only ${only.toBase58()}: PHASE 2 CRANKS THAT SESSION ALONE AND PHASE 3`
      + ` (pump_graduate) IS SKIPPED. Rerun without flags once every session has claimed. ***`);
  }
  if (ovAmount) {
    console.log(`  *** OVERRIDE: AMOUNT ${ovAmount} RAW (${tok(ovAmount)} ${l.symbol}), MAX_SOL ${ovMaxSol}`
      + ` LAMPORTS (${sol(ovMaxSol)}) — THE PRO-RATA BUDGET RULE IS NOT USED FOR THIS SESSION ***`);
  }
  if (!confirm) {
    console.log(`\n  dry run: every budget below is one static slice of the pot as it stands now (${sol(claimPot0)}),`);
    console.log(`  and every token count is a curve-advanced estimate. The live run re-quotes against the real`);
    console.log(`  curve before each send, and re-slices a freshly read pot before each claim, so each claim's`);
    console.log(`  unspent slack flows to the holders still waiting — which makes every budget below except the`);
    console.log(`  first a FLOOR, not a promise.`);
  }

  // `pool * held` reaches ~1.4e22 on a 1◎ raise, past Number.MAX_SAFE_INTEGER
  // (9.007e15). Left in this order deliberately: IEEE-754 keeps the relative
  // error at <= 2^-53, i.e. under 1e-7 lamports on a budget of this size, so
  // the floor only ever lands on a different integer within 1e-7 of a
  // boundary — and the pot carries ~0.012◎ of real slack besides. Reordering
  // to Math.floor(pool * (held / heldTotal)) rounds twice as well: same bound.
  const budgetFor = (held, pool, heldTotal) => (heldTotal.isZero() ? 0
    : Math.floor(pool * held.toNumber() / heldTotal.toNumber()));

  /** why a quote came back zero — shared by the claim and graduate paths, so a
   *  third party completing the curve after the CA goes public is never
   *  reported as "pot too thin". bondingCurve.ts:101-103 returns 0 when
   *  virtualTokenReserves == 0 (migrated) and bondingCurve.ts:131's
   *  BN.min(tokensReceived, realTokenReserves) returns 0 on a completed one. */
  const zeroQuoteWhy = (c, lamports) =>
    (c && c.virtualTokenReserves.isZero() ? 'the curve has migrated off pump.fun'
      : c && c.complete ? 'the curve has completed'
        : `${sol(lamports)} is too thin to buy a single token`);

  const sigs = [];
  // I2: ONE preview curve for the whole dry run, advanced by each planned buy,
  // so holder k is quoted against the curve holders 1..k-1 left behind. Before
  // phase 1 the curve does not exist; seed it from the SDK's own
  // newBondingCurve rather than passing null, because a null makes every
  // single quote synthesise a FRESH curve (bondingCurve.ts:94-98) and holder 2
  // is then priced as if holder 1 never bought. The seeded curve carries
  // `creator`, because the SDK only charges the 30 bps creator fee when
  // bondingCurve.creator != PublicKey.default (bondingCurve.ts:114-118) and
  // the coin phase 1 creates will carry launch.creator.
  let previewCurve = confirm ? null
    : (await liveCurve()) ?? { ...sdk.newBondingCurve(global, NATIVE_MINT), creator };
  /** Advance a local curve copy the way pump's `buy` does: fees ride on top of
   *  the curve leg and never enter the reserves, so the only quantity that
   *  moves the reserves is the SDK's own getBuySolAmountFromTokenAmountQuote
   *  (bondingCurve.ts:39-42):
   *    minAmount.mul(virtualQuoteReserves).div(virtualTokenReserves.sub(minAmount)).add(new BN(1))
   *  Checked numerically against the captured oracle curve (virtual_token
   *  1,054,308,754,019,894 / virtual_sol 30,531,853,101): buying
   *  5,000,000,000,000 tokens gives 145,485,555 lamports — exactly the curve
   *  leg the on-chain oracle measured (see the SLACK_BPS comment above).
   *  Dry run only; --confirm re-reads the real curve before every send. */
  const advance = (c, amount) => {
    if (!c || amount.isZero()) return c;
    const bought = BN.min(amount, c.realTokenReserves);
    const leg = bought.mul(c.virtualQuoteReserves).div(c.virtualTokenReserves.sub(bought)).addn(1);
    return {
      ...c,
      virtualQuoteReserves: c.virtualQuoteReserves.add(leg),
      virtualTokenReserves: c.virtualTokenReserves.sub(bought),
      realQuoteReserves: c.realQuoteReserves.add(leg),
      realTokenReserves: c.realTokenReserves.sub(bought),
    };
  };
  // what the claims will take out of the launch, worst case: the whole cap
  // plus the whole allowance for each. Feeds the dry-run graduate preview.
  let predictedClaimSpend = 0;
  // live re-slice state: the holders still waiting, and what they hold
  let remainingHeld = totalHeld;
  let remainingHolders = holders.length;

  for (const { pubkey, s } of holders) {
    // --only: skip before any RPC and before the re-slice state moves, so the
    // target's slice is still its share of the whole remaining field
    if (only && !s.trader.equals(only)) continue;
    // I1: --confirm re-reads the pot before EVERY claim and slices it across
    // the holders still waiting, so the slack each claim leaves behind — the
    // user_volume_accumulator rent comes back through
    // close_user_volume_accumulator, and the buy lands up to SLACK_BPS under
    // its cap — flows to them instead of being burnt at graduation.
    // Sigma(budget + allowance) <= pot still holds by construction: this
    // holder's slice is floor(pool_now * held / remainingHeld) of a pool that
    // already has remainingHolders * allowance — this holder's own included —
    // taken out, and held <= remainingHeld, so budget + allowance <= pool_now
    // (what pump.rs:255-259 requires) and at least (remainingHolders - 1)
    // allowances survive for the rest.
    // The dry run deliberately keeps the ONE static claimPot0/totalHeld slice:
    // it cannot know the slack, so its budgets are a floor (said in the header).
    const pool = confirm ? await potForClaims() : claimPot0;
    const spendableNow = confirm ? pool - remainingHolders * allowance : spendable;
    const ceiling = s.tokensHeld.muln(10_000 - HAIRCUT_BPS).divn(10_000);
    let budget = budgetFor(s.tokensHeld, spendableNow, confirm ? remainingHeld : totalHeld);
    let amount;
    let curve = null;
    if (ovAmount) {
      // I4: the operator's numbers replace the budget rule for this one
      // session. Enforce the program's own bounds HERE rather than discovering
      // them through a failed send.
      if (ovAmount.isZero()) {
        die(`--amount 0 is rejected on chain for a funded session: pump_claim requires amount > 0 when`
          + ` tokens_held > 0 (pump.rs:249, BadQuote). amount = 0 is only the flat/bookkeeping claim.`);
      }
      if (ovAmount.gt(ceiling)) {
        die(`--amount ${ovAmount} exceeds the 98.5% ceiling ${ceiling} for ${s.trader.toBase58()}`
          + ` (pump.rs:250-252, ClaimTooLarge)`);
      }
      // `pool` is this iteration's pot: a fresh potForClaims() in --confirm,
      // claimPot0 in the dry run
      if (ovMaxSol + allowance > pool) {
        die(`--max-sol ${ovMaxSol} + allowance ${allowance} = ${ovMaxSol + allowance} > pot ${pool}`
          + ` (pump.rs:255-259, PotTooSmall)`);
      }
      budget = ovMaxSol;
      amount = ovAmount;
    } else {
      curve = confirm ? await liveCurve() : previewCurve; // re-quote against the live curve before every send
      amount = BN.min(ceiling, quote(curve, Math.floor(budget * (10_000 - SLACK_BPS) / 10_000)));
    }
    const share = (s.tokensHeld.toNumber() / totalHeld.toNumber() * 100).toFixed(2);
    console.log(`  ${s.trader.toBase58()}  held ${tok(s.tokensHeld)} (${share}%)  budget ${sol(budget)}${ovAmount ? ' (OVERRIDE)' : ''}`
      + `${confirm ? ` of a live pot of ${sol(pool)}` : ''}  → buy ${tok(amount)} ${l.symbol}${amount.eq(ceiling) ? ' (at the 98.5% ceiling)' : ''}`);
    if (amount.isZero()) die(`budget ${sol(budget)} quotes 0 tokens for ${s.trader.toBase58()} — ${zeroQuoteWhy(curve, budget)}`);
    predictedClaimSpend += budget + allowance;
    // I2: the next holder in the dry run must be quoted against this buy
    if (!confirm) { previewCurve = advance(previewCurve, amount); continue; }
    if (ovAmount) {
      console.log(`  *** SENDING THE OVERRIDE: amount ${amount} RAW, max_sol_cost ${budget} LAMPORTS`
        + ` for ${s.trader.toBase58()} — tokens_claimed is set unconditionally (pump.rs:301), so this is final ***`);
    }
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
      if (ovAmount) {
        // never quietly overrule the operator's own numbers
        console.error(e.logs ? e.logs.join('\n') : '');
        die(`the override (amount ${ovAmount}, max-sol ${ovMaxSol}) hit PotTooSmall — the pot moved under it;`
          + ` re-read the pot and pick smaller numbers`);
      }
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
      if (amount2.isZero()) die(`re-quote at ${retry} lamports buys 0 tokens for ${s.trader.toBase58()} — ${zeroQuoteWhy(curve2, retry)}`);
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
    if (only && !s.trader.equals(only)) continue;
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
  if (only) {
    console.log(`\n  graduate: SKIPPED — --only cranked one session. Rerun without flags once every`
      + ` session has claimed; pump_graduate needs claims_done == sessions_opened (pump.rs:415-418).`);
    console.log(confirm ? `\n  ${sigs.length} transaction(s) sent, no migration record written.\n`
      : `\n[dry] nothing sent. Rerun with --confirm to execute.\n`);
    return;
  }
  // the authoritative second check: I5 already ran the predicted form before
  // the first send, this one re-reads what actually landed
  if (confirm) pumpAcc = await program.account.pumpLaunch.fetch(pump);
  const claimsAfter = confirm ? pumpAcc.claimsDone.toNumber() : predicted;
  if (claimsAfter !== l.sessionsOpened.toNumber()) {
    die(`claims ${claimsAfter}/${l.sessionsOpened} — a session is missing; check getProgramAccounts against the ER stragglers`);
  }
  // graduation may spend the flip pot, so the remainder is read off
  // potForGraduate — dry run subtracts the claim spends it just predicted,
  // which is a FLOOR (every claim was charged its full cap and allowance).
  // The dry-run quote below runs against previewCurve, which the holder loop
  // has already advanced by every planned buy (I2).
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
      why = zeroQuoteWhy(curve, gMax);
      gMax = 0;
    }
  }
  const remainderLabel = confirm ? `remainder ${sol(remaining)}`
    : `remainder ≥ ${sol(remaining)} (floor: every claim was charged its full cap and allowance;`
      + ` the live figure runs up to ~0.012◎ higher, so a burn buy may still happen)`;
  console.log(`  graduate: ${remainderLabel} → ${gAmount.isZero() ? `no burn buy (${why})` : `buy + burn ≥ ${tok(gAmount)} ${l.symbol} ≤ ${sol(gMax)}`}, residue → platform, Mooner mint sealed`);
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

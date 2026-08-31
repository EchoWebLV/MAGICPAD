#!/usr/bin/env node
// Independent auditor for a MagicPad settlement receipt.
//
// Reads nothing but public chain data — a Solana RPC and the MagicBlock
// rollup nodes — and rebuilds a dark market from scratch, then checks the
// two things a hidden curve owes the world once it stops:
//
//   MONEY     Sigma(sol_spent - sol_proceeds) over every escrow session must
//             equal the launch's real_sol_raised. Winners were paid out of
//             losers and nothing else moved.
//
//   ORDERING  Replaying the recovered trades through the program's own
//             quote math must reproduce two independent things: the virtual
//             reserves the chain is holding, and every trader's settled
//             ledger in their TradeSession account.
//
//             Both are needed. End reserves under constant product depend
//             only on the SUM of buys and sells, so they catch a dropped,
//             inserted or amount-tampered trade -- down to one lamport --
//             but NOT two same-direction trades swapped. The per-trader
//             ledger catches exactly that: a reordered sell fills at a
//             different price, a reordered buy receives a different number
//             of tokens. Together they leave a published log nowhere to
//             hide, which is what makes publishing it off-chain safe --
//             L1 holds the checksum.
//
// The web app serves the same object at /api/receipt/<id>. Pass --against
// <url> and this script will diff its own findings against what that
// endpoint claims, so the API never has to be trusted.
//
//   node scripts/verify-receipt.mjs 12
//   node scripts/verify-receipt.mjs <mint-address>
//   node scripts/verify-receipt.mjs 12 --against http://localhost:3020/api/receipt/12
//   node scripts/verify-receipt.mjs 12 --json

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BorshAccountsCoder, BorshInstructionCoder, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function webEnv(name) {
  try {
    const e = readFileSync(resolve(HERE, '../apps/web/.env.local'), 'utf8');
    return (e.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1]?.trim() || null;
  } catch { return null; }
}

// One codebase, two deployments — mirror apps/web/lib/core.ts: the devnet
// demo speaks the old IDL, mainnet runs v3 (fairest mode, flip_pot).
const CLUSTER = process.env.CLUSTER || webEnv('NEXT_PUBLIC_CLUSTER') || 'mainnet';
const MAINNET = CLUSTER === 'mainnet';
const idl = JSON.parse(readFileSync(
  resolve(HERE, MAINNET ? '../apps/web/lib/idl-v3.json' : '../apps/web/lib/idl.json'), 'utf8'));

const PROGRAM_ID = new PublicKey(idl.address);
const VS0 = 30_000_000_000n;                 // constants.rs VIRTUAL_SOL_INIT
const VT0 = 1_073_000_000_000_000n;          // constants.rs VIRTUAL_TOK_INIT
const STATE = ['BONDING', 'FROZEN', 'RECONCILED', 'GRADUATED'];
const ER_NODES = (process.env.ER_NODES || webEnv('NEXT_PUBLIC_ER_NODES')
  || (MAINNET ? 'https://eu.magicblock.app'
    : 'https://devnet-as.magicblock.app,https://devnet.magicblock.app'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const ROUTER = process.env.ROUTER_URL || webEnv('NEXT_PUBLIC_ROUTER_URL')
  || (MAINNET ? 'https://router.magicblock.app' : 'https://devnet-router.magicblock.app');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const has = (n) => args.includes(n);
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--against');
const JSON_OUT = has('--json');
const rpcUrl = flag('--rpc') || process.env.RPC_URL || webEnv('NEXT_PUBLIC_RPC_URL')
  || clusterApiUrl(MAINNET ? 'mainnet-beta' : 'devnet');

const ixCoder = new BorshInstructionCoder(idl);
const acctCoder = new BorshAccountsCoder(idl);
const num = (v) => Number(v?.toString?.() ?? v);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const launchPda = (id) => pda(Buffer.from('launch'), u64(id));
const mintPda = (id) => pda(Buffer.from('mint'), u64(id));
const PLATFORM = pda(Buffer.from('platform'));

// ---- the curve, mirroring programs/magicpad/src/instructions/trade.rs -----
const buyQuote = (vs, vt, inn) => {
  if (inn === 0n) return 0n;
  const nvt = (vs * vt) / (vs + inn) + 1n;
  return nvt >= vt ? 0n : vt - nvt;
};
const sellQuote = (vs, vt, tin) => {
  if (tin === 0n) return 0n;
  const nvs = (vs * vt) / (vt + tin) + 1n;
  return nvs >= vs ? 0n : vs - nvs;
};

// ---- fairest mode, mirroring programs/magicpad/src/fair.rs ----------------
// The flip tax is pure math over (sol_out, weighted entry ts, clock), so a
// replay recomputes it from block times — the same per-slot clock the
// program read. Sellers are credited net of it; the tax accrues on the
// launch as flip_pot (i64, -1 when the mode is off).
const FLIP_TAX_START_BPS = 2_500n;
const FLIP_DECAY_SECS = 1_800n;
const weightedEntryTs = (entry, held, now, bought) => {
  const total = held + bought;
  return total === 0n ? entry : (entry * held + now * bought) / total;
};
const flipTaxAt = (out, entry, now) => {
  const age = now > entry ? now - entry : 0n;
  if (age >= FLIP_DECAY_SECS) return 0n;
  return out * (FLIP_TAX_START_BPS * (FLIP_DECAY_SECS - age) / FLIP_DECAY_SECS) / 10_000n;
};

async function allSignatures(conn, addr) {
  const acc = [];
  let before;
  for (;;) {
    const page = await conn.getSignaturesForAddress(
      addr, { limit: 1000, ...(before ? { before } : {}) }, 'confirmed');
    if (!page.length) break;
    acc.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return acc.reverse(); // oldest first — deposits name session keys before their trades
}

/* create_launch is parsed by hand: its arg list grew a trailing `fair`
 * bool, so the current coder chokes on creations from before the upgrade
 * and would drop the market's own LAUNCH event. disc(8) + name + symbol
 * (+ fair) — read the bytes directly, any vintage. */
const CREATE_LAUNCH_DISC = Buffer.from(
  idl.instructions.find((i) => i.name === 'create_launch').discriminator);
function parseCreateLaunch(raw) {
  if (raw.length < 8 || !raw.subarray(0, 8).equals(CREATE_LAUNCH_DISC)) return null;
  let off = 8;
  for (let s = 0; s < 2; s++) { // name, symbol
    if (off + 4 > raw.length) return null;
    off += 4 + raw.readUInt32LE(off);
  }
  if (off > raw.length) return null;
  return off < raw.length ? { fair: raw[off] === 1 } : {};
}

function parseTx(tx, sig, er, sk, slot) {
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? msg.accountKeys;
  const signer = keys[0].toBase58();
  const at = (tx.blockTime ?? 0) * 1000;
  const out = [];
  for (const ix of msg.compiledInstructions ?? msg.instructions ?? []) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(PROGRAM_ID)) continue;
    const raw = typeof ix.data === 'string' ? utils.bytes.bs58.decode(ix.data) : ix.data;
    const created = parseCreateLaunch(Buffer.from(raw));
    if (created) {
      out.push({ sig, at, er, signer, slot, kind: 'LAUNCH', ...created });
      continue;
    }
    let dec = null;
    try { dec = ixCoder.decode(Buffer.from(raw)); } catch { continue; }
    if (!dec) continue;
    const a = dec.data;
    const base = { sig, at, er, signer, slot };
    if (dec.name === 'open_trade_session') sk[a.session_key.toBase58()] = signer;
    const kind = {
      create_launch: 'LAUNCH', open_trade_session: 'DEPOSIT', top_up_session: 'TOPUP',
      buy: 'BUY', sell: 'SELL', freeze_launch: 'FREEZE', reconcile_trade_session: 'SETTLED',
      claim_tokens: 'CLAIM', graduate: 'GRADUATED', lock_mint: 'LOCKED', record_pool: 'POOL',
    }[dec.name];
    if (!kind) continue;
    if (kind === 'BUY') out.push({ ...base, kind, sol: num(a.amount_in) });
    else if (kind === 'SELL') out.push({ ...base, kind, tok: num(a.tokens_in) });
    else if (kind === 'DEPOSIT') out.push({ ...base, kind, sol: num(a.deposit) });
    else if (kind === 'TOPUP') out.push({ ...base, kind, sol: num(a.amount) });
    else out.push({ ...base, kind });
  }
  return out;
}

async function sweep(conn, addr, er, sk, seen) {
  const events = [];
  let scanned = 0;
  for (const s of await allSignatures(conn, addr)) {
    scanned += 1;
    if (seen.has(s.signature) || s.err) { seen.add(s.signature); continue; }
    const tx = await conn.getTransaction(s.signature,
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) continue;
    seen.add(s.signature);
    events.push(...parseTx(tx, s.signature, er, sk, s.slot));
  }
  return { events, scanned };
}

async function routerFqdn(addr) {
  try {
    const r = await fetch(`${ROUTER}/getDelegationStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [addr.toBase58()] }),
    }).then((x) => x.json());
    return r?.result?.fqdn ?? null;
  } catch { return null; }
}

async function resolveId(conn, param) {
  if (/^\d+$/.test(param)) return Number(param);
  let mint;
  try { mint = new PublicKey(param); } catch { return null; }
  const info = await conn.getAccountInfo(PLATFORM);
  if (!info) return null;
  const seq = Number(info.data.readBigUInt64LE(40));
  for (let i = 0; i < seq; i++) if (mintPda(i).equals(mint)) return i;
  return null;
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
const camelKeys = (v) => {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === 'object' && v.constructor === Object) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]));
  }
  return v;
};

async function main() {
  if (!target) {
    console.error('usage: node scripts/verify-receipt.mjs <launch-id | mint> [--against <url>] [--rpc <url>] [--json]');
    process.exit(2);
  }
  const conn = new Connection(rpcUrl, 'confirmed');
  const id = await resolveId(conn, target);
  if (id === null) { console.error(`no launch matches "${target}"`); process.exit(2); }

  const launch = launchPda(id);
  const l1Info = await conn.getAccountInfo(launch);
  if (!l1Info) { console.error(`launch ${id} does not exist on ${new URL(rpcUrl).host}`); process.exit(2); }

  // Authoritative state: the rollup while delegated, L1 once it has come home.
  const fqdn = await routerFqdn(launch);
  let acct = camelKeys(acctCoder.decode('Launch', l1Info.data));
  let liveAt = 'l1';
  if (fqdn) {
    try {
      const erInfo = await new Connection(fqdn, 'confirmed').getAccountInfo(launch);
      if (erInfo) { acct = camelKeys(acctCoder.decode('Launch', erInfo.data)); liveAt = 'er'; }
    } catch { /* node gone — L1 snapshot stands */ }
  }

  const sk = {};
  const seen = new Set();
  const l1 = await sweep(conn, launch, false, sk, seen);

  const endpoints = [];
  for (const e of [fqdn, ...ER_NODES]) {
    if (!e) continue;
    const n = e.replace(/\/+$/, '');
    if (!endpoints.includes(n)) endpoints.push(n);
  }
  const erEvents = [];
  let erScanned = 0;
  let erUsed = null;
  for (const n of endpoints) {
    try {
      const r = await sweep(new Connection(n, 'confirmed'), launch, true, sk, seen);
      erScanned += r.scanned;
      if (r.events.length) { erEvents.push(...r.events); erUsed ??= n; }
    } catch { /* next node */ }
  }

  const events = [...l1.events, ...erEvents]
    .sort((a, b) => a.at - b.at || (a.slot ?? 0) - (b.slot ?? 0));

  // ---- ORDERING: replay reserves AND every trader's ledger ---------------
  // flip_pot: i64, -1 = fairest mode off; >= 0 = armed, holding the taxes.
  // (The old devnet IDL has no such field — undefined reads as mode off.)
  // Fairest mode needs BOTH signals: pot slot >= 0 AND the create_launch tx
  // carried fair=true. Markets born before the fair upgrade reuse the slot's
  // bytes for an older timestamp field; misreading either way only ever
  // FAILS a receipt, so a forged flag cannot buy a false VERIFIED.
  const flipPotRaw = acct.flipPot === undefined ? -1 : num(acct.flipPot);
  const fairLaunch = events.some((e) => e.kind === 'LAUNCH' && e.fair === true);
  const fairMode = flipPotRaw >= 0 && fairLaunch;
  const flipPot = fairMode ? flipPotRaw : 0;

  let vs = VS0;
  let vt = VT0;
  const byTrader = {};
  const entryTs = {};
  const of = (a) => (byTrader[a] ??= { spent: 0, proceeds: 0, tokensHeld: 0, tax: 0, taxLo: 0, taxHi: 0 });
  for (const e of events) {
    const actor = sk[e.signer] ?? e.signer;
    const now = BigInt(Math.floor(e.at / 1000));
    if (e.kind === 'BUY' && e.sol) {
      const i = BigInt(e.sol);
      const out = buyQuote(vs, vt, i);
      vt -= out; vs += i;
      const t = of(actor);
      // entry stamped BEFORE tokens_held moves (trade.rs buy)
      if (fairMode) entryTs[actor] = weightedEntryTs(entryTs[actor] ?? 0n, BigInt(t.tokensHeld), now, out);
      t.spent += e.sol; t.tokensHeld += Number(out);
    } else if (e.kind === 'SELL' && e.tok) {
      const tin = BigInt(e.tok);
      const out = sellQuote(vs, vt, tin);
      vs -= out; vt += tin;
      const t = of(actor);
      let tax = 0n;
      if (fairMode) {
        const entry = entryTs[actor] ?? 0n;
        tax = flipTaxAt(out, entry, now);
        // ±2s of clock-vs-blocktime skew on the tax, nothing else
        t.taxLo += Number(flipTaxAt(out, entry, now + 2n));
        t.taxHi += Number(flipTaxAt(out, entry, now - 2n));
      }
      t.tax += Number(tax);
      t.proceeds += Number(out - tax); t.tokensHeld -= e.tok;
    }
  }
  const chainVs = BigInt(num(acct.virtualSol));
  const chainVt = BigInt(num(acct.virtualTok));
  const reservesMatch = vs === chainVs && vt === chainVt;

  // ---- MONEY: every session's signed net must sum to real_sol_raised ------
  const sDisc = Buffer.from(idl.accounts.find((a) => a.name === 'TradeSession').discriminator);
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(sDisc) } },
      { memcmp: { offset: 8, bytes: utils.bytes.bs58.encode(u64(id)) } },
    ],
  });
  const sessions = accts.map(({ pubkey, account }) => {
    const s = camelKeys(acctCoder.decode('TradeSession', account.data));
    return {
      pda: pubkey.toBase58(), trader: s.trader.toBase58(),
      deposit: num(s.deposit), solSpent: num(s.solSpent), solProceeds: num(s.solProceeds),
      tokensHeld: num(s.tokensHeld),
      net: num(s.solSpent) - num(s.solProceeds), reconciled: !!s.reconciled,
    };
  });
  // exact first; the ±2s band only forgives clock skew on the tax, and only
  // when the pot equality (chain-vs-chain, no time in it) holds to the lamport
  const blank = { spent: 0, proceeds: 0, tokensHeld: 0, tax: 0, taxLo: 0, taxHi: 0 };
  const pre = sessions.map((s) => {
    const r = byTrader[s.trader] ?? blank;
    const gross = r.proceeds + r.tax;
    return {
      s,
      r,
      baseOk: r.spent === s.solSpent && r.tokensHeld === s.tokensHeld,
      proceedsExact: r.proceeds === s.solProceeds,
      proceedsInBand: s.solProceeds >= gross - r.taxHi && s.solProceeds <= gross - r.taxLo,
      grossDiff: gross - s.solProceeds,
    };
  });
  const potMatches = !fairMode || pre.reduce((a, x) => a + x.grossDiff, 0) === flipPot;
  const ledger = pre.map(({ s, r, baseOk, proceedsExact, proceedsInBand }) => ({
    trader: s.trader,
    replaySpent: r.spent, chainSpent: s.solSpent,
    replayProceeds: r.proceeds, chainProceeds: s.solProceeds,
    replayTokens: r.tokensHeld, chainTokens: s.tokensHeld,
    replayTax: r.tax,
    matches: baseOk && (proceedsExact || (fairMode && proceedsInBand && potMatches)),
  }));
  const ledgerMatches = ledger.length > 0 && ledger.every((x) => x.matches) && potMatches;
  const ordering = reservesMatch && ledgerMatches;
  const sumNets = sessions.reduce((a, s) => a + s.net, 0);
  const realSolRaised = num(acct.realSolRaised);
  // fairest mode keeps the taxes inside the system: they sit in the pot,
  // so conservation is real_sol_raised PLUS flip_pot
  const money = sumNets === realSolRaised + flipPot;

  // Three states, not two. A market still bonding has no final ledger to
  // check against, and a settled one whose rollup ledger has been pruned
  // cannot be checked at all — neither is the same as caught cheating.
  // Missing history and wrong history are told apart by the sessions: if
  // the chain settled a spend our replay never saw, trades are missing.
  const finalised = acct.state === 2 || acct.state === 3;
  const trades = events.filter((e) => e.kind === 'BUY' || e.kind === 'SELL').length;
  const historyIncomplete = trades === 0
    || sessions.some((s) => (byTrader[s.trader]?.spent ?? 0) < s.solSpent);
  const verdict = (ordering && money) ? 'VERIFIED'
    : (!finalised || historyIncomplete || sessions.length === 0) ? 'UNVERIFIABLE'
      : 'FAILED';
  const why = verdict === 'VERIFIED'
    ? `reserves and all ${sessions.length} settled ledgers reproduce from the ${trades} published trades.`
    : verdict === 'FAILED'
      ? 'every trade this market settled on was recovered, and replaying them does not reproduce the chain\'s numbers.'
      : !finalised
        ? `this market is still ${acct.state === 1 ? 'settling' : 'bonding'} — its reserves are still moving, so there is no final ledger to check yet.`
        : sessions.length === 0
          ? 'no escrow sessions were ever opened against this market.'
          : 'this market traded, but no rollup node still holds the whole ledger — the order flow can no longer be fully recovered.';

  const found = {
    verdict, why,
    launchId: id, launch: launch.toBase58(), mint: acct.mint.toBase58(),
    name: acct.name, symbol: acct.symbol, state: STATE[acct.state],
    liveAt, erEndpoint: erUsed,
    counts: {
      events: events.length, trades,
      sessions: sessions.length, scannedL1: l1.scanned, scannedEr: erScanned,
    },
    money: { realSolRaised, sumNets, flipPot, balances: money },
    ordering: {
      replayVirtualSol: vs.toString(), replayVirtualTok: vt.toString(),
      chainVirtualSol: chainVs.toString(), chainVirtualTok: chainVt.toString(),
      reservesMatch, ledger, ledgerMatches, matches: ordering,
    },
    sessions, events,
  };

  // ---- optional: does the served receipt agree with what we just found? ---
  let served = null;
  const against = flag('--against');
  if (against) {
    try {
      const r = await fetch(against).then((x) => x.json());
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      served = {
        url: against,
        moneyAgrees: r?.money?.realSolRaised === realSolRaised && r?.money?.sumNets === sumNets,
        orderingAgrees: r?.ordering?.chainVirtualSol === chainVs.toString()
          && r?.ordering?.replayVirtualSol === vs.toString()
          && r?.ordering?.replayVirtualTok === vt.toString()
          && r?.ordering?.ledgerMatches === ledgerMatches,
        tradesAgree: same(
          (r?.events ?? []).filter((e) => e.kind === 'BUY' || e.kind === 'SELL').map((e) => e.sig),
          events.filter((e) => e.kind === 'BUY' || e.kind === 'SELL').map((e) => e.sig),
        ),
      };
      served.ok = served.moneyAgrees && served.orderingAgrees && served.tradesAgree;
    } catch (e) { served = { url: against, error: e.message }; }
  }

  const pass = verdict === 'VERIFIED' && (served ? served.ok : true);
  if (JSON_OUT) {
    console.log(JSON.stringify({ pass, ...found, served }, null, 2));
    process.exit(pass ? 0 : 1);
  }

  const sol = (l) => (l / 1e9).toFixed(6).padStart(14);
  const tick = (b) => (b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
  console.log(`\n  ${found.name} (${found.symbol})  launch #${id}  ${found.state}`);
  console.log(`  ${launch.toBase58()}`);
  console.log(`  mint ${found.mint}`);
  console.log(`  rpc  ${new URL(rpcUrl).host}   rollup ${erUsed ?? '(none reachable)'}   live state on ${liveAt.toUpperCase()}`);

  console.log(`\n  ── ORDER FLOW ─ ${found.counts.trades} trades recovered from ${found.counts.scannedEr} rollup signatures`);
  for (const e of events) {
    const amt = e.kind === 'BUY' ? sol(e.sol)
      : e.kind === 'SELL' ? String(e.tok).padStart(14)
        : e.sol ? sol(e.sol) : ''.padStart(14);
    console.log(`     ${e.kind.padEnd(9)} ${e.er ? 'ER' : 'L1'}  ${(sk[e.signer] ?? e.signer).slice(0, 8)}…  ${amt}  ${e.sig.slice(0, 16)}…`);
  }

  console.log(`\n  ── MONEY ─ ${tick(money)}`);
  for (const s of sessions) {
    console.log(`     ${s.trader.slice(0, 8)}…  deposit ${sol(s.deposit)}  spent ${sol(s.solSpent)}  proceeds ${sol(s.solProceeds)}  net ${sol(s.net)}${s.reconciled ? '' : '  (unsettled)'}`);
  }
  console.log(`     Sigma nets ${sumNets}  ==  real_sol_raised ${realSolRaised}${fairMode ? ` + flip_pot ${flipPot}` : ''}   ${tick(money)}`);

  console.log(`\n  ── RESERVES ─ ${tick(reservesMatch)}   (catches a dropped, extra or altered trade)`);
  console.log(`     replay  vs ${vs}  vt ${vt}`);
  console.log(`     chain   vs ${chainVs}  vt ${chainVt}`);

  console.log(`\n  ── PER-TRADER FILLS ─ ${tick(ledgerMatches)}   (catches a reordering, which reserves alone cannot)`);
  if (!ledger.length) console.log('     no settled sessions yet — nothing to hold the replay against.');
  for (const c of ledger) {
    console.log(`     ${c.trader.slice(0, 8)}…  ${tick(c.matches)}`);
    console.log(`        spent    replay ${String(c.replaySpent).padStart(16)}   chain ${String(c.chainSpent).padStart(16)}`);
    console.log(`        proceeds replay ${String(c.replayProceeds).padStart(16)}   chain ${String(c.chainProceeds).padStart(16)}`);
    console.log(`        tokens   replay ${String(c.replayTokens).padStart(16)}   chain ${String(c.chainTokens).padStart(16)}`);
    if (fairMode && c.replayTax > 0) {
      console.log(`        flip tax replay ${String(c.replayTax).padStart(16)}   (net of tax above)`);
    }
  }
  if (fairMode) {
    console.log(`     replayed taxes must sit in the flip pot: ${pre.reduce((a, x) => a + x.grossDiff, 0)} == ${flipPot}   ${tick(potMatches)}`);
  }

  if (served) {
    console.log(`\n  ── SERVED RECEIPT ─ ${served.error ? '\x1b[31m' + served.error + '\x1b[0m' : tick(served.ok)}`);
    if (!served.error) {
      console.log(`     ${served.url}`);
      console.log(`     money ${tick(served.moneyAgrees)}   ordering ${tick(served.orderingAgrees)}   trade set ${tick(served.tradesAgree)}`);
    }
  }
  const badge = verdict === 'VERIFIED' ? '\x1b[32mVERIFIED\x1b[0m'
    : verdict === 'FAILED' ? '\x1b[31mFAILED\x1b[0m' : '\x1b[33mUNVERIFIABLE\x1b[0m';
  console.log(`\n  ${badge} — ${why}\n`);
  // 0 verified, 1 genuinely failed, 3 cannot be checked — so CI can tell
  // "this market cheated" apart from "this market cannot be audited".
  process.exit(verdict === 'VERIFIED' ? (pass ? 0 : 1) : verdict === 'FAILED' ? 1 : 3);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// The janitor. Polls every launch and pushes whatever is stuck one step
// closer to settled — the same state-aware moves the demo prover makes,
// running forever:
//
//   delegated + FROZEN in the ER  → commit sessions (batches of 8) + launch
//   home + FROZEN/RECONCILED      → reconcile (losers first, winners heal),
//                                   claim_tokens cranks,
//                                   graduate when the pot crosses 5 SOL,
//                                   then seed Meteora + lock the mint
//
// Every payout target is pinned on-chain to session.trader, so the keeper
// can only ever settle CORRECTLY — it pays fees, never decides amounts.
//
// env: RPC_URL, ROUTER_URL, KEEPER_KEYPAIR (JSON array or path; falls back
//      to ~/.config/solana/id.json), POLL_MS (default 15000),
//      KEEPER_ONCE=1 (single tick and exit — testing / cron)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { migrateLaunch } from './migrate.mjs';

const { AnchorProvider, Program, Wallet, BN, utils } = anchorPkg;
const bs58 = utils.bytes.bs58;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const GRADUATION_LAMPORTS = new BN(5_000_000_000);
const SESSION_DISC = Buffer.from(idl.accounts.find((a) => a.name === 'TradeSession').discriminator);
const TOPUP_DISC = Buffer.from(idl.accounts.find((a) => a.name === 'TopUp').discriminator);
const FROZEN = 1;
const RECONCILED = 2;
const GRADUATED = 3;

function loadKeeper() {
  const env = process.env.KEEPER_KEYPAIR;
  if (env) {
    const raw = env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
}
const keeper = loadKeeper();
const conn = new Connection(process.env.RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const provider = new AnchorProvider(conn, new Wallet(keeper), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const CONFIG = pda(Buffer.from('config'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());
const ata = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);

const sessionFilters = (id) => [
  { memcmp: { offset: 0, bytes: bs58.encode(SESSION_DISC) } },
  { memcmp: { offset: 8, bytes: bs58.encode(le8(id)) } },
];
const topupFilters = (id) => [
  { memcmp: { offset: 0, bytes: bs58.encode(TOPUP_DISC) } },
  { memcmp: { offset: 8, bytes: bs58.encode(le8(id)) } },
];

async function erFor(account) {
  const r = await fetch(`${ROUTER}/getDelegationStatus`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
  }).then((x) => x.json()).catch(() => null);
  return r?.result?.fqdn ?? null;
}

// tx senders with ×3 retry — L1 signs with the keeper, ER pays no fees
async function withRetry(label, fn) {
  for (let i = 1; i <= 3; i++) {
    try { return await fn(); } catch (e) {
      const msg = String(e.message ?? e);
      if (msg.includes('PotNotReady') || msg.includes('0x1781')) {
        log(`  ${label}: pot not funded yet, retrying next tick`);
        return null;
      }
      if (i === 3) { log(`  ${label} failed ×3: ${msg.slice(0, 140)}`); return null; }
      await sleep(1000 * i);
    }
  }
}

async function sendL1(ixs, label) {
  return withRetry(label, async () => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = keeper.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(keeper);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, 'confirmed');
    log(`  ${label}: ${sig.slice(0, 16)}…`);
    return sig;
  });
}

async function sendEr(er, ixs, label) {
  return withRetry(label, async () => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = keeper.publicKey; // non-delegated payer, fee-free in the ER
    tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(keeper);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    for (let t = Date.now(); Date.now() - t < 20_000;) {
      const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
      if (st?.err) throw new Error(`${label}: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus) { log(`  ${label} (ER): ${sig.slice(0, 16)}…`); return sig; }
      await sleep(200);
    }
    throw new Error(`${label}: ER confirm timeout`);
  });
}

// ---- the two lanes ---------------------------------------------------------

// delegated launch: if the ER says FROZEN, push everything home
async function tendDelegated(id, launch) {
  const fqdn = await erFor(launch);
  if (!fqdn) return; // router hasn't picked it up yet
  const er = new Connection(fqdn, 'confirmed');
  const acc = await er.getAccountInfo(launch, 'confirmed').catch(() => null);
  if (!acc) return;
  const l = decodeLaunch(acc.data);
  if (l.state < FROZEN) return; // live market — never touch it

  log(`launch ${id}: FROZEN in the ER, committing home`);
  // top-up notes ride the same commit — commit_trade_sessions undelegates
  // whatever delegated PDAs it's handed, sessions and notes alike
  const sessions = await er.getProgramAccounts(PROGRAM_ID, { filters: sessionFilters(id) });
  const notes = await er.getProgramAccounts(PROGRAM_ID, { filters: topupFilters(id) });
  const homebound = [...sessions, ...notes];
  for (let i = 0; i < homebound.length; i += 8) {
    const batch = homebound.slice(i, i + 8);
    await sendEr(er, [await program.methods.commitTradeSessions().accountsPartial({
      payer: keeper.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).remainingAccounts(batch.map((s) => ({ pubkey: s.pubkey, isSigner: false, isWritable: true })))
      .instruction()], `commit sessions ${i}..${i + batch.length}`);
  }
  await sendEr(er, [await program.methods.commitLaunch().accountsPartial({
    payer: keeper.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
  }).instruction()], 'commit launch');
  // undelegation lands async; the next tick works the home lane
}

// home launch: reconcile losers first, heal winners, run the claim cranks,
// graduate when the pot crosses the line
async function tendMigrated(id) {
  try {
    await migrateLaunch({ conn, program, payer: keeper, id });
  } catch (e) {
    log(`launch ${id} migrate: ${String(e.message ?? e).slice(0, 160)}`);
  }
}

async function tendHome(id, launch, l, adminKey) {
  if (l.state === GRADUATED) { await tendMigrated(id); return; }
  if (l.state < FROZEN || l.state > RECONCILED) return;

  const raw = await conn.getProgramAccounts(PROGRAM_ID, { filters: sessionFilters(id) });
  const sessions = raw.map((r) => ({ pubkey: r.pubkey, s: decodeSession(r.account.data) }));
  // any session still under the DLP is a straggler the launch-commit missed;
  // rare (opened mid-commit) — surface it, a later freeze pass can't help it
  const stragglers = await conn.getProgramAccounts(DLP, { filters: sessionFilters(id) });
  if (stragglers.length) log(`launch ${id}: ${stragglers.length} session(s) still delegated — stragglers`);

  // top-up notes fold in BEFORE reconcile: an applied note's escrow joins
  // its session PDA (reconcile refuses to fire until it has), an unapplied
  // one refunds the trader in full. Notes still under the DLP retry next
  // tick — the ordering error is clean by design.
  const rawNotes = await conn.getProgramAccounts(PROGRAM_ID, { filters: topupFilters(id) });
  for (const r of rawNotes) {
    const n = program.coder.accounts.decode('topUp', r.account.data);
    await sendL1([await program.methods.absorbTopUp().accountsPartial({
      trader: n.trader, session: sessionPda(id, n.trader), note: r.pubkey,
    }).instruction()], `absorb top-up ${sol(n.amount)} ${n.applied ? '→ session' : '→ refund'} ${n.trader.toBase58().slice(0, 8)}…`);
  }

  // losers first (positive net funds the pot), winners after
  const unreconciled = sessions.filter((x) => !x.s.reconciled)
    .sort((a, b) => b.s.solSpent.sub(b.s.solProceeds).cmp(a.s.solSpent.sub(a.s.solProceeds)));
  for (const { pubkey, s } of unreconciled) {
    await sendL1([await program.methods.reconcileTradeSession().accountsPartial({
      trader: s.trader, launch, session: pubkey,
    }).instruction()], `reconcile ${s.trader.toBase58().slice(0, 8)}…`);
  }

  const mint = mintPda(id);
  for (const { pubkey, s } of sessions.filter((x) => x.s.reconciled)) {
    if (!s.tokensClaimed && s.tokensHeld.gtn(0)) {
      await sendL1([await program.methods.claimTokens().accountsPartial({
        cranker: keeper.publicKey, trader: s.trader, platform: PLATFORM,
        launch, session: pubkey, mint, traderAta: ata(s.trader, mint),
        tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
      }).instruction()], `claim_tokens → ${s.trader.toBase58().slice(0, 8)}…`);
    }
  }

  const settled = l.state === RECONCILED
    || (l.state === FROZEN && l.sessionsReconciled.eq(l.sessionsOpened));
  if (settled && l.realSolRaised.gte(GRADUATION_LAMPORTS) && keeper.publicKey.equals(adminKey)) {
    await sendL1([await program.methods.graduate().accountsPartial({
      admin: keeper.publicKey, platform: PLATFORM, config: CONFIG, launch, mint,
      adminAta: ata(keeper.publicKey, mint),
      tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    }).instruction()], `GRADUATE launch ${id} — ${sol(l.realSolRaised)} to Meteora seed`);
    await tendMigrated(id);
  }
}

// ---- the loop --------------------------------------------------------------
log(`keeper ${keeper.publicKey.toBase58()} on ${conn.rpcEndpoint}`);
log(`program ${PROGRAM_ID.toBase58()} · poll ${POLL_MS}ms`);

for (;;) {
  try {
    const platformAcc = await conn.getAccountInfo(PLATFORM);
    if (!platformAcc) { log('platform not initialized yet'); await sleep(POLL_MS); continue; }
    const platform = program.coder.accounts.decode('platform', platformAcc.data);
    const n = platform.launchSeq.toNumber();

    for (let id = 0; id < n; id++) {
      const launch = launchPda(id);
      const acc = await conn.getAccountInfo(launch);
      if (!acc) continue;
      try {
        if (acc.owner.equals(DLP)) await tendDelegated(id, launch);
        else if (acc.owner.equals(PROGRAM_ID)) {
          await tendHome(id, launch, decodeLaunch(acc.data), platform.admin);
        }
      } catch (e) {
        log(`launch ${id}: ${String(e.message ?? e).slice(0, 140)}`);
      }
    }
  } catch (e) {
    log(`tick failed: ${String(e.message ?? e).slice(0, 140)}`);
  }
  if (process.env.KEEPER_ONCE) { log('single tick done'); break; }
  await sleep(POLL_MS);
}

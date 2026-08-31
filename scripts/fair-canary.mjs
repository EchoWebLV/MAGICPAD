#!/usr/bin/env node
// DEVNET FAIR CANARY — proves the in-curve flip tax end-to-end on real infra:
// fair launch on the canary program (G6e4) → delegate → gasless ER buy →
// INSTANT ER sell (≈25% tax carved in the ER ledger — also proves Clock
// works inside MagicBlock's ER) → crossing buy freezes → commit home →
// reconcile (tax lamports land on the launch) → graduate (sweep = raise +
// pot) → Meteora seed includes the pot. Conservation checked to the lamport.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = '/Users/yordanlasonov/Documents/GitHub/MAGICPAD';
const { migrateLaunch } = await import(path.join(root, 'scripts/migrate.mjs'));

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const ROUTER = 'https://devnet-router.magicblock.app';
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json');
const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const NAME = 'FAIR CANARY';
const SYMBOL = 'FCNRY';
const DEPOSIT = new BN(250_000_000); // 0.25
const BUY1 = new BN(50_000_000);     // 0.05 — the flip
const BUY2 = new BN(150_000_000);    // 0.15 — crosses the 0.1 graduation line

const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
if (idl.address !== 'G6e4sjwCEeQFjWx1Wx2UP8FJ2qR8BvwdXk3UrgijARAV') throw new Error('idl is not the canary build — flip declare_id and anchor build first');
const PROGRAM_ID = new PublicKey(idl.address);
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(6) + '◎';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pdaOf = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pdaOf(Buffer.from('platform'));
const CONFIG = pdaOf(Buffer.from('config'));
const GATE = pdaOf(Buffer.from('gate'));

const conn = new Connection(RPC, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))));
const program = new Program(idl, new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' }));
const sk = Keypair.generate(); // throwaway ER session key

async function send(ixs, label, extra = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(wallet, ...extra);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('  ' + label.padEnd(26), sig.slice(0, 20) + '…');
  return sig;
}
async function erFor(account, label, rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    const r = await fetch(`${ROUTER}/getDelegationStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    }).then((x) => x.json()).catch(() => null);
    const fqdn = r?.result?.fqdn;
    if (fqdn) return fqdn;
    await sleep(800);
  }
  throw new Error(`router reports no ER for ${label}`);
}
async function erAccount(er, pk, label) {
  for (let i = 0; i < 20; i++) {
    const acc = await er.getAccountInfo(pk, 'confirmed').catch(() => null);
    if (acc) return acc;
    await sleep(500);
  }
  throw new Error(`${label} never appeared in the ER`);
}
async function sendEr(er, ixs, signer, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const t = Date.now();
  for (;;) {
    const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
    if (st?.err) throw new Error(`${label} failed in ER: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
      console.log('  ' + label.padEnd(26), sig.slice(0, 20) + '… (ER, gasless)');
      return sig;
    }
    if (Date.now() - t > 20_000) throw new Error(`${label}: not confirmed in 20s`);
    await sleep(150);
  }
}
const delegationMetas = (target, suffix) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf, [`delegationRecord${suffix}`]: rec, [`delegationMetadata${suffix}`]: meta,
    ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
  };
};
async function waitUndelegated(pubkeys, label) {
  const t0 = Date.now();
  const pending = new Set(pubkeys.map((p) => p.toBase58()));
  while (pending.size && Date.now() - t0 < 180_000) {
    for (const b58 of [...pending]) {
      const acc = await conn.getAccountInfo(new PublicKey(b58), 'confirmed').catch(() => null);
      if (acc?.owner.equals(PROGRAM_ID)) pending.delete(b58);
    }
    if (pending.size) await sleep(1500);
  }
  if (pending.size) throw new Error(`${label}: still delegated after 180s`);
  console.log(`  ${label} undelegated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); };

// ---------- go ----------
console.log('=== DEVNET FAIR CANARY: flip tax through the real ER ===');
console.log('wallet', wallet.publicKey.toBase58(), sol(await conn.getBalance(wallet.publicKey)));

const plat = await program.account.platform.fetch(PLATFORM);
const id = plat.launchSeq.toNumber();
const launch = pdaOf(Buffer.from('launch'), le8(id));
const mint = pdaOf(Buffer.from('mint'), le8(id));
const session = pdaOf(Buffer.from('tsession'), le8(id), wallet.publicKey.toBuffer());

await send([await program.methods.createLaunch(NAME, SYMBOL, true).accountsPartial({
  creator: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint,
  tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], `[1/7] create_launch ${id} FAIR`);
let l = await program.account.launch.fetch(launch);
assert(l.flipPot.eqn(0), `fair launch must arm the pot at 0, got ${l.flipPot}`);
console.log('      flip pot armed (0), mint', mint.toBase58());

await send([await program.methods.delegateLaunch(new BN(id)).accountsPartial({
  payer: wallet.publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
}).instruction()], '[2/7] delegate_launch');
const fqdn = await erFor(launch, 'launch');
console.log('      ER route:', fqdn);
const er = new Connection(fqdn, 'confirmed');
await erAccount(er, launch, 'launch');

await send([
  await program.methods.openTradeSession(new BN(id), sk.publicKey, DEPOSIT).accountsPartial({
    trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId,
    gate: GATE, gateSigner: wallet.publicKey,
  }).instruction(),
  await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
    payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
  }).instruction(),
], '[3/7] open 0.25 + delegate');
const sFqdn = await erFor(session, 'session');
assert(sFqdn === fqdn, `session on a different ER node (${sFqdn})`);
await erAccount(er, session, 'session');

// --- the flip: buy, then dump instantly — tax must appear in the ER ledger ---
await sendEr(er, [await program.methods.buy(BUY1).accountsPartial({
  sessionSigner: sk.publicKey, session, launch,
}).instruction()], sk, `[4/7] ER buy ${sol(BUY1)}`);
let erS = program.coder.accounts.decode('tradeSession', (await erAccount(er, session, 's')).data);
let erL = program.coder.accounts.decode('launch', (await erAccount(er, launch, 'l')).data);
const entry = erS.entryTs.toNumber();
const wallClock = Math.floor(Date.now() / 1000);
assert(entry > 1_700_000_000 && Math.abs(entry - wallClock) < 120,
  `ER Clock sane (entry ${entry} vs wall ${wallClock})`);
console.log(`      entry stamped ${entry} (wall ${wallClock}) — Clock LIVE inside the ER`);

const raisedBefore = erL.realSolRaised;
const held = erS.tokensHeld;
await sendEr(er, [await program.methods.sell(held).accountsPartial({
  sessionSigner: sk.publicKey, session, launch,
}).instruction()], sk, `[5/7] ER sell ALL (instant)`);
erS = program.coder.accounts.decode('tradeSession', (await erAccount(er, session, 's')).data);
erL = program.coder.accounts.decode('launch', (await erAccount(er, launch, 'l')).data);
const outGross = raisedBefore.sub(erL.realSolRaised); // curve moves by GROSS out
const tax = erL.flipPot;
assert(tax.gtn(0), 'instant flip must pay a tax');
assert(erS.solProceeds.eq(outGross.sub(tax)), `proceeds ${erS.solProceeds} == gross ${outGross} - tax ${tax}`);
const floor = outGross.muln(2400).divn(10_000); // ≥24.00% allows a few seconds of decay
const ceil = outGross.muln(2500).divn(10_000);
assert(tax.gte(floor) && tax.lte(ceil), `tax ${tax} within [${floor}, ${ceil}]`);
console.log(`      TAX CARVED IN THE ER: gross ${sol(outGross)} → seller ${sol(erS.solProceeds)}, pot ${sol(tax)} (${(tax.muln(10000).div(outGross).toNumber() / 100).toFixed(2)}%)`);

// --- crossing buy freezes ---
await sendEr(er, [await program.methods.buy(BUY2).accountsPartial({
  sessionSigner: sk.publicKey, session, launch,
}).instruction()], sk, `[6/7] ER buy ${sol(BUY2)} (crosses)`);
erL = program.coder.accounts.decode('launch', (await erAccount(er, launch, 'l')).data);
assert(erL.state === 1, `expected FROZEN, got ${erL.state}`);
console.log(`      FROZEN. raised ${sol(erL.realSolRaised)} pot ${sol(erL.flipPot)}`);

await sendEr(er, [await program.methods.commitTradeSessions().accountsPartial({
  payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
}).remainingAccounts([{ pubkey: session, isSigner: false, isWritable: true }]).instruction()], wallet, 'commit_trade_sessions');
await sendEr(er, [await program.methods.commitLaunch().accountsPartial({
  payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
}).instruction()], wallet, 'commit_launch');
await waitUndelegated([session, launch], 'session + launch');

// --- L1 landing: reconcile → claim → graduate, conservation to the lamport ---
l = await program.account.launch.fetch(launch);
const s = await program.account.tradeSession.fetch(session);
assert(l.flipPot.eq(tax), 'pot survived the commit home');
const net = s.solSpent.sub(s.solProceeds);
console.log(`      home. raised ${sol(l.realSolRaised)} pot ${sol(l.flipPot)} trader net -${sol(net)}`);
assert(net.eq(l.realSolRaised.add(l.flipPot)), `single-session conservation: net ${net} == raised+pot`);

await send([await program.methods.reconcileTradeSession().accountsPartial({
  trader: wallet.publicKey, launch, session,
}).instruction()], '[7/7] reconcile');
const ata = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), TOKEN_PROGRAM.toBuffer(), m.toBuffer()], ATA_PROGRAM)[0];
await send([await program.methods.claimTokens().accountsPartial({
  cranker: wallet.publicKey, trader: wallet.publicKey, platform: PLATFORM,
  launch, session, mint, traderAta: ata(wallet.publicKey, mint),
  tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], '      claim_tokens');

const launchBefore = await conn.getBalance(launch);
await send([await program.methods.graduate().accountsPartial({
  admin: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint,
  adminAta: ata(wallet.publicKey, mint),
  tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], '      GRADUATE');
const launchAfter = await conn.getBalance(launch);
l = await program.account.launch.fetch(launch);
assert(l.state === 3, 'GRADUATED');
const sweep = new BN(launchBefore - launchAfter);
assert(sweep.eq(l.realSolRaised.add(tax)), `graduation swept raised+pot: ${sweep} == ${l.realSolRaised.add(tax)}`);
console.log(`      SWEEP ${sol(sweep)} = raise ${sol(l.realSolRaised)} + pot ${sol(tax)} — flippers funded the seed`);

// --- Meteora: the pot must widen the pool at the same frozen price ---
process.env.LOCK_LP = '0';
const mig = await migrateLaunch({ conn, program, payer: wallet, id, dry: false });
const rec = JSON.parse(fs.readFileSync(path.join(root, 'scripts/migrations.json'), 'utf8'))[mint.toBase58()];
assert(new BN(rec.seedSol).eq(l.realSolRaised.add(tax)), `Meteora seed ${rec.seedSol} == raised+pot`);
console.log(`\nDONE. pool ${rec.pool} seeded ${sol(rec.seedSol)} (incl. ${sol(tax)} of flip tax)`);
console.log(`balance ${sol(await conn.getBalance(wallet.publicKey))}`);

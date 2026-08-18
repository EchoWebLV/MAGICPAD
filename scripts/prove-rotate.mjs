#!/usr/bin/env node
// Session-key rotation, proven on live devnet ER infrastructure:
//
//   1. open a session on an EXISTING bonding launch with throwaway key A
//   2. buy with key A — the session trades
//   3. the WALLET signs rotate_session_key(B) as an ER tx — the crux:
//      trader-signed, wallet is a plain cloned read-only signer, fee zero
//   4. buy with key A now BOUNCES — SessionKeyMismatch, the old key is dead
//   5. buy with key B CLEARS on the same ledger, then sells back flat
//
//   LAUNCH_ID=2 node scripts/prove-rotate.mjs
//
// Rides a live launch as a second trader: no launch fee, dust-sized buys
// sold straight back, escrow refunds at that launch's settlement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';

const rpc = process.env.RPC_URL || clusterApiUrl('devnet');
const conn = new Connection(rpc, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + '◎';
const txUrl = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function sendL1(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`${label}:`, txUrl(sig));
  return sig;
}

async function erFor(account, label) {
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${ROUTER}/getDelegationStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    }).then((x) => x.json()).catch(() => null);
    const fqdn = r?.result?.fqdn;
    if (fqdn) return fqdn;
    await sleep(800);
  }
  throw new Error(`router reports no ER for ${label} (${account.toBase58()})`);
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
    if (st?.err) throw new Error(`${label} failed in the ER: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if (Date.now() - t > 20_000) throw new Error(`${label}: not confirmed in 20s`);
    await sleep(150);
  }
}

const delegationMetas = (target, suffix) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf,
    [`delegationRecord${suffix}`]: rec,
    [`delegationMetadata${suffix}`]: meta,
    ownerProgram: PROGRAM_ID,
    delegationProgram: DLP,
    systemProgram: SystemProgram.programId,
  };
};

// the stakehouse keeper shares this wallet — spend only at a crest
async function waitForCrest(lamports, label) {
  for (let i = 0; i < 300; i++) {
    const bal = await conn.getBalance(wallet.publicKey);
    if (bal >= lamports) { console.log(`  crest: ${sol(bal)} free — ${label}`); return; }
    await sleep(2000);
  }
  throw new Error(`wallet never crested ${sol(lamports)} for ${label}`);
}

// ---- the proof -------------------------------------------------------------
const id = Number(process.env.LAUNCH_ID ?? 2);
const DEP = Math.floor(0.05 * LAMPORTS_PER_SOL); // MIN_DEPOSIT escrow
const B = Math.floor(0.011 * LAMPORTS_PER_SOL);  // dust-sized probe buys

const launch = launchPda(id);
const session = sessionPda(id, wallet.publicKey);
const keyA = Keypair.generate();
const keyB = Keypair.generate();
console.log(`wallet ${wallet.publicKey.toBase58()} · ${sol(await conn.getBalance(wallet.publicKey))}`);
console.log(`launch ${id} · session ${session.toBase58()}`);
console.log(`key A ${keyA.publicKey.toBase58()}\nkey B ${keyB.publicKey.toBase58()}`);

console.log('\n━━ PHASE 1 · open a session with key A (L1) ━━');
await waitForCrest(Math.floor(0.2 * LAMPORTS_PER_SOL), 'escrow + fees');
await sendL1([
  await program.methods.openTradeSession(new BN(id), keyA.publicKey, new BN(DEP)).accountsPartial({
    trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId,
  }).instruction(),
  await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
    payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
  }).instruction(),
], [wallet], `open session: escrow ${sol(DEP)} + delegate`);

console.log('\n━━ PHASE 2 · key A trades (ER) ━━');
const er = new Connection(await erFor(session, 'session'), 'confirmed');
await erAccount(er, session, 'session');
const buyIx = (signer, amt) => program.methods.buy(new BN(amt)).accountsPartial({
  sessionSigner: signer.publicKey, session, launch,
}).instruction();
const sellIx = (signer, toks) => program.methods.sell(new BN(toks)).accountsPartial({
  sessionSigner: signer.publicKey, session, launch,
}).instruction();
// the ER clones the fresh session lazily — patient first contact
let opened = false;
for (let i = 0; i < 10 && !opened; i++) {
  try { await sendEr(er, [await buyIx(keyA, B)], keyA, `buy ${sol(B)} with key A`); opened = true; }
  catch (e) { if (i === 9) throw e; await sleep(900 * (i + 1)); }
}
console.log('  key A trades — session live in the ER');

console.log('\n━━ PHASE 3 · the WALLET rotates the key (ER, trader-signed) ━━');
await sendEr(er, [await program.methods.rotateSessionKey(keyB.publicKey).accountsPartial({
  trader: wallet.publicKey, session,
}).instruction()], wallet, 'rotate_session_key(B)');
const sRot = decodeSession((await erAccount(er, session, 'session')).data);
assert(sRot.sessionKey.equals(keyB.publicKey), 'ER session now registers key B');

console.log('\n━━ PHASE 4 · old key dead, new key trades ━━');
try {
  await sendEr(er, [await buyIx(keyA, B)], keyA, 'buy with dead key A');
  throw new Error('key A should have been rejected after rotation');
} catch (e) {
  const s = String(e.message ?? e);
  if (!/SessionKeyMismatch|0x177a|"Custom":6010|custom program error: 6010/.test(s)) throw e;
  console.log('  ✓ key A BOUNCED: SessionKeyMismatch — the old key is dead');
}
await sendEr(er, [await buyIx(keyB, B)], keyB, `buy ${sol(B)} with key B`);
const sAfter = decodeSession((await erAccount(er, session, 'session')).data);
assert(sAfter.solSpent.eq(new BN(2 * B)), `key B trades the SAME ledger: sol_spent == ${2 * B}`);

// leave the market flat: sell the whole probe position back
await sendEr(er, [await sellIx(keyB, sAfter.tokensHeld.toNumber())], keyB,
  `sell all ${sAfter.tokensHeld} probe tokens back`);
const sFlat = decodeSession((await erAccount(er, session, 'session')).data);
assert(sFlat.tokensHeld.isZero(), 'probe position flat — market left as found');

console.log(`\nROTATION PROVEN LIVE — launch ${id}: the wallet re-pointed its session`);
console.log('from key A to key B inside the ER; A died, B trades, ledger intact.');
console.log(`escrow ${sol(DEP)} refunds at settlement. wallet: ${sol(await conn.getBalance(wallet.publicKey))}`);

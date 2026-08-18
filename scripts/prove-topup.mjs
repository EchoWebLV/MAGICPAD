#!/usr/bin/env node
// The top-up rail, proven on live devnet infrastructure end to end:
//
//   1. open a session with a SMALL escrow, buy it to the ceiling
//   2. the next buy BOUNCES — ExceedsDeposit, the wall is real
//   3. one L1 tx escrows a top-up note + delegates it
//   4. the session key applies it in the ER — the ceiling MOVES
//   5. the same buy that bounced now CLEARS
//   6. settle: reconcile refuses to fire until the note is absorbed
//      (Overflow gate), absorb moves note lamports into the session to
//      the exact lamport, then reconcile conserves the pot
//
//   node scripts/prove-topup.mjs
//
// Wallet balance swings with the stakehouse keeper sharing this key, so
// the L1 setup waits for a crest before spending.
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
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';
const ER_VALIDATOR = process.env.ER_VALIDATOR ? new PublicKey(process.env.ER_VALIDATOR) : null;

const rpc = process.env.RPC_URL || clusterApiUrl('devnet');
const conn = new Connection(rpc, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());
const topupPda = (id, trader, nonce) => pda(Buffer.from('topup'), le8(id), trader.toBuffer(), le8(nonce));

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + '◎';
const txUrl = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);
const decodeTopUp = (d) => program.coder.accounts.decode('topUp', d);
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
const validatorRemaining = () => (ER_VALIDATOR
  ? [{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }] : []);

async function waitUndelegated(pubkeys, label) {
  const t0 = Date.now();
  const pending = new Set(pubkeys.map((p) => p.toBase58()));
  while (pending.size && Date.now() - t0 < 120_000) {
    for (const b58 of [...pending]) {
      const acc = await conn.getAccountInfo(new PublicKey(b58), 'confirmed').catch(() => null);
      if (acc?.owner.equals(PROGRAM_ID)) pending.delete(b58);
    }
    if (pending.size) await sleep(1500);
  }
  if (pending.size) throw new Error(`${label}: still delegated after 120s`);
  console.log(`  ${label} undelegated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// the stakehouse keeper shares this wallet and parks the balance in round
// pots most of the time — spend only at a crest
async function waitForCrest(lamports, label) {
  for (let i = 0; i < 300; i++) {
    const bal = await conn.getBalance(wallet.publicKey);
    if (bal >= lamports) { console.log(`  crest: ${sol(bal)} free — ${label}`); return; }
    await sleep(2000);
  }
  throw new Error(`wallet never crested ${sol(lamports)} for ${label}`);
}

// ---- the proof -------------------------------------------------------------
const DEP = Math.floor(0.05 * LAMPORTS_PER_SOL);   // opening escrow (the wall)
const TOP = Math.floor(0.10 * LAMPORTS_PER_SOL);   // the raise
const B1 = DEP;                                     // buys the wall exactly
const B2 = Math.floor(0.02 * LAMPORTS_PER_SOL);    // bounces, then clears

console.log(`wallet ${wallet.publicKey.toBase58()} · ${sol(await conn.getBalance(wallet.publicKey))}`);

console.log('\n━━ PHASE 1 · launch + small-escrow session (L1) ━━');
await waitForCrest(3 * LAMPORTS_PER_SOL, 'launch fee + escrow');
const id = (await program.account.platform.fetch(PLATFORM)).launchSeq.toNumber();
const launch = launchPda(id);
await sendL1([await program.methods.createLaunch('CEILING', 'CEIL').accountsPartial({
  creator: wallet.publicKey, platform: PLATFORM, launch, mint: mintPda(id),
  tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], [wallet], `create_launch id=${id} "CEILING"`);
await sendL1([await program.methods.delegateLaunch(new BN(id)).accountsPartial({
  payer: wallet.publicKey, platform: PLATFORM, launch,
  ...delegationMetas(launch, 'Launch'),
}).remainingAccounts(validatorRemaining()).instruction()], [wallet], 'delegate_launch');

const sk = Keypair.generate();
const session = sessionPda(id, wallet.publicKey);
await sendL1([
  await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(DEP)).accountsPartial({
    trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId,
  }).instruction(),
  await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
    payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
  }).remainingAccounts(validatorRemaining()).instruction(),
], [wallet], `open session: escrow ${sol(DEP)} + delegate`);

console.log('\n━━ PHASE 2 · hit the wall (ER) ━━');
const er = new Connection(await erFor(launch, 'launch'), 'confirmed');
await erFor(session, 'session');
const buyIx = (amt) => program.methods.buy(new BN(amt)).accountsPartial({
  sessionSigner: sk.publicKey, session, launch,
}).instruction();
await sendEr(er, [await buyIx(B1)], sk, `buy ${sol(B1)} — the whole escrow`);
console.log(`  bought ${sol(B1)} — escrow ceiling reached`);
try {
  await sendEr(er, [await buyIx(B2)], sk, 'buy past ceiling');
  throw new Error('buy past the ceiling should have failed');
} catch (e) {
  const s = String(e.message ?? e);
  if (!/ExceedsDeposit|0x1773|custom program error: 6003|"Custom":6003/.test(s)) throw e;
  console.log(`  ✓ buy ${sol(B2)} BOUNCED: ExceedsDeposit — the wall is real`);
}

console.log('\n━━ PHASE 3 · raise the ceiling (L1 note → ER apply) ━━');
const nonce = Date.now();
const note = topupPda(id, wallet.publicKey, nonce);
await sendL1([
  await program.methods.topUpSession(new BN(id), new BN(nonce), new BN(TOP)).accountsPartial({
    trader: wallet.publicKey, session, launch, note, systemProgram: SystemProgram.programId,
  }).instruction(),
  await program.methods.delegateTopUp(new BN(id), new BN(nonce)).accountsPartial({
    payer: wallet.publicKey, note, ...delegationMetas(note, 'Note'),
  }).remainingAccounts(validatorRemaining()).instruction(),
], [wallet], `top_up_session ${sol(TOP)} + delegate, one tx`);

const applyIx = await program.methods.applyTopUp(new BN(nonce)).accountsPartial({
  sessionSigner: sk.publicKey, session, launch, note,
}).instruction();
let applied = false;
for (let i = 0; i < 8 && !applied; i++) {
  try { await sendEr(er, [applyIx], sk, 'apply_top_up'); applied = true; }
  catch (e) { await sleep(900 * (i + 1)); if (i === 7) throw e; }
}
const sAfterApply = decodeSession((await erAccount(er, session, 'session')).data);
assert(sAfterApply.deposit.eq(new BN(DEP + TOP)),
  `ceiling moved: deposit ${sAfterApply.deposit} == ${DEP + TOP} (was ${DEP})`);
const noteEr = decodeTopUp((await erAccount(er, note, 'note')).data);
assert(noteEr.applied === true, 'note marked applied in the ER');

console.log('\n━━ PHASE 4 · the bounced buy now clears (ER) ━━');
await sendEr(er, [await buyIx(B2)], sk, `retry buy ${sol(B2)}`);
const sAfterBuy = decodeSession((await erAccount(er, session, 'session')).data);
assert(sAfterBuy.solSpent.eq(new BN(B1 + B2)),
  `same buy cleared: sol_spent ${sAfterBuy.solSpent} == ${B1 + B2}`);

console.log('\n━━ PHASE 5 · freeze + commit home, note rides along (ER → L1) ━━');
await sendEr(er, [await program.methods.freezeLaunch().accountsPartial({
  admin: wallet.publicKey, platform: PLATFORM, launch,
}).instruction()], wallet, 'freeze_launch');
await sendEr(er, [await program.methods.commitTradeSessions().accountsPartial({
  payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
}).remainingAccounts([
  { pubkey: session, isSigner: false, isWritable: true },
  { pubkey: note, isSigner: false, isWritable: true },
]).instruction()], wallet, 'commit_trade_sessions (session + note)');
await sendEr(er, [await program.methods.commitLaunch().accountsPartial({
  payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
}).instruction()], wallet, 'commit_launch');
await waitUndelegated([session, note, launch], 'session + note + launch');

console.log('\n━━ PHASE 6 · settle in order: absorb gates reconcile (L1) ━━');
const reconcileIx = await program.methods.reconcileTradeSession().accountsPartial({
  trader: wallet.publicKey, launch, session,
}).instruction();
try {
  await sendL1([reconcileIx], [wallet], 'reconcile before absorb');
  throw new Error('reconcile before absorb should have failed');
} catch (e) {
  const s = `${e.message ?? e} ${JSON.stringify(e?.transactionLogs ?? e?.logs ?? '')}`;
  if (!/Overflow|0x177d/i.test(s)) throw e;
  console.log('  ✓ reconcile REJECTED before absorb (Overflow gate) — escrow can\'t settle short');
}

const sessLamportsBefore = await conn.getBalance(session);
await sendL1([await program.methods.absorbTopUp().accountsPartial({
  trader: wallet.publicKey, session, note,
}).instruction()], [wallet], 'absorb_top_up (permissionless crank)');
const sessLamportsAfter = await conn.getBalance(session);
assert(sessLamportsAfter - sessLamportsBefore === TOP,
  `absorb moved exactly ${sol(TOP)} note → session (${sessLamportsBefore} → ${sessLamportsAfter})`);
assert(!(await conn.getAccountInfo(note)), 'note account closed, rent home to trader');

const potBefore = await conn.getBalance(launch);
await sendL1([reconcileIx], [wallet], 'reconcile (now clears)');
const potAfter = await conn.getBalance(launch);
const h = decodeSession((await conn.getAccountInfo(session)).data);
const lHome = decodeLaunch((await conn.getAccountInfo(launch)).data);
const net = h.solSpent.sub(h.solProceeds);

console.log('\n===== CONSERVATION TABLE (lamports, exact) =====');
console.log(`  deposit ${h.deposit} (${sol(DEP)} open + ${sol(TOP)} top-up)`);
console.log(`  spent ${h.solSpent} proceeds ${h.solProceeds} net→pot ${net}`);
console.log(`  pot Δ measured ${potAfter - potBefore} | real_sol_raised ${lHome.realSolRaised}`);
assert(h.deposit.eq(new BN(DEP + TOP)), 'settled deposit == open + top-up');
assert(h.solSpent.eq(new BN(B1 + B2)), 'settled spend crosses the ORIGINAL ceiling');
assert(potAfter - potBefore === net.toNumber(), 'pot lamport delta == net exactly');
assert(lHome.realSolRaised.eq(net), 'real_sol_raised == net');
assert(h.reconciled === true, 'session reconciled');

console.log(`\nTOP-UP RAIL PROVEN LIVE — launch ${id}: the wall bounced a buy, one L1 tx`);
console.log('raised it mid-session, the same buy cleared, and settlement conserved');
console.log(`to the lamport. wallet: ${sol(await conn.getBalance(wallet.publicKey))}`);

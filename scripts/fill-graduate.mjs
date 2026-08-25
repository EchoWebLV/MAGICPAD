#!/usr/bin/env node
// Fill a dark curve past the 5◎ graduation line, then stop.
// Settlement + Meteora seed are the keeper / migrate.mjs.
//
//   node scripts/fill-graduate.mjs           # new launch
//   node scripts/fill-graduate.mjs 6         # existing bonding id
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
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';
const GRADUATION = 5 * LAMPORTS_PER_SOL;
const DEPOSIT = Math.floor(5.4 * LAMPORTS_PER_SOL);

const conn = new Connection(process.env.RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const program = new Program(idl, new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' }));

const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const CONFIG = pda(Buffer.from('config'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);

const skPath = (id) => path.join(root, `scripts/.session-${id}-wallet.json`);
function persistedKey(file) {
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  const k = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify([...k.secretKey]));
  return k;
}

const delegationMetas = (target, suffix) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf, [`delegationRecord${suffix}`]: rec,
    [`delegationMetadata${suffix}`]: meta, ownerProgram: PROGRAM_ID,
    delegationProgram: DLP, systemProgram: SystemProgram.programId,
  };
};

async function sendL1(ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(wallet);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(label, sig.slice(0, 16) + '…');
}

async function erFor(account, label) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${ROUTER}/getDelegationStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    }).then((x) => x.json()).catch(() => null);
    if (r?.result?.fqdn) return r.result.fqdn;
    await sleep(800);
  }
  throw new Error(`no ER for ${label}`);
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
    if (st?.err) throw new Error(`${label}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus) { console.log(label, sig.slice(0, 16) + '…'); return sig; }
    if (Date.now() - t > 20_000) throw new Error(`${label} timeout`);
    await sleep(150);
  }
}

async function erAcc(er, pk) {
  for (let i = 0; i < 25; i++) {
    const a = await er.getAccountInfo(pk, 'confirmed').catch(() => null);
    if (a) return a;
    await sleep(400);
  }
  throw new Error(`${pk.toBase58()} never in ER`);
}

const argId = process.argv[2];
let id = argId !== undefined ? Number(argId) : null;
if (id !== null && !Number.isInteger(id)) throw new Error('id must be an integer');

console.log('wallet', wallet.publicKey.toBase58(), sol(await conn.getBalance(wallet.publicKey)));

if (id === null) {
  id = (await program.account.platform.fetch(PLATFORM)).launchSeq.toNumber();
  const launch = launchPda(id);
  await sendL1([await program.methods.createLaunch('GRADTEST', 'GRAD').accountsPartial({
    creator: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint: mintPda(id),
    tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
  }).instruction()], `create_launch ${id}`);
  await sendL1([await program.methods.delegateLaunch(new BN(id)).accountsPartial({
    payer: wallet.publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
  }).instruction()], 'delegate_launch');
}

const launch = launchPda(id);
const session = sessionPda(id, wallet.publicKey);
const sk = persistedKey(skPath(id));
console.log('launch', id, launch.toBase58(), 'mint', mintPda(id).toBase58());

if (!(await conn.getAccountInfo(session))) {
  await sendL1([
    await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(DEPOSIT)).accountsPartial({
      trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId, gateSigner: wallet.publicKey,
    }).instruction(),
    await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
      payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
    }).instruction(),
  ], `open session ${sol(DEPOSIT)}`);
} else {
  console.log('session already open');
}

const fqdn = await erFor(launch, 'launch');
await erFor(session, 'session');
const er = new Connection(fqdn, 'confirmed');
console.log('ER', fqdn);

let l = decodeLaunch((await erAcc(er, launch)).data);
if (l.state !== 0) {
  console.log('already frozen, state', l.state, 'raised', sol(l.realSolRaised));
  process.exit(0);
}

const sess = decodeSession((await erAcc(er, session)).data);
const raised = l.realSolRaised.toNumber();
const need = GRADUATION - raised;
const free = sess.deposit.add(sess.solProceeds).sub(sess.solSpent).toNumber();
console.log('raised', sol(raised), 'need', sol(need), 'free escrow', sol(free));
if (need <= 0) { console.log('already at graduation'); process.exit(0); }
if (free < need) throw new Error(`escrow ${sol(free)} < remaining ${sol(need)} — top up first`);

// chunk so a single quote can't dust-out; last chunk crosses 5◎
let left = need;
while (left > 0) {
  l = decodeLaunch((await erAcc(er, launch)).data);
  if (l.state !== 0) break;
  const chunk = Math.min(left, 2 * LAMPORTS_PER_SOL);
  await sendEr(er, [await program.methods.buy(new BN(chunk)).accountsPartial({
    sessionSigner: sk.publicKey, session, launch,
  }).instruction()], sk, `buy ${sol(chunk)}`);
  left -= chunk;
}

l = decodeLaunch((await erAcc(er, launch)).data);
console.log('done. state', l.state, 'raised', sol(l.realSolRaised), 'sold', l.tokensSold.toString());
if (l.state < 1) throw new Error('did not freeze — raised still under 5◎');
console.log(`frozen. next: KEEPER_ONCE=1 node scripts/keeper.mjs && node scripts/migrate.mjs ${id}`);

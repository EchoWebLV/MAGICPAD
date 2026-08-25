#!/usr/bin/env node
// Token faces, proven on live devnet:
//
//   1. create a launch whose creation tx carries the metadata-CID memo
//      (create + delegate + memo, one tx — exactly what the web form sends)
//   2. retrofit a face onto an EXISTING launch: transfer-0 + memo, the
//      tx touching the launch PDA so its signature history carries the CID
//   3. read back getSignaturesForAddress for both and assert the memos
//      are there — the same single call the web resolver makes
//
//   node scripts/prove-metadata.mjs <newLaunchCid> <retroLaunchId> <retroCid>
//
// Wallet balance swings with the stakehouse keeper sharing this key, so
// the create waits for a balance crest before spending the 1 SOL fee.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, clusterApiUrl, LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PREFIX = 'magicpad:meta:v1:';

const rpc = process.env.RPC_URL || clusterApiUrl('devnet');
const conn = new Connection(rpc, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const program = new Program(idl, new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' }));

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const CONFIG = pda(Buffer.from('config'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) { console.error(`✗ ${msg}`); process.exit(1); } console.log(`✓ ${msg}`); }

const memoIx = (cid) => new TransactionInstruction({
  programId: MEMO, keys: [], data: Buffer.from(PREFIX + cid, 'utf8'),
});

async function send(ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const sig = await conn.sendTransaction(tx, [wallet]);
  const bh = await conn.getLatestBlockhash('confirmed');
  const res = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (res.value.err) { console.error(`✗ ${label}: ${JSON.stringify(res.value.err)}`); process.exit(1); }
  console.log(`✓ ${label} ${sig.slice(0, 16)}…`);
  return sig;
}

async function memoOf(id) {
  const sigs = await conn.getSignaturesForAddress(launchPda(id), { limit: 100 }, 'confirmed');
  const hit = sigs.find((s) => !s.err && s.memo && s.memo.includes(PREFIX));
  return hit ? { memo: hit.memo, sig: hit.signature } : null;
}

const [newCid, retroIdArg, retroCid] = process.argv.slice(2);
if (!newCid || !retroIdArg || !retroCid) {
  console.error('usage: node scripts/prove-metadata.mjs <newLaunchCid> <retroLaunchId> <retroCid>');
  process.exit(1);
}
const retroId = Number(retroIdArg);

// ---- 1. fresh launch, memo in the creation tx ------------------------------
console.log('waiting for a wallet crest (keeper shares this key)…');
for (;;) {
  const bal = await conn.getBalance(wallet.publicKey);
  if (bal >= 1.05 * LAMPORTS_PER_SOL) { console.log(`  balance ${(bal / 1e9).toFixed(3)}◎ — go`); break; }
  await sleep(2000);
}

const platform = await program.account.platform.fetch(PLATFORM);
const id = platform.launchSeq.toNumber();
const launch = launchPda(id);
const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), launch.toBuffer()], PROGRAM_ID);
const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), launch.toBuffer()], DLP);
const [dmeta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), launch.toBuffer()], DLP);

await send([
  await program.methods.createLaunch('NINE ORBS', 'ORBS').accountsPartial({
    creator: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint: mintPda(id),
    tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
  }).instruction(),
  await program.methods.delegateLaunch(new BN(id)).accountsPartial({
    payer: wallet.publicKey, platform: PLATFORM, launch,
    bufferLaunch: buf, delegationRecordLaunch: rec, delegationMetadataLaunch: dmeta,
    ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
  }).instruction(),
  memoIx(newCid),
], `create launch ${id} "NINE ORBS" + delegate + memo, one tx`);

for (let i = 0; ; i++) {
  const m = await memoOf(id);
  if (m) { assert(m.memo.includes(newCid), `launch ${id} sig listing carries the CID: ${m.memo}`); break; }
  if (i >= 10) assert(false, `launch ${id} memo never appeared in the sig listing`);
  await sleep(1500);
}

// ---- 2. retrofit an existing launch ----------------------------------------
await send([
  SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: launchPda(retroId), lamports: 0 }),
  memoIx(retroCid),
], `retro-attach memo onto launch ${retroId}`);

for (let i = 0; ; i++) {
  const m = await memoOf(retroId);
  if (m && m.memo.includes(retroCid)) { assert(true, `launch ${retroId} sig listing carries the CID: ${m.memo}`); break; }
  if (i >= 10) assert(false, `launch ${retroId} memo never appeared in the sig listing`);
  await sleep(1500);
}

const l = await program.account.launch.fetch(launchPda(retroId)).catch(() => null);
console.log(`\nlaunch ${id} NINE ORBS is live dark with a face; launch ${retroId} got its face retrofitted`);
if (l) console.log(`launch ${retroId} creator: ${l.creator.toBase58()} (this wallet: ${wallet.publicKey.toBase58()})`);

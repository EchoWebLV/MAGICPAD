#!/usr/bin/env node
// Find every TopUpSession the trader ever sent, and each note's live state
// (L1 snapshot + ER truth + session deposit). With SK_FILE set, apply any
// unapplied delegated note via the session key (gasless, ER-side).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, clusterApiUrl,
} from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const bs58 = anchorPkg.utils.bytes.bs58;

const root = '/Users/yordanlasonov/Documents/GitHub/magicpad';
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const ROUTER = 'https://devnet-router.magicblock.app';
const RPC = 'https://devnet.helius-rpc.com/?api-key=25c6bc71-4c3a-4cc2-9b87-542902ade619';
const conn = new Connection(RPC, 'confirmed');

const TRADER = new PublicKey('6ucwsAPpeA48ouriBQVBgust2hMToi2DeHVcRm6TaLe1');

const le8 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const sessionPda = (id, t) => pda(Buffer.from('tsession'), le8(id), t.toBuffer());
const topupPda = (id, t, nonce) => pda(Buffer.from('topup'), le8(id), t.toBuffer(), le8(nonce));
const sol = (l) => (Number(l) / 1e9).toFixed(4) + '◎';

// TopUp layout: disc8 | launch_id u64 | trader 32 | nonce u64 | amount u64 | applied u8 | bump u8
const decodeNote = (d) => ({
  launchId: d.readBigUInt64LE(8),
  nonce: d.readBigUInt64LE(48),
  amount: d.readBigUInt64LE(56),
  applied: d[64] === 1,
});
// TradeSession deposit: disc8 | launch_id u64 | trader 32 | session_key 32 | deposit u64
const sessionDeposit = (d) => d.readBigUInt64LE(80);

async function erFor(account) {
  const r = await (await fetch(`${ROUTER}/getDelegationStatus`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
  })).json();
  return r?.result?.fqdn ?? null;
}

const sigs = await conn.getSignaturesForAddress(TRADER, { limit: 50 });
console.log(`trader ${TRADER.toBase58()}: ${sigs.length} recent txs`);
const notes = [];
for (const s of sigs) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  const logs = tx?.meta?.logMessages ?? [];
  if (!logs.some((l) => l.includes('Instruction: TopUpSession'))) continue;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId?.toBase58?.() !== PROGRAM_ID.toBase58() || !ix.data) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (d.length < 32) continue;
    const disc = createHash('sha256').update('global:top_up_session').digest().subarray(0, 8);
    if (!d.subarray(0, 8).equals(disc)) continue;
    notes.push({
      sig: s.signature, err: tx.meta.err,
      launchId: Number(d.readBigUInt64LE(8)), nonce: d.readBigUInt64LE(16), amount: Number(d.readBigUInt64LE(24)),
    });
  }
}
console.log(`top-up txs found: ${notes.length}\n`);

for (const n of notes) {
  const note = topupPda(n.launchId, TRADER, n.nonce);
  const session = sessionPda(n.launchId, TRADER);
  console.log(`launch ${n.launchId} nonce ${n.nonce} amount ${sol(n.amount)} txErr=${JSON.stringify(n.err)}`);
  console.log(`  note ${note.toBase58()}`);
  const l1 = await conn.getAccountInfo(note);
  if (!l1) { console.log('  L1: note CLOSED (absorbed or never created)'); continue; }
  const snap = decodeNote(l1.data);
  console.log(`  L1: owner=${l1.owner.equals(DLP) ? 'DLP (delegated)' : l1.owner.toBase58()} lamports=${sol(l1.lamports)} applied(snapshot)=${snap.applied}`);
  const fqdn = await erFor(note);
  if (!fqdn) { console.log('  ER: router has no route for the note'); continue; }
  const er = new Connection(fqdn, 'confirmed');
  const live = await er.getAccountInfo(note, 'confirmed');
  const liveNote = live ? decodeNote(live.data) : null;
  console.log(`  ER(${fqdn}): note ${live ? `applied=${liveNote.applied}` : 'NOT CLONED'}`);
  const sess = await er.getAccountInfo(session, 'confirmed');
  if (sess) console.log(`  ER session deposit=${sol(sessionDeposit(sess.data))}`);

  if (live && !liveNote.applied && process.env.SK_FILE) {
    const sk = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SK_FILE, 'utf8'))));
    console.log(`  APPLYING via session key ${sk.publicKey.toBase58()} ...`);
    const disc = createHash('sha256').update('global:apply_top_up').digest().subarray(0, 8);
    const data = Buffer.concat([disc, le8(n.nonce)]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: sk.publicKey, isSigner: true, isWritable: false },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: launchPda(n.launchId), isSigner: false, isWritable: false },
        { pubkey: note, isSigner: false, isWritable: true },
      ],
      data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = sk.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(sk);
    try {
      const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      for (let t = Date.now(); Date.now() - t < 15000;) {
        const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
        if (st?.err) throw new Error(JSON.stringify(st.err));
        if (st?.confirmationStatus) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const after = await er.getAccountInfo(session, 'confirmed');
      console.log(`  APPLIED ${sig} — deposit now ${sol(sessionDeposit(after.data))}`);
    } catch (e) {
      console.log(`  APPLY FAILED: ${String(e.message ?? e).slice(0, 140)}`);
    }
  }
  console.log('');
}

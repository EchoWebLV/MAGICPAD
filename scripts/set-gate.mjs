#!/usr/bin/env node
// Arm or disarm the entry gate — the on-chain co-signer that makes
// open_trade_session / top_up_session UI-only.
//
//   node scripts/set-gate.mjs              # arm with GATE_KEYPAIR's pubkey
//   node scripts/set-gate.mjs <pubkey>     # arm with an explicit pubkey
//   node scripts/set-gate.mjs --off        # disarm (permissionless entry)
//
// env: GATE_KEYPAIR (JSON array or path — the key /api/session/sign holds),
//      RPC_URL, KEEPER_KEYPAIR (the platform admin)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl,
} from '@solana/web3.js';

const { AnchorProvider, Program, Wallet } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);

function loadKeypair(env, fallback) {
  const src = process.env[env];
  if (src) {
    const raw = src.trim().startsWith('[') ? src : fs.readFileSync(src, 'utf8');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  if (!fallback) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
}

const arg = process.argv[2];
let newKey;
if (arg === '--off') {
  newKey = PublicKey.default;
} else if (arg) {
  newKey = new PublicKey(arg);
} else {
  const gate = loadKeypair('GATE_KEYPAIR', false);
  if (!gate) throw new Error('pass a pubkey, --off, or set GATE_KEYPAIR');
  newKey = gate.publicKey;
}

const admin = loadKeypair('KEEPER_KEYPAIR', true);
const conn = new Connection(process.env.RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const program = new Program(idl, new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' }));
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const PLATFORM = pda(Buffer.from('platform'));
const GATE = pda(Buffer.from('gate'));

const ix = await program.methods.setGate(newKey).accountsPartial({
  admin: admin.publicKey, platform: PLATFORM, gate: GATE,
  systemProgram: SystemProgram.programId,
}).instruction();
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
const tx = new Transaction({ feePayer: admin.publicKey, recentBlockhash: blockhash }).add(ix);
tx.sign(admin);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
const g = await program.account.gate.fetch(GATE);
const armed = !g.key.equals(PublicKey.default);
console.log(`set_gate ${armed ? `ARMED key=${g.key.toBase58()}` : 'DISARMED (permissionless entry)'}  ${sig}`);

#!/usr/bin/env node
// Write launch fee + graduation tax to the on-chain config PDA.
//
//   node scripts/set-fees.mjs              # reads env, default 0 / 0
//   node scripts/set-fees.mjs 0 0          # free launches, no tax
//   node scripts/set-fees.mjs 1000000000 500   # 1◎ fee, 5% graduation tax
//
// env: LAUNCH_FEE_LAMPORTS, LAUNCH_TAX_BPS (or NEXT_PUBLIC_* of the same),
//      RPC_URL, KEEPER_KEYPAIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl,
} from '@solana/web3.js';

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);

function loadKeeper() {
  const env = process.env.KEEPER_KEYPAIR;
  if (env) {
    const raw = env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
}

const fee = BigInt(process.argv[2]
  ?? process.env.LAUNCH_FEE_LAMPORTS
  ?? process.env.NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS
  ?? '0');
const tax = Number(process.argv[3]
  ?? process.env.LAUNCH_TAX_BPS
  ?? process.env.NEXT_PUBLIC_LAUNCH_TAX_BPS
  ?? '0');
if (!Number.isInteger(tax) || tax < 0 || tax > 10_000) {
  throw new Error(`launch tax bps must be 0..10000, got ${tax}`);
}

const keeper = loadKeeper();
const conn = new Connection(process.env.RPC_URL || clusterApiUrl('devnet'), 'confirmed');
const program = new Program(idl, new AnchorProvider(conn, new Wallet(keeper), { commitment: 'confirmed' }));
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const PLATFORM = pda(Buffer.from('platform'));
const CONFIG = pda(Buffer.from('config'));

const ix = await program.methods.setFees(new BN(fee.toString()), tax).accountsPartial({
  admin: keeper.publicKey, platform: PLATFORM, config: CONFIG,
  systemProgram: SystemProgram.programId,
}).instruction();
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
const tx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash }).add(ix);
tx.sign(keeper);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
const cfg = await program.account.platformConfig.fetch(CONFIG);
console.log(`set_fees fee=${cfg.launchFeeLamports.toString()} tax_bps=${cfg.launchTaxBps}  ${sig}`);

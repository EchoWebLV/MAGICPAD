#!/usr/bin/env node
/* Captures what litesvm needs to run the REAL pump.fun program locally:
 *   pump.so / pfee.so   — mainnet ELFs (programdata minus the 45-byte header)
 *   global.acct, fee_config.acct, gva.acct — pump's config accounts
 *   mint.acct, bonding_curve.acct, associated_bonding_curve.acct
 *                       — the state right AFTER `create` for a fixture mint,
 *                         taken from a mainnet simulateTransaction (nothing is sent)
 *   creator-keypair.json, mint-keypair.json — the fixture identities
 *   meta.txt            — captured_at, fee_recipient, buyback_fee_recipient, mint, creator
 * .acct format: owner(32) ‖ lamports u64 LE ‖ data. Output dir is gitignored.
 *
 *   RPC_URL=https://... node scripts/dump-pump-fixtures.mjs
 * SIM_PAYER (optional): pubkey to simulate `create` as; defaults to the keeper
 * (KEEPER_KEYPAIR or ~/.config/solana/id.json). Needs ≥ 0.03 SOL on mainnet
 * for the simulation to pass the rent/fee checks — never spent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk'); // ESM build is broken upstream (agent-payments-sdk imports named exports from CJS anchor) — load via require

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'litesvm-tests/fixtures');
const PUMP = sdk.PUMP_PROGRAM_ID;
const PFEE = sdk.PUMP_FEE_PROGRAM_ID;
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// upgradeable-loader programdata account = PDA([program_id], loader)
const programdata = (p) => PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
// SDK's CURRENT_FEE_RECIPIENTS_FOR_BUYBACK[0]; a mainnet simulate with it returned err=null
const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
const ELF_HEADER = 45; // UpgradeableLoaderState::ProgramData header before the ELF bytes

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

function loadKeeperPubkey() {
  if (process.env.SIM_PAYER) return new PublicKey(process.env.SIM_PAYER);
  const env = process.env.KEEPER_KEYPAIR;
  const raw = env
    ? (env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8'))
    : fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))).publicKey;
}

function loadOrMakeKeypair(file) {
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + '\n', { mode: 0o600 });
  return kp;
}

const acctBytes = (owner, lamports, data) => {
  const lam = Buffer.alloc(8); lam.writeBigUInt64LE(BigInt(lamports));
  return Buffer.concat([owner.toBuffer(), lam, data]);
};

async function dumpProgram(programdata, file) {
  const acc = await conn.getAccountInfo(programdata);
  if (!acc) throw new Error(`programdata ${programdata.toBase58()} not found`);
  if (!acc.owner.equals(LOADER)) throw new Error(`${file}: ${programdata.toBase58()} owner ${acc.owner.toBase58()} is not the upgradeable loader`);
  if (acc.data.readUInt32LE(0) !== 3) throw new Error(`${file}: not a ProgramData account (discriminant ${acc.data.readUInt32LE(0)})`);
  if (!acc.data.subarray(ELF_HEADER, ELF_HEADER + 4).equals(Buffer.from('7f454c46', 'hex'))) throw new Error(`${file}: no ELF magic at offset ${ELF_HEADER}`);
  fs.writeFileSync(path.join(OUT, file), acc.data.subarray(ELF_HEADER));
  console.log(`${file}: ${acc.data.length - ELF_HEADER} bytes`);
}

async function dumpAccount(address, file) {
  const acc = await conn.getAccountInfo(address);
  if (!acc) throw new Error(`${file}: ${address.toBase58()} not found`);
  fs.writeFileSync(path.join(OUT, file), acctBytes(acc.owner, acc.lamports, acc.data));
  console.log(`${file}: ${address.toBase58()} owner ${acc.owner.toBase58()} len ${acc.data.length}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await dumpProgram(programdata(PUMP), 'pump.so');
  await dumpProgram(programdata(PFEE), 'pfee.so');
  await dumpAccount(sdk.GLOBAL_PDA, 'global.acct');
  // pump rejects a buyback recipient that is not in Global's list; the list can rotate upstream
  const globalBytes = fs.readFileSync(path.join(OUT, 'global.acct'));
  if (globalBytes.indexOf(BUYBACK.toBuffer()) === -1) throw new Error(`BUYBACK ${BUYBACK.toBase58()} is not in the captured global account — update the pin from the SDK's CURRENT_FEE_RECIPIENTS_FOR_BUYBACK`);
  await dumpAccount(sdk.PUMP_FEE_CONFIG_PDA, 'fee_config.acct');
  await dumpAccount(sdk.GLOBAL_VOLUME_ACCUMULATOR_PDA, 'gva.acct');

  const creator = loadOrMakeKeypair(path.join(OUT, 'creator-keypair.json'));
  const mintKp = loadOrMakeKeypair(path.join(OUT, 'mint-keypair.json'));
  const mint = mintKp.publicKey;
  const payer = loadKeeperPubkey();
  const bal = await conn.getBalance(payer);
  if (bal < 30_000_000) throw new Error(`SIM_PAYER ${payer.toBase58()} holds ${bal} lamports; the create simulation needs ≥ 0.03 SOL`);

  const pump = new sdk.PumpSdk();
  const createIx = await pump.createInstruction({
    mint, name: 'FIXTURE', symbol: 'FIX', uri: 'https://example.com/fixture.json',
    creator: creator.publicKey, user: payer,
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [createIx] })
    .compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const bondingCurve = sdk.bondingCurvePda(mint);
  const abc = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_PROGRAM_ID);
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [mint.toBase58(), bondingCurve.toBase58(), abc.toBase58()] },
  });
  if (sim.value.err) throw new Error(`create simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join('\n')}`);
  const names = ['mint.acct', 'bonding_curve.acct', 'associated_bonding_curve.acct'];
  if (!sim.value.accounts) throw new Error('RPC returned no accounts array — does it support simulateTransaction.accounts?');
  sim.value.accounts.forEach((a, i) => {
    if (!a) throw new Error(`${names[i]}: simulation returned no account`);
    fs.writeFileSync(path.join(OUT, names[i]), acctBytes(new PublicKey(a.owner), a.lamports, Buffer.from(a.data[0], 'base64')));
    console.log(`${names[i]}: owner ${a.owner} lamports ${a.lamports} len ${Buffer.from(a.data[0], 'base64').length}`);
  });

  const global = await new sdk.OnlinePumpSdk(conn).fetchGlobal();
  const capturedAt = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(OUT, 'meta.txt'), [
    `captured_at=${capturedAt}`,
    `fee_recipient=${global.feeRecipient.toBase58()}`,
    `buyback_fee_recipient=${BUYBACK.toBase58()}`,
    `mint=${mint.toBase58()}`,
    `creator=${creator.publicKey.toBase58()}`,
  ].join('\n') + '\n');
  console.log(`meta.txt written · mint ${mint.toBase58()} · creator ${creator.publicKey.toBase58()} · captured_at ${capturedAt}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

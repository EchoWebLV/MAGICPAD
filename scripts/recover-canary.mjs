#!/usr/bin/env node
/* Recover what launch 6 (MCNPMP) left on the table, back into the admin wallet.
 *
 *   node scripts/recover-canary.mjs             # dry run: quotes + plan, sends nothing
 *   node scripts/recover-canary.mjs --confirm   # sends it; every step is idempotent, rerun to resume
 *
 * Money that is recoverable (verified 2026-09-14):
 *   1. the three traders' MCNPMP on pump.fun — sold back into the bonding curve,
 *      admin pays the fee (the traders are empty), proceeds land in the trader,
 *      then the trader is drained to the admin. These wallets are already tied
 *      to the admin on-chain (that is why launch 6 is burned), so nothing new
 *      leaks here.
 *   2. pump.fun creator fees sitting in the admin's creator_vault.
 *   3. the platform PDA's excess above rent (withdraw_platform, admin).
 * NOT recoverable: rent locked in the launch PDA, pump marker, Mooner mint and
 * three session PDAs (~0.0083◎) — the program has no close instruction.
 *
 * env: RPC_URL (falls back to apps/web/.env.local), WALLET (default
 *      ~/.config/solana/id.json), CU_PRICE (µlamports, 50000)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk');
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const webEnv = (() => { try { return fs.readFileSync(path.join(root, 'apps/web/.env.local'), 'utf8'); } catch { return ''; } })();
const fromWebEnv = (k) => (webEnv.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
const RPC = process.env.RPC_URL || fromWebEnv('NEXT_PUBLIC_RPC_URL');
const WALLET_PATH = process.env.WALLET || path.join(os.homedir(), '.config/solana/id.json');
const CU_PRICE = Number(process.env.CU_PRICE || 50_000);
const LAUNCH_ID = 6;
const PUMP_MINT = new PublicKey('4T4JugbcZxz4YBbFTMczcpwB6r74SFBbMm1rshqG1RRP');
const STATE = path.join(root, 'scripts/pump-canary/state-launch-6.json');
const SLIPPAGE_PCT = 5;

const confirm = process.argv.includes('--confirm');
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'))));
const conn = new Connection(RPC, 'confirmed');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const program = new Program(idl, new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' }));
const PLATFORM = PublicKey.findProgramAddressSync([Buffer.from('platform')], PROGRAM_ID)[0];
const traders = JSON.parse(fs.readFileSync(STATE, 'utf8')).traders.map((t) => Keypair.fromSecretKey(Uint8Array.from(t.wallet)));

async function send(ixs, label, signers = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(wallet, ...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  log(`  ✓ ${label.padEnd(34)} ${sig}`);
}

async function main() {
  console.log(`=== recover launch ${LAUNCH_ID} (MCNPMP) → ${wallet.publicKey.toBase58()} ===`);
  const before = await conn.getBalance(wallet.publicKey);
  log(`admin ${sol(before)}`);
  const online = new sdk.OnlinePumpSdk(conn);
  const offline = new sdk.PumpSdk();
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  let expected = 0;

  // ---- 1. sell + drain each trader ----
  for (const [i, t] of traders.entries()) {
    const ata = getAssociatedTokenAddressSync(PUMP_MINT, t.publicKey, true);
    const held = await getAccount(conn, ata).then((a) => new BN(a.amount.toString())).catch(() => new BN(0));
    if (held.isZero()) log(`[1] trader ${i + 1} ${t.publicKey.toBase58().slice(0, 8)} holds no MCNPMP`);
    else {
      const { bondingCurveAccountInfo, bondingCurve } = await online.fetchSellState(PUMP_MINT, t.publicKey);
      if (bondingCurve.complete) die('bonding curve is complete (migrated to AMM) — sell path differs, stop');
      const quote = sdk.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve, amount: held });
      log(`[1] trader ${i + 1} sells ${(held.toNumber() / 1e6).toFixed(0)} MCNPMP → ~${sol(quote)} (min ${sol(quote.muln(100 - SLIPPAGE_PCT).divn(100))})`);
      expected += quote.toNumber();
      if (confirm) {
        const ixs = await offline.sellInstructions({
          global, bondingCurveAccountInfo, bondingCurve, mint: PUMP_MINT, user: t.publicKey,
          amount: held, solAmount: quote, slippage: SLIPPAGE_PCT, tokenProgram: TOKEN_PROGRAM_ID, mayhemMode: false,
        });
        await send(ixs, `sell trader ${i + 1}`, [t]);
      }
    }
    const bal = await conn.getBalance(t.publicKey);
    if (bal > 0) {
      log(`[1] trader ${i + 1} drains ${sol(bal)} → admin`);
      if (confirm) await send([SystemProgram.transfer({ fromPubkey: t.publicKey, toPubkey: wallet.publicKey, lamports: bal })], `drain trader ${i + 1}`, [t]);
    } else if (!confirm && !held.isZero()) log(`[1] trader ${i + 1} then drains the proceeds → admin`);
  }

  // ---- 2. pump.fun creator fees ----
  const vault = sdk.creatorVaultPda(wallet.publicKey);
  const vAcc = await conn.getAccountInfo(vault);
  const vExcess = vAcc ? vAcc.lamports - (await conn.getMinimumBalanceForRentExemption(vAcc.data.length)) : 0;
  if (vExcess > 0) {
    log(`[2] creator_vault ${vault.toBase58().slice(0, 8)} holds ${sol(vExcess)} of creator fees → collect`);
    expected += vExcess;
    if (confirm) await send(await online.collectCoinCreatorFeeInstructions(wallet.publicKey, wallet.publicKey), 'collect creator fees');
  } else log('[2] creator_vault empty');

  // ---- 3. platform excess ----
  const pAcc = await conn.getAccountInfo(PLATFORM);
  const pExcess = pAcc.lamports - (await conn.getMinimumBalanceForRentExemption(pAcc.data.length));
  if (pExcess > 0) {
    log(`[3] platform PDA excess ${sol(pExcess)} → withdraw_platform`);
    expected += pExcess;
    if (confirm) await send([await program.methods.withdrawPlatform(new BN(0)).accountsPartial({ admin: wallet.publicKey, platform: PLATFORM }).instruction()], 'withdraw_platform');
  } else log('[3] platform PDA at rent-min');

  if (!confirm) { console.log(`\nabout ${sol(expected)} recoverable minus ~${sol(traders.length * 2 * 15_000 + 30_000)} of fees — run with --confirm`); return; }
  const after = await conn.getBalance(wallet.publicKey);
  log(`done. admin ${sol(after)} (+${sol(after - before)})`);
}

main().catch((e) => die(e.message));

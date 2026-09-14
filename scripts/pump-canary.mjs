#!/usr/bin/env node
/* MAINNET PUMP CANARY — a pump-mode launch through the whole rail:
 *
 *   create_launch + enable_pump + memo + delegate_launch (one tx, the market
 *   is dark from second zero) → three throwaway traders each open a session
 *   through the armed gate → three gasless ER buys, the third one crosses the
 *   0.2 SOL pump line → commit home → reconcile every session → hand off to
 *   scripts/migrate-pump.mjs (pump.fun token, one pump_claim per trader,
 *   pump_graduate) → verify every trader holds the pump.fun token.
 *
 *   THE TRADERS ARE NEVER FUNDED BY THIS SCRIPT. Bubblemaps and the GMGN-style
 *   maps cluster holders by SOL funding source, so a canary whose traders were
 *   topped up from the creator/keeper wallet draws that wallet as a hub over
 *   every holder (launch 6 proved it). The script prints the three addresses
 *   and refuses to start until each holds its stake, funded by you from three
 *   independent sources (separate exchange withdrawals, unrelated wallets).
 *   `sweep <destination>` drains them afterwards — pick a destination that is
 *   not the creator, or leave the dust where it is.
 *
 *   node scripts/pump-canary.mjs             # dry run: preflight + plan, sends nothing
 *   node scripts/pump-canary.mjs --confirm   # the real thing; rerun to resume
 *   node scripts/pump-canary.mjs status      # where the current canary stands
 *   node scripts/pump-canary.mjs sweep <dest> # drain the throwaway traders to <dest> (NOT the creator)
 *   --fund-from-wallet                       # opt in: WALLET funds the traders and takes the dust back.
 *                                            # Every holder maps to the creator (launch 6). Test-only.
 *
 * Every step reads on-chain state first and only does what remains, so a
 * killed run resumes. State (trader keypairs, launch id, pinned CID) lives in
 * scripts/pump-canary/state.json — gitignored, the secrets never leave this
 * machine.
 *
 * env: RPC_URL (falls back to apps/web/.env.local NEXT_PUBLIC_RPC_URL),
 *      WALLET (creator + platform admin + keeper; default ~/.config/solana/id.json),
 *      GATE_KEYPAIR (falls back to apps/web/.env.local), PINATA_JWT (same),
 *      ER_VALIDATOR (default eu.magicblock.app), CU_PRICE (µlamports, 50000)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';

const { AnchorProvider, Program, Wallet, BN, utils } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- env ------------------------------------------------------------------
const webEnv = (() => {
  try { return fs.readFileSync(path.join(root, 'apps/web/.env.local'), 'utf8'); } catch { return ''; }
})();
const fromWebEnv = (k) => (webEnv.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
const RPC = process.env.RPC_URL || fromWebEnv('NEXT_PUBLIC_RPC_URL');
if (!RPC) die('RPC_URL missing (or NEXT_PUBLIC_RPC_URL in apps/web/.env.local)');
const WALLET_PATH = process.env.WALLET || path.join(os.homedir(), '.config/solana/id.json');
const GATE_SPEC = process.env.GATE_KEYPAIR || fromWebEnv('GATE_KEYPAIR');
const PINATA_JWT = process.env.PINATA_JWT || fromWebEnv('PINATA_JWT');
const ROUTER = process.env.ROUTER_URL || fromWebEnv('NEXT_PUBLIC_ROUTER_URL') || 'https://router.magicblock.app';
const ER_VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
const CU_PRICE = Number(process.env.CU_PRICE || 50_000);

const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const GATEWAY = 'https://tomato-fancy-finch-338.mypinata.cloud/ipfs/'; // apps/web/lib/metadata.ts
const UPLOADS = 'https://uploads.pinata.cloud/v3/files';               // apps/web/app/api/pin/route.ts

// ---- the plan -------------------------------------------------------------
const NAME = 'MAGIC CANARY PUMP';
const SYMBOL = 'MCNPMP';
const DESCRIPTION = 'Mooner pump-mode canary: three traders, one dark 0.2 SOL curve, migrated onto pump.fun.';
const PUMP_LINE = 200_000_000;            // constants.rs PUMP_GRADUATION_LAMPORTS
const TRADERS = 3;
const BUY = 70_000_000;                   // 3 × 0.07 = 0.21 ≥ 0.2: the third buy freezes the curve
const DEPOSIT = 80_000_000;               // escrow ceiling per session, residue walks home at reconcile
const TRADER_FUND = 100_000_000;          // deposit + session rent + delegation + fees — YOU send this, from three unrelated sources
const STATE_DIR = path.join(root, 'scripts/pump-canary');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ---- helpers --------------------------------------------------------------
const FROZEN = 1, RECONCILED = 2, GRADUATED = 3;
const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const statusOnly = argv.includes('status');
const sweepOnly = argv.includes('sweep');
const fundFromWallet = argv.includes('--fund-from-wallet');
const sweepDest = sweepOnly ? (() => {
  const raw = argv[argv.indexOf('sweep') + 1];
  if (!raw) die('sweep needs a destination: node scripts/pump-canary.mjs sweep <pubkey>');
  try { return new PublicKey(raw); } catch { die(`sweep destination is not a pubkey: ${raw}`); }
})() : null;
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
function die(m) { console.error(`✗ ${m}`); process.exit(1); }
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m); };

const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const CONFIG = pda(Buffer.from('config'));
const GATE = pda(Buffer.from('gate'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const pumpPda = (id) => pda(Buffer.from('pump'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());

function loadKeypair(spec) {
  const s = spec.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  const file = s.replace(/^~/, os.homedir());
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  return Keypair.fromSecretKey(utils.bytes.bs58.decode(s));
}
const wallet = loadKeypair(WALLET_PATH);
const gateKey = GATE_SPEC ? loadKeypair(GATE_SPEC) : null;
const conn = new Connection(RPC, 'confirmed');
const program = new Program(idl, new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' }));

// ---- persisted state ------------------------------------------------------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}
const kpOf = (arr) => Keypair.fromSecretKey(Uint8Array.from(arr));

// ---- L1 + ER plumbing (the shapes run3/run4 proved on mainnet) --------------
async function send(ixs, label, signers = [], payer = wallet) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
  tx.sign(...all);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  log(`  ${label.padEnd(30)} ${sig}`);
  return sig;
}
async function erFor(account, label, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
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
  tx.feePayer = signer.publicKey; // non-delegated payer — the ER takes it, fee-free
  tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const t = Date.now();
  for (;;) {
    const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
    if (st?.err) throw new Error(`${label} failed in the ER: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
      log(`  ${label.padEnd(30)} ${sig} (ER, gasless)`);
      return sig;
    }
    if (Date.now() - t > 20_000) throw new Error(`${label}: not confirmed in 20s`);
    await sleep(150);
  }
}
const delegationMetas = (target, suffix) => ({
  [`buffer${suffix}`]: PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID)[0],
  [`delegationRecord${suffix}`]: PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP)[0],
  [`delegationMetadata${suffix}`]: PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP)[0],
  ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
});
const validatorRemaining = [{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }];
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
  if (pending.size) throw new Error(`${label}: still delegated after 180s — rerun to retry the commit`);
  log(`  ${label} undelegated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);

// ---- metadata: image (PIL) + json → Pinata → verified over the gateway -------
function renderImage(file) {
  const py = `
from PIL import Image, ImageDraw
import math
W=1024; img=Image.new("RGB",(W,W),(8,10,12)); d=ImageDraw.Draw(img)
for i in range(0,W,32):
    d.line([(i,0),(i,W)],fill=(16,20,22)); d.line([(0,i),(W,i)],fill=(16,20,22))
cx,cy=W//2,W//2
for r in range(420,60,-40):
    t=(420-r)/360; col=(int(60+150*t),int(220-40*t),int(90+20*t))
    d.ellipse([cx-r,cy-r,cx+r,cy+r],outline=col,width=6)
pts=[(cx+300*math.cos(a),cy+300*math.sin(a)) for a in [math.radians(x) for x in (-90,150,30)]]
d.polygon(pts,fill=(199,255,64))
d.ellipse([cx-70,cy-70,cx+70,cy+70],fill=(8,10,12))
d.rectangle([80,W-150,W-80,W-90],fill=(199,255,64))
img.save(${JSON.stringify(file)},"PNG")
`;
  const r = spawnSync('python3', ['-c', py], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('image render failed (python3 + PIL needed)');
}
async function pin(blob, filename) {
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', blob, filename);
  const r = await fetch(UPLOADS, { method: 'POST', headers: { Authorization: `Bearer ${PINATA_JWT}` }, body: form });
  if (!r.ok) throw new Error(`Pinata upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const cid = j.data?.cid ?? j.cid;
  if (!cid) throw new Error(`Pinata response missing cid: ${JSON.stringify(j).slice(0, 200)}`);
  return cid;
}
async function ensureMetadata(state) {
  if (state.cid) { log(`metadata pinned: ${GATEWAY}${state.cid}`); return state.cid; }
  if (!PINATA_JWT) die('PINATA_JWT missing');
  const img = path.join(STATE_DIR, 'image.png');
  if (!fs.existsSync(img)) renderImage(img);
  const imageCid = await pin(new Blob([fs.readFileSync(img)], { type: 'image/png' }), 'image.png');
  const json = {
    name: NAME, symbol: SYMBOL, description: DESCRIPTION, image: `ipfs://${imageCid}`,
    venue: 'pump', pairMint: 'So11111111111111111111111111111111111111112', pairSymbol: 'SOL', dark: true,
  };
  const cid = await pin(new Blob([JSON.stringify(json)], { type: 'application/json' }), 'metadata.json');
  for (let i = 0; i < 10; i++) { // the memo is permanent — never memo a CID that does not resolve
    const j = await fetch(GATEWAY + cid, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (j && j.name === NAME) break;
    if (i === 9) throw new Error(`metadata ${cid} does not resolve at the gateway`);
    await sleep(2000);
  }
  state.cid = cid; state.imageCid = imageCid; writeState(state);
  log(`metadata pinned + verified: ${GATEWAY}${cid}`);
  return cid;
}

// ---- find / create the canary launch -----------------------------------------
async function findOpenPumpLaunch(seq) {
  // newest launch that carries the pump marker and is not GRADUATED
  for (let i = seq - 1; i >= 0; i--) {
    if (!(await conn.getAccountInfo(pumpPda(i)))) continue;
    const acc = await conn.getAccountInfo(launchPda(i));
    if (!acc) continue;
    if (acc.owner.equals(DLP)) return { id: i, delegated: true };
    const l = decodeLaunch(acc.data);
    if (l.state !== GRADUATED) return { id: i, delegated: false, l };
  }
  return null;
}

async function main() {
  console.log('=== MAINNET PUMP CANARY: 3 traders → 0.2 SOL dark curve → pump.fun ===');
  log(`rpc ${RPC.replace(/api-key=.*/, 'api-key=…')} slot ${await conn.getSlot()}`);
  const balance = await conn.getBalance(wallet.publicKey);
  log(`wallet ${wallet.publicKey.toBase58()} = ${sol(balance)}`);

  // ---- preflight ----
  const platform = await program.account.platform.fetch(PLATFORM);
  if (!platform.admin.equals(wallet.publicKey)) die(`wallet is not the platform admin (${platform.admin.toBase58()}) — migrate-pump needs the admin`);
  const gateAcc = await conn.getAccountInfo(GATE);
  if (gateAcc) {
    const g = program.coder.accounts.decode('gate', gateAcc.data);
    if (!gateKey) die(`gate is ARMED to ${g.key.toBase58()} but GATE_KEYPAIR is not set`);
    if (!g.key.equals(gateKey.publicKey)) die(`gate is armed to ${g.key.toBase58()}, GATE_KEYPAIR is ${gateKey.publicKey.toBase58()}`);
    log(`gate armed → ${g.key.toBase58()} (co-signer loaded)`);
  } else log('gate not armed (open door)');
  const pdAcc = await conn.getAccountInfo(PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0]);
  const elf = pdAcc.data.subarray(45);
  const hasPumpLine = elf.indexOf(Buffer.from([0x00, 0xc2, 0xeb, 0x0b])) >= 0; // 200_000_000 LE immediate
  const hasEnablePump = idl.instructions.some((i) => i.name === 'enable_pump');
  if (!hasEnablePump) die('target/idl/magicpad.json has no enable_pump — anchor build first');
  log(`program ${PROGRAM_ID.toBase58()} on-chain: 0.2 SOL immediate ${hasPumpLine ? 'present' : 'ABSENT — is the 0.2 SOL build deployed?'}`);
  if (!hasPumpLine) process.exit(1);
  const routes = await fetch(ROUTER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRoutes' }),
  }).then((x) => x.json()).then((r) => r.result ?? []).catch(() => []);
  const route = routes.find((r) => r.identity === ER_VALIDATOR.toBase58());
  if (!route) die(`validator ${ER_VALIDATOR.toBase58()} not in router table (${routes.map((r) => r.fqdn).join(' ')})`);
  log(`er validator ${ER_VALIDATOR.toBase58().slice(0, 8)}… ${route.fqdn}`);

  // ---- state: resume or plan a new launch ----
  let state = readState() || { traders: [] };
  const open = await findOpenPumpLaunch(platform.launchSeq.toNumber());
  if (!open && state.id !== undefined) {
    // the previous canary finished: its traders are on-chain history now, a new
    // launch gets fresh wallets so nothing carries over between runs
    const archive = path.join(STATE_DIR, `state-launch-${state.id}.json`);
    fs.renameSync(STATE_FILE, archive);
    log(`launch ${state.id} is done — state archived to ${path.relative(root, archive)}, fresh traders for the next run`);
    state = { traders: [] };
  }
  while (state.traders.length < TRADERS) {
    state.traders.push({ wallet: Array.from(Keypair.generate().secretKey), session: Array.from(Keypair.generate().secretKey) });
  }
  writeState(state);
  const traders = state.traders.map((t) => ({ kp: kpOf(t.wallet), sk: kpOf(t.session) }));
  let id = open ? open.id : platform.launchSeq.toNumber();
  const isNew = !open;
  if (state.id !== undefined && open && state.id !== open.id) {
    log(`note: state.json says launch ${state.id} but the newest unfinished pump launch is ${open.id} — following chain`);
  }
  log(isNew ? `plan: NEW launch ${id} "${NAME}" (${SYMBOL})` : `resume: launch ${id} ${open.delegated ? '(delegated — in the ER)' : `state ${open.l.state}`}`);
  for (const [i, t] of traders.entries()) {
    log(`  trader ${i + 1} ${t.kp.publicKey.toBase58()} = ${sol(await conn.getBalance(t.kp.publicKey))}`);
  }
  const need = 80_000_000 + (fundFromWallet ? TRADERS * TRADER_FUND : 0); // pump create/claims/graduate fees paid by the keeper
  log(`cost: each trader stakes ${sol(BUY)} of its own ${sol(TRADER_FUND)} (→ pump.fun buys for the traders, rents mostly refunded) · creator pays pump.fun create + ${TRADERS + 1} buys of fees`);
  if (balance < need) die(`wallet holds ${sol(balance)}, needs about ${sol(need)} — fund it and rerun`);

  if (sweepOnly) { await sweep(traders, sweepDest); return; }
  if (statusOnly) { if (open) await printStatus(id, traders); return; }
  // The traders fund themselves. Never from this wallet — see the header.
  const unfunded = [];
  for (const [i, t] of traders.entries()) {
    const session = open ? await conn.getAccountInfo(sessionPda(id, t.kp.publicKey)) : null;
    if (session) continue; // already staked
    if ((await conn.getBalance(t.kp.publicKey)) < TRADER_FUND) unfunded.push(`  trader ${i + 1}  ${t.kp.publicKey.toBase58()}  needs ${sol(TRADER_FUND)}`);
  }
  if (unfunded.length && !fundFromWallet) {
    console.log(`\nfund these from ${unfunded.length} INDEPENDENT sources (not ${wallet.publicKey.toBase58().slice(0, 6)}…, not each other), then rerun:\n${unfunded.join('\n')}`);
    return;
  }
  if (unfunded.length) log(`--fund-from-wallet: ${wallet.publicKey.toBase58().slice(0, 6)}… tops up ${unfunded.length} trader(s) — they WILL map to the creator`);
  if (!confirm) { console.log(`\npreflight clean${unfunded.length ? '' : ', traders funded'} — run with --confirm to execute`); return; }
  if (unfunded.length) {
    for (const [i, t] of traders.entries()) {
      const bal = await conn.getBalance(t.kp.publicKey);
      if (bal >= TRADER_FUND || (open && await conn.getAccountInfo(sessionPda(id, t.kp.publicKey)))) continue;
      await send([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: t.kp.publicKey, lamports: TRADER_FUND - bal })],
        `[0] fund trader ${i + 1} ${sol(TRADER_FUND - bal)}`);
    }
  }

  // ---- 1. metadata + create + enable_pump + memo + delegate (one tx) ----
  const launch = launchPda(id), mint = mintPda(id), pump = pumpPda(id);
  if (isNew) {
    const cid = await ensureMetadata(state);
    await send([
      await program.methods.createLaunch(NAME, SYMBOL, false).accountsPartial({
        creator: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction(),
      await program.methods.enablePump(new BN(id)).accountsPartial({
        creator: wallet.publicKey, launch, pump, systemProgram: SystemProgram.programId,
      }).instruction(),
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('magicpad:meta:v1:' + cid, 'utf8') }),
      await program.methods.delegateLaunch(new BN(id)).accountsPartial({
        payer: wallet.publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
      }).remainingAccounts(validatorRemaining).instruction(),
    ], `[1] create ${id} + enable_pump + memo + delegate`);
    state.id = id; writeState(state);
  } else log(`[1] launch ${id} exists`);
  log(`  mint ${mint.toBase58()}  marker ${pump.toBase58()}`);

  // ---- 2. fund the traders, open + delegate their sessions ----
  let lAcc = await conn.getAccountInfo(launch);
  for (let i = 0; i < 20 && !lAcc?.owner.equals(DLP) && !lAcc?.owner.equals(PROGRAM_ID); i++) { await sleep(1500); lAcc = await conn.getAccountInfo(launch); }
  const homeState = lAcc.owner.equals(PROGRAM_ID) ? decodeLaunch(lAcc.data).state : null;
  if (lAcc.owner.equals(DLP)) {
    for (const [i, t] of traders.entries()) {
      const session = sessionPda(id, t.kp.publicKey);
      if (await conn.getAccountInfo(session)) { log(`[2] trader ${i + 1} session open`); continue; }
      await send([
        await program.methods.openTradeSession(new BN(id), t.sk.publicKey, new BN(DEPOSIT)).accountsPartial({
          trader: t.kp.publicKey, session, launch, systemProgram: SystemProgram.programId,
          gate: GATE, gateSigner: gateKey ? gateKey.publicKey : t.kp.publicKey,
        }).instruction(),
        await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
          payer: t.kp.publicKey, session, ...delegationMetas(session, 'Session'),
        }).remainingAccounts(validatorRemaining).instruction(),
      ], `[2] trader ${i + 1} open ${sol(DEPOSIT)} + delegate`, gateKey ? [gateKey] : [], t.kp);
    }

    // ---- 3. the dark market: three gasless buys, the third crosses 0.2 ----
    const fqdn = await erFor(launch, 'launch');
    const er = new Connection(fqdn, 'confirmed');
    let erL = decodeLaunch((await erAccount(er, launch, 'launch')).data);
    log(`[3] ER ${fqdn} launch state ${erL.state} raised ${sol(erL.realSolRaised)}`);
    for (const [i, t] of traders.entries()) {
      if (erL.state !== 0) break;
      const session = sessionPda(id, t.kp.publicKey);
      const sF = await erFor(session, `session ${i + 1}`);
      if (sF !== fqdn) throw new Error(`session ${i + 1} landed on a different ER (${sF})`);
      const erS = decodeSession((await erAccount(er, session, `session ${i + 1}`)).data);
      if (!erS.solSpent.isZero()) { log(`[3] trader ${i + 1} already bought ${sol(erS.solSpent)}`); continue; }
      // the marker is the trailing optional account: passing it is what puts the buy on the 0.2 SOL line
      await sendEr(er, [await program.methods.buy(new BN(BUY)).accountsPartial({
        sessionSigner: t.sk.publicKey, session, launch, pump,
      }).instruction()], t.sk, `[3] trader ${i + 1} ER buy ${sol(BUY)}`);
      erL = decodeLaunch((await erAccount(er, launch, 'launch')).data);
      log(`    raised ${sol(erL.realSolRaised)} state ${erL.state}${erL.state === FROZEN ? ' — FROZEN at the pump line' : ''}`);
    }
    if (erL.state < FROZEN) throw new Error(`curve did not freeze: raised ${sol(erL.realSolRaised)} < ${sol(PUMP_LINE)}`);
    assert(erL.realSolRaised.gten(PUMP_LINE), 'raised ≥ pump line');

    // ---- 4. commit home ----
    const sessions = traders.map((t) => sessionPda(id, t.kp.publicKey));
    await sendEr(er, [await program.methods.commitTradeSessions().accountsPartial({
      payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).remainingAccounts(sessions.map((s) => ({ pubkey: s, isSigner: false, isWritable: true }))).instruction()], wallet, '[4] commit_trade_sessions');
    await sendEr(er, [await program.methods.commitLaunch().accountsPartial({
      payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).instruction()], wallet, '[4] commit_launch');
    await waitUndelegated([...sessions, launch], 'sessions + launch');
  } else if (homeState === 0) {
    throw new Error(`launch ${id} is home but still BONDING — it was never delegated?`);
  } else log(`[2-4] launch ${id} already home, state ${homeState}`);

  // ---- 5. reconcile every session (cash follows ledger) ----
  let l = await program.account.launch.fetch(launch);
  log(`[5] L1 state ${l.state} raised ${sol(l.realSolRaised)} sessions ${l.sessionsReconciled}/${l.sessionsOpened}`);
  for (const [i, t] of traders.entries()) {
    const session = sessionPda(id, t.kp.publicKey);
    const sAcc = await conn.getAccountInfo(session);
    if (!sAcc) { log(`[5] trader ${i + 1} has no session (never opened)`); continue; }
    const s = decodeSession(sAcc.data);
    if (s.reconciled) { log(`[5] trader ${i + 1} reconciled`); continue; }
    await send([await program.methods.reconcileTradeSession().accountsPartial({
      trader: t.kp.publicKey, launch, session,
    }).instruction()], `[5] reconcile trader ${i + 1} (net ${sol(s.solSpent.sub(s.solProceeds))})`);
  }
  l = await program.account.launch.fetch(launch);
  assert(l.state >= RECONCILED || l.sessionsReconciled.eq(l.sessionsOpened), `all sessions reconciled (${l.sessionsReconciled}/${l.sessionsOpened})`);
  const pot = await conn.getBalance(launch);
  log(`  launch holds ${sol(pot)} — the pot that buys everyone onto pump.fun`);

  // ---- 6. migrate-pump: pump.fun token, one claim per trader, graduate ----
  if (l.state !== GRADUATED) {
    log('[6] scripts/migrate-pump.mjs --confirm');
    const r = spawnSync('node', [path.join(root, 'scripts/migrate-pump.mjs'), String(id), '--confirm'], {
      stdio: 'inherit', env: { ...process.env, RPC_URL: RPC, KEEPER_KEYPAIR: WALLET_PATH, CU_PRICE: String(CU_PRICE) },
    });
    if (r.status !== 0) throw new Error('migrate-pump failed — rerun this script to resume (every phase is idempotent)');
    l = await program.account.launch.fetch(launch);
  } else log('[6] already GRADUATED');
  assert(l.state === GRADUATED, `GRADUATED, got ${l.state}`);

  // ---- 7. verify + sweep ----
  await printStatus(id, traders);
  if (fundFromWallet) await sweep(traders, wallet.publicKey, true);
  else log('done. trader dust stays put — `sweep <dest>` drains it to a wallet that is not the creator');
  log(`wallet ${sol(await conn.getBalance(wallet.publicKey))}`);
}

// A system account may hold zero or ≥ the rent-exempt floor, nothing between:
// the sweep drains to exactly zero, fee computed from the real message.
async function sweep(traders, dest, backToFunder = false) {
  if (dest.equals(wallet.publicKey) && !backToFunder) die('refusing to sweep into the creator wallet — that is the funding edge Bubblemaps draws');
  for (const [i, t] of traders.entries()) {
    const bal = await conn.getBalance(t.kp.publicKey);
    if (bal === 0) { log(`[7] trader ${i + 1} empty`); continue; }
    const build = (lamports) => {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }),
        SystemProgram.transfer({ fromPubkey: t.kp.publicKey, toPubkey: dest, lamports }),
      );
      tx.feePayer = t.kp.publicKey;
      return tx;
    };
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const probe = build(1); probe.recentBlockhash = blockhash;
    const fee = (await conn.getFeeForMessage(probe.compileMessage(), 'confirmed')).value;
    if (fee == null || bal <= fee) { log(`[7] trader ${i + 1} holds ${bal} lamports, fee ${fee} — nothing to sweep`); continue; }
    const tx = build(bal - fee); tx.recentBlockhash = blockhash; tx.sign(t.kp);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, 'confirmed');
      log(`  [7] sweep trader ${i + 1} ${sol(bal - fee)}   ${sig}`);
    } catch (e) { log(`  sweep trader ${i + 1} failed: ${e.message.slice(0, 200)}`); }
  }
}

async function printStatus(id, traders) {
  const launch = launchPda(id);
  const lAcc = await conn.getAccountInfo(launch);
  if (lAcc.owner.equals(DLP)) { log(`launch ${id}: delegated (in the ER)`); return; }
  const l = decodeLaunch(lAcc.data);
  const pm = await program.account.pumpLaunch.fetchNullable(pumpPda(id));
  const pumpMint = pm && !pm.pumpMint.equals(PublicKey.default) ? pm.pumpMint : null;
  log(`launch ${id} ${l.symbol}: state ${l.state} raised ${sol(l.realSolRaised)} sessions ${l.sessionsReconciled}/${l.sessionsOpened} claims ${pm ? pm.claimsDone : '-'}`);
  log(`  pump mint ${pumpMint ? pumpMint.toBase58() : 'not set'}${pumpMint ? `  https://pump.fun/coin/${pumpMint.toBase58()}` : ''}`);
  for (const [i, t] of traders.entries()) {
    const sAcc = await conn.getAccountInfo(sessionPda(id, t.kp.publicKey));
    const s = sAcc ? decodeSession(sAcc.data) : null;
    let held = 'n/a';
    if (pumpMint) {
      held = await getAccount(conn, getAssociatedTokenAddressSync(pumpMint, t.kp.publicKey, true)).then((a) => (Number(a.amount) / 1e6).toFixed(0)).catch(() => '0');
    }
    log(`  trader ${i + 1}: spent ${s ? sol(s.solSpent) : '-'} held ${s ? s.tokensHeld.toString() : '-'} raw mooner · reconciled ${s ? s.reconciled : '-'} · claimed ${s ? s.tokensClaimed : '-'} · pump.fun tokens ${held}`);
  }
  const auth = (await conn.getParsedAccountInfo(mintPda(id))).value?.data?.parsed?.info?.mintAuthority ?? null;
  log(`  mooner mint authority ${auth ? auth : 'REVOKED (sealed)'}`);
}

main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });

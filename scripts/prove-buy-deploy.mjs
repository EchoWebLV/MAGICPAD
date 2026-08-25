#!/usr/bin/env node
// Buy-and-deploy, proven on live devnet: the creator's first buy rides the
// CREATION transaction itself. One atomic tx, six instructions, two signers
// (wallet + session key):
//
//   create_launch          1 SOL fee, mint born, state = BONDING
//   open_trade_session     escrow the dev buy on L1
//   buy                    L1, pre-delegation — the launch is still
//                          program-owned for two more instructions, so the
//                          same ix the ER runs gasless works here natively
//                          (litesvm has always tested it this way)
//   delegate_launch        the market goes dark WITH the curve already moved
//   delegate_trade_session the creator's session follows it into the ER
//   memo                   metadata CID, same as every launch
//
// Nothing lands on L1 undelegated for even one slot: the snapshot the ER
// clones already contains the dev buy. The creator walks away holding the
// allocation, and their session keeps trading gasless like any other.
//
//   node scripts/prove-buy-deploy.mjs [devBuySol]   # default 0.1
//
// Wallet balance swings with the stakehouse keeper sharing this key, so the
// script waits for a balance crest before spending fee + dev buy.
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
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';

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
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + '◎';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);
function assert(cond, msg) {
  if (!cond) { console.error(`✗ ASSERT FAILED: ${msg}`); process.exit(1); }
  console.log(`  ✓ ${msg}`);
}

// curve.rs buy_quote, exactly (trader-adverse +1)
const VS0 = 30_000_000_000n;
const VT0 = 1_073_000_000_000_000n;
function buyQuote(vs, vt, solIn) {
  const k = vs * vt;
  const nvt = k / (vs + solIn) + 1n;
  return nvt >= vt ? 0n : vt - nvt;
}

const delegationMetas = (target, suffix) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf, [`delegationRecord${suffix}`]: rec, [`delegationMetadata${suffix}`]: meta,
    ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
  };
};

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
  throw new Error(`router reports no ER for ${label}`);
}

async function erAccount(er, pk, label) {
  for (let i = 0; i < 20; i++) {
    const acc = await er.getAccountInfo(pk, 'confirmed').catch(() => null);
    if (acc) return acc;
    await sleep(500);
  }
  throw new Error(`${label} never appeared in the ER`);
}

const devBuy = BigInt(Math.floor(Number(process.argv[2] ?? '0.1') * LAMPORTS_PER_SOL));
const deposit = devBuy; // web mirrors this: escrow exactly the dev buy
const expectedOut = buyQuote(VS0, VT0, devBuy);

// borrow a real, resolvable CID so the launch renders art (NINE ORBS, id 4)
let cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'; // placeholder shape
const sigs4 = await conn.getSignaturesForAddress(launchPda(4), { limit: 100 }, 'confirmed');
const m4 = sigs4.find((s) => !s.err && s.memo?.includes(PREFIX));
if (m4) cid = m4.memo.slice(m4.memo.indexOf(PREFIX) + PREFIX.length);
console.log(`dev buy ${sol(devBuy)} → expected allocation ${(Number(expectedOut) / 1e6).toLocaleString()} tokens`);
console.log(`memo CID (borrowed from launch 4): ${cid}`);

console.log('\nwaiting for a wallet crest (keeper shares this key)…');
for (;;) {
  const bal = await conn.getBalance(wallet.publicKey);
  if (bal >= 1.05 * LAMPORTS_PER_SOL + Number(devBuy) + 0.02 * LAMPORTS_PER_SOL) {
    console.log(`  balance ${sol(bal)} — go`); break;
  }
  await sleep(2000);
}

const id = (await program.account.platform.fetch(PLATFORM)).launchSeq.toNumber();
const launch = launchPda(id);
const session = sessionPda(id, wallet.publicKey);
const sk = Keypair.generate(); // web derives this from the wallet signature

const tx = new Transaction().add(
  await program.methods.createLaunch('FIRST BUY', 'FIRST').accountsPartial({
    creator: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, mint: mintPda(id),
    tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
  }).instruction(),
  await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(deposit.toString())).accountsPartial({
    trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId, gateSigner: wallet.publicKey,
  }).instruction(),
  await program.methods.buy(new BN(devBuy.toString())).accountsPartial({
    sessionSigner: sk.publicKey, session, launch,
  }).instruction(),
  await program.methods.delegateLaunch(new BN(id)).accountsPartial({
    payer: wallet.publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
  }).instruction(),
  await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
    payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
  }).instruction(),
  new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(PREFIX + cid, 'utf8') }),
);
tx.feePayer = wallet.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
tx.sign(wallet, sk);
const wire = tx.serialize();
console.log(`\ncomposite tx: 6 instructions, 2 signers, ${wire.length} bytes (limit 1232)`);
assert(wire.length <= 1232, 'fits a single transaction');

const t0 = Date.now();
const sig = await conn.sendRawTransaction(wire, { skipPreflight: false });
const bh = await conn.getLatestBlockhash('confirmed');
const res = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
if (res.value.err) { console.error(`✗ tx failed: ${JSON.stringify(res.value.err)}`); process.exit(1); }
console.log(`✓ launch ${id} "FIRST BUY" born WITH the dev buy in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);

// ---- the market was never visible without the buy --------------------------
const l1Launch = await conn.getAccountInfo(launch);
const l1Session = await conn.getAccountInfo(session);
assert(l1Launch.owner.equals(DLP), 'launch delegated (DARK) in the same tx');
assert(l1Session.owner.equals(DLP), 'creator session delegated in the same tx');

const fqdn = await erFor(launch, 'launch');
const er = new Connection(fqdn, 'confirmed');
console.log(`  ER node: ${fqdn}`);
const eL = decodeLaunch((await erAccount(er, launch, 'launch')).data);
const eS = decodeSession((await erAccount(er, session, 'session')).data);
assert(BigInt(eL.virtualSol.toString()) === VS0 + devBuy,
  `ER curve carries the dev buy: virtual_sol = 30 + ${sol(devBuy)}`);
assert(eS.tokensHeld.toString() === expectedOut.toString(),
  `creator allocation exact: ${(Number(expectedOut) / 1e6).toLocaleString()} tokens (${(Number(expectedOut) / 1e13).toFixed(2)}% of supply)`);
assert(eS.solSpent.toString() === devBuy.toString(), 'ledger sol_spent == dev buy');
assert(eL.sessionsOpened.toNumber() === 1, 'sessions_opened counted the creator');

// ---- and the session trades on normally, gasless ---------------------------
// deposit == dev buy, so escrow headroom is zero — a SELL is the honest
// liveness probe (and selling frees escrow for the next buy, the exact
// position a creator lands in)
const t1 = Date.now();
const sellTok = eS.tokensHeld.divn(10);
const tx2 = new Transaction().add(await program.methods.sell(sellTok).accountsPartial({
  sessionSigner: sk.publicKey, session, launch,
}).instruction());
tx2.feePayer = sk.publicKey;
tx2.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
tx2.sign(sk);
const sig2 = await er.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
for (;;) {
  const st = (await er.getSignatureStatus(sig2).catch(() => ({ value: null }))).value;
  if (st?.err) { console.error(`✗ follow-up ER sell failed: ${JSON.stringify(st.err)}`); process.exit(1); }
  if (st?.confirmationStatus) break;
  if (Date.now() - t1 > 20_000) { console.error('✗ ER sell not confirmed in 20s'); process.exit(1); }
  await sleep(150);
}
const eS2 = decodeSession((await er.getAccountInfo(session, 'confirmed')).data);
assert(eS2.tokensHeld.eq(eS.tokensHeld.sub(sellTok)),
  `session trades on gasless post-launch (sold 10% in ${((Date.now() - t1) / 1000).toFixed(1)}s)`);

console.log(`\nBUY-AND-DEPLOY PROVEN — launch ${id} was born dark WITH the creator's`);
console.log(`position: ${sol(devBuy)} in, ${(Number(expectedOut) / 1e6).toLocaleString()} tokens held, one tx, one approval.`);

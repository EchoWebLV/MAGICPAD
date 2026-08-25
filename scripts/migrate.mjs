#!/usr/bin/env node
// Loud graduation, part two. `graduate` already parked raised SOL + leftover
// tokens on the admin wallet. This script seeds a Meteora DAMM v2 pool at
// the last curve price, burns the excess (so the pool isn't dumped), locks
// the LP, and revokes mint authority.
//
// Price-matching seed: lpTokens = raised * virtualTok / virtualSol
// so the pool opens at the same spot the curve froze. Everything else in
// the admin ATA is burned.
//
//   node scripts/migrate.mjs              # every GRADUATED launch that still needs it
//   node scripts/migrate.mjs 7            # one launch id
//   node scripts/migrate.mjs --dry        # print amounts, send nothing
//
// env: RPC_URL, KEEPER_KEYPAIR (same as keeper.mjs). METEORA_SKIP=1 no-ops.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, clusterApiUrl, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAccount, createBurnInstruction,
} from '@solana/spl-token';
import {
  CpAmm, MIN_SQRT_PRICE, MAX_SQRT_PRICE, CollectFeeMode, BaseFeeMode,
  getBaseFeeParams, ActivationType,
} from '@meteora-ag/cp-amm-sdk';

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const GRADUATED = 3;
const RECORD = path.join(root, 'scripts/migrations.json');
const PUBLIC_RECORD = path.join(root, 'apps/web/public/migrations.json');

function loadKeeper() {
  const env = process.env.KEEPER_KEYPAIR;
  if (env) {
    const raw = env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8');
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
}

const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, program)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const ata = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readRecord() {
  try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch { return {}; }
}
function writeRecord(data) {
  fs.writeFileSync(RECORD, JSON.stringify(data, null, 2) + '\n');
  try {
    fs.mkdirSync(path.dirname(PUBLIC_RECORD), { recursive: true });
    fs.writeFileSync(PUBLIC_RECORD, JSON.stringify(data, null, 2) + '\n');
  } catch { /* web public dir optional */ }
}

function lpSeed(l) {
  // tokens that keep the pool at the frozen curve spot
  const raised = l.realSolRaised;
  const vsol = l.virtualSol;
  const vtok = l.virtualTok;
  if (vsol.lten(0) || raised.lten(0)) return new BN(0);
  return raised.mul(vtok).div(vsol);
}

async function sendTx(conn, payer, tx, extra = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  if (typeof tx.version === 'number') {
    // VersionedTransaction — already built by the SDK
    tx.sign([payer, ...extra]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.partialSign(payer, ...extra);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

export async function migrateLaunch({
  conn, program, payer, id, dry = false,
}) {
  if (process.env.METEORA_SKIP) {
    log(`launch ${id}: METEORA_SKIP — leaving seed on admin`);
    return null;
  }

  const launch = pda(PROGRAM_ID, Buffer.from('launch'), le8(id));
  const mint = pda(PROGRAM_ID, Buffer.from('mint'), le8(id));
  const platform = pda(PROGRAM_ID, Buffer.from('platform'));
  const adminAta = ata(payer.publicKey, mint);

  const l = await program.account.launch.fetch(launch);
  if (l.state !== GRADUATED) {
    log(`launch ${id}: state ${l.state} — not GRADUATED`);
    return null;
  }

  const record = readRecord();
  const mintStr = mint.toBase58();
  const cpAmm = new CpAmm(conn);

  const existing = await cpAmm.fetchPoolStatesByTokenMint(mint).catch(() => []);
  let pool = existing[0]?.publicKey
    ?? (record[mintStr]?.pool ? new PublicKey(record[mintStr].pool) : null);

  const held = await getAccount(conn, adminAta).then((a) => new BN(a.amount.toString())).catch(() => new BN(0));
  const want = lpSeed(l);
  const seedTok = BN.min(want, held);
  const seedSol = l.realSolRaised;
  const burnAmt = held.sub(seedTok);

  log(`launch ${id} ${l.symbol}: seed ${sol(seedSol)} + ${seedTok.toString()} raw, burn ${burnAmt.toString()} leftover`);

  if (dry) return { pool: pool?.toBase58() ?? null, seedSol: seedSol.toString(), seedTok: seedTok.toString(), burn: burnAmt.toString() };

  if (!pool) {
    if (seedTok.lten(0) || seedSol.lten(0)) {
      log(`launch ${id}: nothing to seed`);
      return null;
    }
    const lamports = await conn.getBalance(payer.publicKey, 'confirmed');
    const need = seedSol.add(new BN(200_000_000)); // pool accounts + fees
    if (new BN(lamports).lt(need)) {
      throw new Error(`keeper holds ${sol(lamports)}, need ${sol(need)} to seed`);
    }

    const { initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
      tokenAAmount: seedTok,
      tokenBAmount: seedSol,
      minSqrtPrice: MIN_SQRT_PRICE,
      maxSqrtPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.OnlyB,
    });
    const poolFees = {
      baseFee: getBaseFeeParams({
        baseFeeMode: BaseFeeMode.FeeTimeSchedulerExponential,
        feeTimeSchedulerParam: {
          startingFeeBps: 200, // 2% at open, decays to 0.25%
          endingFeeBps: 25,
          numberOfPeriod: 24,
          totalDuration: 86_400,
        },
      }),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: null,
    };
    const positionNft = Keypair.generate();
    const { tx, pool: created, position } = await cpAmm.createCustomPool({
      payer: payer.publicKey,
      creator: payer.publicKey,
      positionNft: positionNft.publicKey,
      tokenAMint: mint,
      tokenBMint: NATIVE_MINT,
      tokenAAmount: seedTok,
      tokenBAmount: seedSol,
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      initSqrtPrice,
      liquidityDelta,
      poolFees,
      hasAlphaVault: false,
      collectFeeMode: CollectFeeMode.OnlyB,
      activationPoint: null,
      activationType: ActivationType.Timestamp,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      isLockLiquidity: true,
    });
    const sig = await sendTx(conn, payer, tx, [positionNft]);
    pool = created;
    record[mintStr] = {
      id, symbol: l.symbol, pool: pool.toBase58(), position: position.toBase58(),
      seedSol: seedSol.toString(), seedTok: seedTok.toString(), sig, at: Date.now(),
    };
    writeRecord(record);
    log(`launch ${id}: pool ${pool.toBase58()}  ${sig.slice(0, 16)}…`);
  } else {
    log(`launch ${id}: pool already ${pool.toBase58()}`);
    if (!record[mintStr]) {
      record[mintStr] = { id, symbol: l.symbol, pool: pool.toBase58(), at: Date.now() };
      writeRecord(record);
    }
  }

  if (pool) {
    const recPda = pda(PROGRAM_ID, Buffer.from('pool'), mint.toBuffer());
    const recAcc = await conn.getAccountInfo(recPda, 'confirmed');
    if (!recAcc) {
      const ix = await program.methods.recordPool(pool).accountsPartial({
        admin: payer.publicKey, platform, launch, mint,
        migratedPool: recPda, systemProgram: SystemProgram.programId,
      }).instruction();
      const sig = await sendTx(conn, payer, new Transaction().add(ix));
      log(`launch ${id}: pool recorded ${pool.toBase58()}  ${sig.slice(0, 16)}…`);
    } else {
      log(`launch ${id}: pool already on-chain`);
    }
  }

  const mintAcc = await conn.getParsedAccountInfo(mint, 'confirmed');
  const auth = mintAcc.value?.data?.parsed?.info?.mintAuthority ?? null;
  if (auth) {
    const ix = await program.methods.lockMint().accountsPartial({
      platform, launch, mint, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    const sig = await sendTx(conn, payer, new Transaction().add(ix));
    log(`launch ${id}: mint locked  ${sig.slice(0, 16)}…`);
  } else {
    log(`launch ${id}: mint already locked`);
  }

  const still = await getAccount(conn, adminAta).then((a) => new BN(a.amount.toString())).catch(() => new BN(0));
  // leftover minted at graduate = total supply − claimed. Never burn claims
  // sitting in the same ATA when the admin was also a trader.
  const TOTAL = new BN('1000000000000000');
  const leftoverMinted = TOTAL.sub(l.tokensSold);
  const toBurn = BN.max(new BN(0), BN.min(still, leftoverMinted.sub(seedTok)));
  if (toBurn.gtn(0)) {
    const burnIx = createBurnInstruction(adminAta, mint, payer.publicKey, BigInt(toBurn.toString()));
    const sig = await sendTx(conn, payer, new Transaction().add(burnIx));
    log(`launch ${id}: burned leftover ${toBurn.toString()}  ${sig.slice(0, 16)}…`);
  }

  return { pool: pool.toBase58() };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry');
  const dry = process.argv.includes('--dry');
  const keeper = loadKeeper();
  const conn = new Connection(process.env.RPC_URL || clusterApiUrl('devnet'), 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(keeper), { commitment: 'confirmed' });
  const program = new Program(idl, provider);

  const platform = await program.account.platform.fetch(pda(PROGRAM_ID, Buffer.from('platform')));
  const n = platform.launchSeq.toNumber();
  const ids = args.length ? args.map(Number) : [...Array(n).keys()];

  log(`migrate ${dry ? '(dry) ' : ''}as ${keeper.publicKey.toBase58()} · ${ids.length} launch(es)`);
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= n) {
      log(`skip ${id}: out of range`);
      continue;
    }
    try {
      await migrateLaunch({ conn, program, payer: keeper, id, dry });
    } catch (e) {
      log(`launch ${id} failed: ${(e.stack ?? e.message ?? e).toString().slice(0, 800)}`);
    }
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) main();

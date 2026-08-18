#!/usr/bin/env node
// The e2e prover: the whole MagicPad rail on live devnet infrastructure,
// with TWO traders so every lane fires for real:
//
//   trader2 (throwaway wallet) pumps, the main wallet buys the top,
//   trader2 dumps for a profit, the main wallet sells the crater for a
//   REAL realized loss. Settlement then proves:
//     - winner-first reconcile fails clean (PotNotReady) until the loser
//       lands — nobody drains an unfunded pot
//     - conservation to the lamport: net1 − profit2 == real_sol_raised ==
//       measured pot delta
//     - the loser's rakeback actually PAYS (10% of realized loss)
//     - claim_tokens mints the first real SPL this token has ever seen
//
//   node scripts/demo-trader.mjs auto          # new launch, full pipeline
//   node scripts/demo-trader.mjs resume <id>   # pick a launch back up anywhere
//   node scripts/demo-trader.mjs status <id>
//
// Every phase reads on-chain state and only does what remains, so a killed
// run resumes cleanly — the same shape the keeper crank uses.
// Session keys persist at scripts/.session-<id>-<who>.json (gitignored).
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
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ROUTER = process.env.ROUTER_URL || 'https://devnet-router.magicblock.app';
const ER_VALIDATOR = process.env.ER_VALIDATOR ? new PublicKey(process.env.ER_VALIDATOR) : null;

const rpc = process.env.RPC_URL || clusterApiUrl('devnet');
const conn = new Connection(rpc, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const RAKEBACK = pda(Buffer.from('rakeback'));
const launchPda = (id) => pda(Buffer.from('launch'), le8(id));
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
const sessionPda = (id, trader) => pda(Buffer.from('tsession'), le8(id), trader.toBuffer());
const ata = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + '◎';
const txUrl = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// program.coder works on the camelized IDL (Program converts it), so the
// account names here are camelCase — unlike a raw BorshCoder(idl)
const decodeLaunch = (d) => program.coder.accounts.decode('launch', d);
const decodeSession = (d) => program.coder.accounts.decode('tradeSession', d);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const skPath = (id, who) => path.join(root, `scripts/.session-${id}-${who}.json`);
function persistedKey(file) {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  const k = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify([...k.secretKey])); // persist BEFORE funds move
  return k;
}

// ---- L1 send with explicit signers (trader2 signs its own txs) -------------
async function sendL1(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`${label}:`, txUrl(sig));
  return sig;
}

// ---- ER plumbing: router discovery + raw gasless send ----------------------
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
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if (Date.now() - t > 20_000) throw new Error(`${label}: not confirmed in 20s`);
    await sleep(150);
  }
}

const delegationMetas = (target, suffix) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf,
    [`delegationRecord${suffix}`]: rec,
    [`delegationMetadata${suffix}`]: meta,
    ownerProgram: PROGRAM_ID,
    delegationProgram: DLP,
    systemProgram: SystemProgram.programId,
  };
};
const validatorRemaining = () => (ER_VALIDATOR
  ? [{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }] : []);

async function waitUndelegated(pubkeys, label) {
  const t0 = Date.now();
  const pending = new Set(pubkeys.map((p) => p.toBase58()));
  while (pending.size && Date.now() - t0 < 120_000) {
    for (const b58 of [...pending]) {
      const acc = await conn.getAccountInfo(new PublicKey(b58), 'confirmed').catch(() => null);
      if (acc?.owner.equals(PROGRAM_ID)) pending.delete(b58);
    }
    if (pending.size) await sleep(1500);
  }
  if (pending.size) throw new Error(`${label}: still delegated after 120s`);
  console.log(`  ${label} undelegated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---- the pipeline (auto and resume share everything from phase 2 on) -------
const DEP1 = Math.floor(0.5 * LAMPORTS_PER_SOL); // main wallet — will LOSE
const DEP2 = Math.floor(0.4 * LAMPORTS_PER_SOL); // trader2 — will WIN

async function runPipeline(id) {
  const launch = launchPda(id);
  const mint = mintPda(id);
  const trader2 = persistedKey(skPath(id, 'trader2-wallet'));
  const sk1 = persistedKey(skPath(id, 'wallet'));
  const sk2 = persistedKey(skPath(id, 'trader2'));
  const s1 = sessionPda(id, wallet.publicKey);
  const s2 = sessionPda(id, trader2.publicKey);

  console.log('\n━━ PHASE 2 · two traders, ONE approval each (L1) ━━');
  const openAndDelegate = async (trader, session, sk, dep, who) => sendL1([
    await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(dep)).accountsPartial({
      trader: trader.publicKey, session, launch, systemProgram: SystemProgram.programId,
    }).instruction(),
    await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
      payer: trader.publicKey, session, ...delegationMetas(session, 'Session'),
    }).remainingAccounts(validatorRemaining()).instruction(),
  ], [trader], `${who}: escrow ${sol(dep)} + delegate, one tx`);

  if (!(await conn.getAccountInfo(s1))) await openAndDelegate(wallet, s1, sk1, DEP1, 'wallet');
  else console.log('  wallet session already open');
  if (!(await conn.getAccountInfo(s2))) {
    await sendL1([SystemProgram.transfer({
      fromPubkey: wallet.publicKey, toPubkey: trader2.publicKey,
      lamports: DEP2 + Math.floor(0.02 * LAMPORTS_PER_SOL),
    })], [wallet], `fund trader2 ${trader2.publicKey.toBase58().slice(0, 8)}…`);
    await openAndDelegate(trader2, s2, sk2, DEP2, 'trader2');
  } else console.log('  trader2 session already open');

  // A launch already home (committed in a previous run) skips the ER leg.
  const launchHome = (await conn.getAccountInfo(launch)).owner.equals(PROGRAM_ID);
  if (!launchHome) {
    console.log('\n━━ PHASE 3 · the dark market (ER, gasless session keys) ━━');
    const fqdn = await erFor(launch, 'launch');
    for (const [pk, label] of [[s1, 'session1'], [s2, 'session2']]) {
      const f = await erFor(pk, label);
      if (f !== fqdn) throw new Error(`${label} landed on a different ER node (${f} vs ${fqdn})`);
    }
    const er = new Connection(fqdn, 'confirmed');
    console.log('  ER node:', fqdn);

    const tradeIx = (m, amt, session, sk) => program.methods[m](new BN(amt)).accountsPartial({
      sessionSigner: sk.publicKey, session, launch,
    }).instruction();
    const erSession = async (s) => decodeSession((await erAccount(er, s, 'session')).data);

    // state-aware choreography: each step keys off the ER ledger, so a
    // resumed run never double-trades
    let lState = decodeLaunch((await erAccount(er, launch, 'launch')).data);
    if (lState.state === 0) {
      const t0 = Date.now();
      let steps = 0;
      // both buys sit under the 0.5◎ first-window anti-whale cap
      if ((await erSession(s2)).solSpent.isZero()) {
        await sendEr(er, [await tradeIx('buy', Math.floor(0.35 * LAMPORTS_PER_SOL), s2, sk2)], sk2, 'trader2 pump');
        console.log('  trader2 pumps 0.35◎ (gasless)'); steps++;
      }
      if ((await erSession(s1)).solSpent.isZero()) {
        await sendEr(er, [await tradeIx('buy', Math.floor(0.20 * LAMPORTS_PER_SOL), s1, sk1)], sk1, 'wallet top buy');
        console.log('  wallet buys the top 0.20◎ (gasless)'); steps++;
      }
      const held2 = (await erSession(s2)).tokensHeld;
      if (held2.gtn(0)) {
        await sendEr(er, [await tradeIx('sell', held2, s2, sk2)], sk2, 'trader2 dump');
        console.log('  trader2 dumps ALL (gasless)'); steps++;
      }
      const e1mid = await erSession(s1);
      if (e1mid.realizedLoss.isZero() && e1mid.tokensHeld.gtn(0)) {
        await sendEr(er, [await tradeIx('sell', e1mid.tokensHeld.divn(2), s1, sk1)], sk1, 'wallet crater sell');
        console.log('  wallet sells into the crater (gasless)'); steps++;
      }
      console.log(`  ${steps} trades this run in ${Date.now() - t0}ms — zero popups, zero gas`);
    } else console.log('  market already frozen in the ER — straight to settlement');

    const e1 = await erSession(s1);
    const e2 = await erSession(s2);
    lState = decodeLaunch((await erAccount(er, launch, 'launch')).data);
    console.log(`  wallet  ledger: spent ${sol(e1.solSpent)} proceeds ${sol(e1.solProceeds)} held ${e1.tokensHeld} realized_loss ${sol(e1.realizedLoss)}`);
    console.log(`  trader2 ledger: spent ${sol(e2.solSpent)} proceeds ${sol(e2.solProceeds)} held ${e2.tokensHeld} (profit ${sol(e2.solProceeds.sub(e2.solSpent))})`);
    console.log(`  curve: raised ${sol(lState.realSolRaised)} sold ${lState.tokensSold} sessions ${lState.sessionsOpened}`);
    assert(e1.realizedLoss.gtn(0), 'wallet realized a real loss (rakeback will owe)');
    assert(e2.solProceeds.gt(e2.solSpent), 'trader2 is a net winner (pot will owe)');
    const l1Launch = await conn.getAccountInfo(launch);
    const l1Mint = await conn.getTokenSupply(mint);
    console.log(`  L1 meanwhile: launch owner = ${l1Launch.owner.equals(DLP) ? 'delegation program (DARK)' : 'program'}, mint supply = ${l1Mint.value.uiAmountString} — nothing to snipe`);

    console.log('\n━━ PHASE 4 · freeze + commit home (ER → L1) ━━');
    // fizzle path: admin freeze (the crossing-buy freeze is litesvm-proven;
    // graduation needs 5◎ raised, beyond this demo wallet)
    if (lState.state === 0) {
      await sendEr(er, [await program.methods.freezeLaunch().accountsPartial({
        admin: wallet.publicKey, platform: PLATFORM, launch,
      }).instruction()], wallet, 'freeze_launch');
      console.log('  freeze_launch: market closed (admin fizzle path)');
    }
    await sendEr(er, [await program.methods.commitTradeSessions().accountsPartial({
      payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).remainingAccounts([
      { pubkey: s1, isSigner: false, isWritable: true },
      { pubkey: s2, isSigner: false, isWritable: true },
    ]).instruction()], wallet, 'commit_trade_sessions ×2');
    await sendEr(er, [await program.methods.commitLaunch().accountsPartial({
      payer: wallet.publicKey, launch, magicProgram: MAGIC_PROGRAM, magicContext: MAGIC_CONTEXT,
    }).instruction()], wallet, 'commit_launch');
    console.log('  both commits sent — waiting for the DLP to hand the accounts home…');
    await waitUndelegated([s1, s2, launch], 'sessions + launch');
  } else console.log('\n  launch already home on L1 — straight to reconcile');

  console.log('\n━━ PHASE 5 · reconcile: cash follows ledger (L1) ━━');
  const potBefore = await conn.getBalance(launch);
  const t2Before = await conn.getBalance(trader2.publicKey);
  const preH1 = decodeSession((await conn.getAccountInfo(s1)).data);
  const preH2 = decodeSession((await conn.getAccountInfo(s2)).data);
  const fresh = !preH1.reconciled && !preH2.reconciled; // full table only on a clean pass
  const reconcileIx = (trader, session) => program.methods.reconcileTradeSession().accountsPartial({
    trader, launch, session,
  }).instruction();

  if (fresh) {
    // winner FIRST, on purpose: the pot holds nothing yet, the claim must fail
    try {
      await sendL1([await reconcileIx(trader2.publicKey, s2)], [wallet], 'reconcile winner-first');
      throw new Error('winner-first reconcile should have failed');
    } catch (e) {
      const s = `${e.message ?? e} ${JSON.stringify(e?.transactionLogs ?? e?.logs ?? '')}`;
      if (!s.includes('PotNotReady') && !s.includes('0x1781')) throw e;
      console.log('  ✓ winner-first reconcile rejected: PotNotReady (nobody drains an unfunded pot)');
    }
  }
  if (!preH1.reconciled) await sendL1([await reconcileIx(wallet.publicKey, s1)], [wallet], 'reconcile loser (net → pot)');
  if (!preH2.reconciled) await sendL1([await reconcileIx(trader2.publicKey, s2)], [wallet], 'reconcile winner (pot → profit, retry heals)');

  const potAfter = await conn.getBalance(launch);
  const t2After = await conn.getBalance(trader2.publicKey);
  const h1 = decodeSession((await conn.getAccountInfo(s1)).data);
  const h2 = decodeSession((await conn.getAccountInfo(s2)).data);
  const lHome = decodeLaunch((await conn.getAccountInfo(launch)).data);

  const net1 = h1.solSpent.sub(h1.solProceeds);            // loser: positive
  const profit2 = h2.solProceeds.sub(h2.solSpent);         // winner: positive
  const netSum = net1.sub(profit2);
  console.log('\n===== CONSERVATION TABLE (lamports, exact) =====');
  console.log(`  wallet : deposit ${h1.deposit} spent ${h1.solSpent} proceeds ${h1.solProceeds} net→pot ${net1}`);
  console.log(`  trader2: deposit ${h2.deposit} spent ${h2.solSpent} proceeds ${h2.solProceeds} profit←pot ${profit2}`);
  console.log(`  Σ nets ${netSum} | pot Δ measured ${potAfter - potBefore} | real_sol_raised ${lHome.realSolRaised}`);
  assert(lHome.realSolRaised.eq(netSum), 'real_sol_raised == Σ signed nets');
  if (fresh) {
    assert(potAfter - potBefore === netSum.toNumber(), 'pot lamport delta == Σ signed nets');
    assert(t2After - t2Before === h2.deposit.add(profit2).toNumber(),
      'trader2 received deposit + profit exactly (crank paid the fees)');
  }
  assert(lHome.state === 2 && lHome.sessionsReconciled.eq(lHome.sessionsOpened),
    `launch RECONCILED (${lHome.sessionsReconciled}/${lHome.sessionsOpened} sessions)`);

  console.log('\n━━ PHASE 6 · claims: dark bonding ends (L1) ━━');
  const traderAta = ata(wallet.publicKey, mint);
  if (!h1.tokensClaimed) {
    await sendL1([await program.methods.claimTokens().accountsPartial({
      cranker: wallet.publicKey, trader: wallet.publicKey, platform: PLATFORM,
      launch, session: s1, mint, traderAta,
      tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    }).instruction()], [wallet], 'claim_tokens (the FIRST mint of this token, ever)');
  }
  const bal = await conn.getTokenAccountBalance(traderAta);
  assert(bal.value.amount === h1.tokensHeld.toString(),
    `SPL balance ${bal.value.uiAmountString} DARK == ledger tokens_held`);
  console.log('  trader2 sold everything — no token claim to make');

  if (!h1.rakebackClaimed) {
    const wBefore = await conn.getBalance(wallet.publicKey);
    await sendL1([await program.methods.claimRakeback().accountsPartial({
      trader: wallet.publicKey, session: s1, rakebackPool: RAKEBACK,
    }).instruction()], [wallet], 'claim_rakeback');
    const rakePaid = (await conn.getBalance(wallet.publicKey)) - wBefore + 5000; // + the tx fee it paid
    const rakeOwed = h1.realizedLoss.muln(1000).divn(10000);
    assert(rakePaid === rakeOwed.toNumber(),
      `rakeback paid ${rakePaid} lamports == 10% of realized loss ${h1.realizedLoss} — the negative fee is REAL`);
  }

  // sweep the throwaway trader2 wallet home
  const t2Bal = await conn.getBalance(trader2.publicKey);
  if (t2Bal > 10_000) {
    await sendL1([SystemProgram.transfer({
      fromPubkey: trader2.publicKey, toPubkey: wallet.publicKey, lamports: t2Bal - 5000,
    })], [trader2], 'sweep trader2 → wallet');
  }

  console.log(`\nE2E COMPLETE — launch ${id} bonded dark in the ER, froze, settled to the`);
  console.log('lamport, paid the loser 10% back, and minted real SPL to the trader.');
  console.log(`wallet: ${sol(await conn.getBalance(wallet.publicKey))} · ${bal.value.uiAmountString} DARK`);
  console.log(`mint ${mint.toBase58()} · launch ${launch.toBase58()}`);
}

// ---- commands --------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'auto') {
  console.log(`wallet ${wallet.publicKey.toBase58()} · ${sol(await conn.getBalance(wallet.publicKey))}`);
  console.log('\n━━ PHASE 1 · platform + launch (L1) ━━');
  if (!(await conn.getAccountInfo(PLATFORM))) {
    await sendL1([await program.methods.initPlatform().accountsPartial({
      admin: wallet.publicKey, platform: PLATFORM, rakebackPool: RAKEBACK,
      systemProgram: SystemProgram.programId,
    }).instruction()], [wallet], 'init_platform');
  }
  await sendL1([await program.methods.fundRakeback(new BN(0.02 * LAMPORTS_PER_SOL)).accountsPartial({
    funder: wallet.publicKey, rakebackPool: RAKEBACK, systemProgram: SystemProgram.programId,
  }).instruction()], [wallet], 'fund_rakeback 0.02');

  const id = (await program.account.platform.fetch(PLATFORM)).launchSeq.toNumber();
  const launch = launchPda(id);
  await sendL1([await program.methods.createLaunch('DARKPAD', 'DARK').accountsPartial({
    creator: wallet.publicKey, platform: PLATFORM, launch, mint: mintPda(id),
    tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
  }).instruction()], [wallet], `create_launch id=${id} (1 SOL fee, mint live at supply 0)`);
  await sendL1([await program.methods.delegateLaunch(new BN(id)).accountsPartial({
    payer: wallet.publicKey, platform: PLATFORM, launch,
    ...delegationMetas(launch, 'Launch'),
  }).remainingAccounts(validatorRemaining()).instruction()],
  [wallet], 'delegate_launch — the market goes DARK');

  await runPipeline(id);
} else if (cmd === 'seed') {
  // create a launch and LEAVE it bonding with a live position — fodder for
  // the web terminal and the keeper's autonomous-settle proof
  const name = args[0] ?? 'NIGHTRUN';
  const symbol = args[1] ?? 'NIGHT';
  const buyLamports = Math.floor(Number(args[2] ?? '0.05') * LAMPORTS_PER_SOL);
  const dep = Math.floor(0.1 * LAMPORTS_PER_SOL);
  console.log(`wallet ${wallet.publicKey.toBase58()} · ${sol(await conn.getBalance(wallet.publicKey))}`);

  const id = (await program.account.platform.fetch(PLATFORM)).launchSeq.toNumber();
  const launch = launchPda(id);
  await sendL1([await program.methods.createLaunch(name, symbol).accountsPartial({
    creator: wallet.publicKey, platform: PLATFORM, launch, mint: mintPda(id),
    tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
  }).instruction()], [wallet], `create_launch id=${id} "${name}" (1 SOL fee)`);
  await sendL1([await program.methods.delegateLaunch(new BN(id)).accountsPartial({
    payer: wallet.publicKey, platform: PLATFORM, launch,
    ...delegationMetas(launch, 'Launch'),
  }).remainingAccounts(validatorRemaining()).instruction()], [wallet], 'delegate_launch');

  const sk = persistedKey(skPath(id, 'wallet'));
  const session = sessionPda(id, wallet.publicKey);
  await sendL1([
    await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(dep)).accountsPartial({
      trader: wallet.publicKey, session, launch, systemProgram: SystemProgram.programId,
    }).instruction(),
    await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
      payer: wallet.publicKey, session, ...delegationMetas(session, 'Session'),
    }).remainingAccounts(validatorRemaining()).instruction(),
  ], [wallet], `open session: escrow ${sol(dep)} + delegate`);

  const er = new Connection(await erFor(launch, 'launch'), 'confirmed');
  await erFor(session, 'session');
  await sendEr(er, [await program.methods.buy(new BN(buyLamports)).accountsPartial({
    sessionSigner: sk.publicKey, session, launch,
  }).instruction()], sk, 'seed buy');
  const l = decodeLaunch((await erAccount(er, launch, 'launch')).data);
  console.log(`seeded: launch ${id} "${name}" BONDING in the ER — raised ${sol(l.realSolRaised)} sold ${l.tokensSold}`);
  console.log(`leave it dark; freeze later with: node scripts/demo-trader.mjs freeze ${id}`);
} else if (cmd === 'freeze') {
  // admin fizzle switch — after this the keeper settles the launch on its own
  const id = Number(args[0]);
  if (!Number.isInteger(id)) throw new Error('freeze needs a launch id');
  const launch = launchPda(id);
  const er = new Connection(await erFor(launch, 'launch'), 'confirmed');
  await sendEr(er, [await program.methods.freezeLaunch().accountsPartial({
    admin: wallet.publicKey, platform: PLATFORM, launch,
  }).instruction()], wallet, 'freeze_launch');
  console.log(`launch ${id} FROZEN in the ER — the keeper takes it from here`);
} else if (cmd === 'resume') {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) throw new Error('resume needs a launch id');
  console.log(`wallet ${wallet.publicKey.toBase58()} · ${sol(await conn.getBalance(wallet.publicKey))}`);
  console.log(`resuming launch ${id}`);
  await runPipeline(id);
} else if (cmd === 'status') {
  const id = Number(args[0] ?? '0');
  const acc = await conn.getAccountInfo(launchPda(id));
  if (!acc) { console.log('no launch', id); process.exit(0); }
  if (acc.owner.equals(DLP)) {
    console.log(`launch ${id}: DARK (delegated to the ER)`);
    const er = new Connection(await erFor(launchPda(id), 'launch'), 'confirmed');
    const l = decodeLaunch((await er.getAccountInfo(launchPda(id))).data);
    console.log(`  ER state=${l.state} raised=${sol(l.realSolRaised)} sold=${l.tokensSold}`);
  } else {
    const l = decodeLaunch(acc.data);
    console.log(`launch ${id}: home. state=${l.state} raised=${sol(l.realSolRaised)} sessions ${l.sessionsReconciled}/${l.sessionsOpened}`);
  }
} else {
  console.log('commands: auto | resume <id> | status <id>');
}

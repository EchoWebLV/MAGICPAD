'use client';

/* The trade lane. One L1 approval opens the escrow and delegates the
 * session; from then on every buy/sell is a session-key transaction the
 * ER confirms in milliseconds and charges nothing for. The session key is
 * a per-launch throwaway in localStorage — losing it loses nothing but
 * the ability to trade (the escrow always reconciles home to the trader,
 * enforced on-chain). */

import { BN, utils } from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  DLP, MIN_DEPOSIT, PROGRAM_ID, TOPUP_DISCRIMINATOR, TOPUP_SPACE, connection,
  decodeLaunch, decodeSession, decodeTopUp, erConnection, erEndpointFor,
  launchPda, program, sessionPda, topupPda,
} from './magicpad';
import { WalletLike, notifyActivity, sendWithWallet } from './wallet-tx';

// keyed per launch AND per trader — switching wallets must not reuse a
// session key registered to someone else's session
const skKey = (id: number, trader: PublicKey) => `magicpad_sk_${id}_${trader.toBase58()}`;
export function sessionKeyFor(id: number, trader: PublicKey): Keypair {
  let secret: number[] | null = null;
  try { secret = JSON.parse(localStorage.getItem(skKey(id, trader)) || 'null'); } catch { /* fresh */ }
  if (!Array.isArray(secret)) {
    const k = Keypair.generate();
    localStorage.setItem(skKey(id, trader), JSON.stringify([...k.secretKey]));
    return k;
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const delegationMetas = (target: PublicKey, suffix: string) => {
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

// public devnet RPC rate-limits hard — one polite retry for user actions
async function withL1Retry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (!/429/.test(String(e?.message ?? e))) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}

/** The ONE wallet approval: escrow `deposit` lamports + delegate, in a
 *  single tx. No-op if the session already exists. */
export async function ensureTradeSession(wallet: WalletLike, id: number, deposit: number): Promise<PublicKey> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  const session = sessionPda(id, trader);
  if (await withL1Retry(() => connection.getAccountInfo(session))) return session;

  const sk = sessionKeyFor(id, trader);
  const launch = launchPda(id);
  const tx = new Transaction().add(
    await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(deposit)).accountsPartial({
      trader, session, launch, systemProgram: SystemProgram.programId,
    }).instruction(),
    await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
      payer: trader, session, ...delegationMetas(session, 'Session'),
    }).instruction(),
  );
  await withL1Retry(() => sendWithWallet(wallet, tx));
  return session;
}

/** L1 truth: every still-open top-up note for this trader+launch. Delegated
 *  notes are DLP-owned, and the DLP hosts every program's accounts — the
 *  PDA re-derivation is the identity check (discriminators alone collide).
 *  The L1 `applied` flag is a pre-delegation snapshot (always false); the
 *  sweep reads live state from the ER before acting. */
async function strandedNotes(id: number, trader: PublicKey) {
  const accounts = await connection.getProgramAccounts(DLP, {
    filters: [
      { dataSize: TOPUP_SPACE },
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(TOPUP_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: utils.bytes.bs58.encode(new BN(id).toArrayLike(Buffer, 'le', 8)) } },
      { memcmp: { offset: 16, bytes: trader.toBase58() } },
    ],
  });
  const notes: { pubkey: PublicKey; nonce: number; amount: number }[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const n = decodeTopUp(account.data);
      const nonce = (n.nonce as BN).toNumber();
      if (!topupPda(id, trader, nonce).equals(pubkey)) continue;
      notes.push({ pubkey, nonce, amount: (n.amount as BN).toNumber() });
    } catch { /* foreign account that happens to match the filters */ }
  }
  return notes;
}

/** Apply every unapplied delegated note into the session deposit; returns
 *  the lamports recovered. Best-effort — a sweep that can't run must not
 *  block a fresh top-up (unapplied notes refund in full at settle). */
async function sweepStrandedNotes(id: number, trader: PublicKey): Promise<number> {
  let recovered = 0;
  try {
    const notes = await withL1Retry(() => strandedNotes(id, trader));
    if (!notes.length) return 0;
    const er = await ensureEr(id);
    for (const n of notes) {
      const live = await er.getAccountInfo(n.pubkey, 'confirmed').catch(() => null);
      if (live) {
        try { if (decodeTopUp(live.data).applied) continue; } catch { continue; }
      }
      // unapplied in the ER, or not cloned there yet — both worth a patient try
      if (await applyNote(id, trader, n.nonce, n.amount, 8)) recovered += n.amount;
    }
  } catch { /* best-effort */ }
  return recovered;
}

async function erDeposit(id: number, trader: PublicKey): Promise<number | null> {
  try {
    const er = await ensureEr(id);
    const data = (await er.getAccountInfo(sessionPda(id, trader), 'confirmed'))?.data;
    return data ? (decodeSession(data).deposit as BN).toNumber() : null;
  } catch { return null; }
}

/** Consume one delegated note on the ER, patiently: the ER clones fresh
 *  delegations lazily, so early sends bounce. Success is measured by the
 *  deposit actually moving — a confirm timeout on an apply that landed (or
 *  an AlreadyApplied bounce from a prior attempt) still counts. */
async function applyNote(id: number, trader: PublicKey, nonce: number, amount: number, tries: number): Promise<boolean> {
  const sk = sessionKeyFor(id, trader);
  const session = sessionPda(id, trader);
  const applyIx = await program.methods.applyTopUp(new BN(nonce)).accountsPartial({
    sessionSigner: sk.publicKey, session, launch: launchPda(id), note: topupPda(id, trader, nonce),
  }).instruction();
  const baseline = await erDeposit(id, trader);
  for (let i = 0; i < tries; i++) {
    try { await sendSessionTx(id, trader, applyIx); return true; }
    catch {
      const now = await erDeposit(id, trader);
      if (baseline !== null && now !== null && now >= baseline + amount) return true;
      await new Promise((r) => setTimeout(r, Math.min(700 * (i + 1), 4000)));
    }
  }
  return false;
}

/** Raise the escrow ceiling mid-session. One L1 signature escrows the
 *  lamports in a nonce-seeded note and delegates it; the session key then
 *  consumes the note on the ER and the deposit the buys check against
 *  grows. Resolves once the ceiling has actually moved.
 *
 *  Self-healing: notes parked by earlier attempts that lost the clone race
 *  are swept in FIRST, and what they recover counts toward this top-up —
 *  the retry that used to double-park often needs no new signature at all. */
export async function topUpSession(wallet: WalletLike, id: number, lamports: number): Promise<void> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  const recovered = await sweepStrandedNotes(id, trader);
  const need = lamports - recovered;
  if (need <= 0) return;
  const amount = Math.max(need, MIN_DEPOSIT);

  const nonce = Date.now();
  const note = topupPda(id, trader, nonce);
  const session = sessionPda(id, trader);
  const launch = launchPda(id);
  const tx = new Transaction().add(
    await program.methods.topUpSession(new BN(id), new BN(nonce), new BN(amount)).accountsPartial({
      trader, session, launch, note, systemProgram: SystemProgram.programId,
    }).instruction(),
    await program.methods.delegateTopUp(new BN(id), new BN(nonce)).accountsPartial({
      payer: trader, note, ...delegationMetas(note, 'Note'),
    }).instruction(),
  );
  await withL1Retry(() => sendWithWallet(wallet, tx));

  if (!(await applyNote(id, trader, nonce, amount, 15))) {
    throw new Error('escrow parked on L1 and the rollup is still syncing it — your next buy sweeps it in automatically');
  }
}

/* The launch owner flips DLP↔program only at delegation boundaries, so the
 * L1 owner check needs refreshing rarely — everything else rides the ER. */
const darkCache = new Map<number, { dark: boolean; at: number }>();
const knownDark = (id: number) => {
  const hit = darkCache.get(id);
  return !!hit && Date.now() - hit.at < 15_000 && hit.dark;
};

/** ER connection for this launch (router-discovered, cached). */
export async function ensureEr(id: number): Promise<Connection> {
  const fqdn = await erEndpointFor(launchPda(id));
  if (!fqdn) throw new Error('market is not in the ER (router has no route)');
  return erConnection(fqdn);
}

async function sendSessionTx(id: number, trader: PublicKey, ix: any): Promise<string> {
  const er = await ensureEr(id);
  const sk = sessionKeyFor(id, trader);
  const tx = new Transaction().add(ix);
  tx.feePayer = sk.publicKey; // non-delegated payer — gasless in the ER
  tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(sk);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let t = Date.now(); Date.now() - t < 15_000;) {
    const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus) { notifyActivity(); return sig; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('ER confirm timeout');
}

export async function buyLive(trader: PublicKey, id: number, lamports: number): Promise<string> {
  const sk = sessionKeyFor(id, trader);
  return sendSessionTx(id, trader, await program.methods.buy(new BN(lamports)).accountsPartial({
    sessionSigner: sk.publicKey, session: sessionPda(id, trader), launch: launchPda(id),
  }).instruction());
}

export async function sellLive(trader: PublicKey, id: number, tokensRaw: string): Promise<string> {
  const sk = sessionKeyFor(id, trader);
  return sendSessionTx(id, trader, await program.methods.sell(new BN(tokensRaw)).accountsPartial({
    sessionSigner: sk.publicKey, session: sessionPda(id, trader), launch: launchPda(id),
  }).instruction());
}

export interface PositionView {
  deposit: number;
  solSpent: number;
  solProceeds: number;
  tokensHeld: bigint;
  costBasis: number;
  realizedLoss: number;
  reconciled: boolean;
}

/** The trader's live ledger for this launch — ER first (live market),
 *  L1 fallback (settled market). Null ONLY on positive absence (no session);
 *  an unreachable ER throws instead, so callers can hold their last-known
 *  position through a hiccup rather than flapping to "no session". */
export async function readPosition(trader: PublicKey, id: number): Promise<PositionView | null> {
  const session = sessionPda(id, trader);
  let data: Buffer | null = null;
  let answered = false; // some source POSITIVELY reported presence/absence
  try {
    const fqdn = await erEndpointFor(launchPda(id));
    if (fqdn) {
      data = (await erConnection(fqdn).getAccountInfo(session, 'confirmed'))?.data ?? null;
      answered = true;
    }
  } catch { /* ER unreachable — fall through */ }
  // on a known-dark market the session lives in the ER or nowhere — don't
  // burn an L1 request per tick confirming the obvious
  if (!data && !knownDark(id)) {
    data = (await connection.getAccountInfo(session))?.data ?? null;
    answered = true;
  }
  if (!data && !answered) throw new Error('position unreadable — ER route down this tick');
  if (!data) return null;
  const s = decodeSession(data);
  return {
    deposit: (s.deposit as BN).toNumber(),
    solSpent: (s.solSpent as BN).toNumber(),
    solProceeds: (s.solProceeds as BN).toNumber(),
    tokensHeld: BigInt((s.tokensHeld as BN).toString()),
    costBasis: (s.costBasis as BN).toNumber(),
    realizedLoss: (s.realizedLoss as BN).toNumber(),
    reconciled: s.reconciled as boolean,
  };
}

/** Live curve state for one launch — ER when dark, L1 when home. */
export async function readLaunchLive(id: number) {
  const launch = launchPda(id);
  // known-dark fast path: pure ER, zero L1 traffic
  if (knownDark(id)) {
    try {
      const fqdn = await erEndpointFor(launch);
      if (fqdn) {
        const live = await erConnection(fqdn).getAccountInfo(launch, 'confirmed');
        if (live) return { l: decodeLaunch(live.data), dark: true };
      }
    } catch { /* fall through to L1 truth */ }
  }
  const l1 = await connection.getAccountInfo(launch);
  if (!l1) return null;
  const dark = l1.owner.equals(DLP);
  darkCache.set(id, { dark, at: Date.now() });
  if (dark) {
    const fqdn = await erEndpointFor(launch);
    if (fqdn) {
      try {
        const live = await erConnection(fqdn).getAccountInfo(launch, 'confirmed');
        if (live) return { l: decodeLaunch(live.data), dark: true };
      } catch { /* stale is better than nothing */ }
    }
  }
  return { l: decodeLaunch(l1.data), dark };
}

'use client';

/* The trade lane. One L1 approval opens the escrow and delegates the
 * session; from then on every buy/sell is a session-key transaction the
 * ER confirms in milliseconds and charges nothing for.
 *
 * Trade keys, v2: the key is DERIVED from one wallet signature over a
 * fixed message. ed25519 signatures are deterministic, so every browser
 * the wallet logs into derives the SAME key — sessions are no longer
 * welded to the localStorage that opened them. When the chain disagrees
 * with what this browser derives (v1 sessions, wiped storage), the wallet
 * signs rotate_session_key on the ER and the session adopts this
 * browser's key. Losing a key loses nothing but the ability to trade —
 * the escrow always reconciles home to the trader, enforced on-chain. */

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

// ---- program errors, in human ---------------------------------------------
const PROGRAM_ERROR_TEXT: Record<number, string> = {
  6000: 'this market is closed — bonding has ended',
  6002: 'deposit is below the minimum',
  6003: 'that order is bigger than your free escrow — retry and it will top up first',
  6004: 'you are selling more tokens than you hold',
  6005: 'anti-snipe window: buy cap hit — smaller size for now',
  6010: 'trade key out of sync with this market — retry and it will re-sync',
  6011: 'the curve rejected that size — try a different amount',
  6013: 'ledger guard tripped — refresh and retry',
  6017: 'settlement pot not ready yet',
  6018: 'that top-up was already applied',
};

/** Custom program error code from any error surface we see: preflight
 *  simulation text ("custom program error: 0x177a") or a confirmed-status
 *  err object we stringified ('{"Custom":6010}'). Null if neither. */
function programErrorCode(e: unknown): number | null {
  const s = String((e as { message?: unknown })?.message ?? e);
  const hex = s.match(/custom program error: (0x[\da-f]+|\d+)/i);
  if (hex) return hex[1].toLowerCase().startsWith('0x') ? parseInt(hex[1], 16) : Number(hex[1]);
  const json = s.match(/"Custom":\s*(\d+)/);
  return json ? Number(json[1]) : null;
}

/** Raw hex never reaches the user — program errors leave here as sentences. */
function humanizeTradeError(e: unknown): Error {
  const code = programErrorCode(e);
  const text = code !== null ? PROGRAM_ERROR_TEXT[code] : undefined;
  if (text) return new Error(text);
  return e instanceof Error ? e : new Error(String(e));
}

// ---- trade keys ------------------------------------------------------------
// v1 keys were random per browser; still honored while the chain has one
// registered. The master signature is cached so the wallet signs once per
// browser, ever.
const skKey = (id: number, trader: PublicKey) => `magicpad_sk_${id}_${trader.toBase58()}`;
const masterKey = (trader: PublicKey) => `magicpad_master_${trader.toBase58()}`;

function legacyKeyFor(id: number, trader: PublicKey): Keypair | null {
  try {
    const secret = JSON.parse(localStorage.getItem(skKey(id, trader)) || 'null');
    return Array.isArray(secret) ? Keypair.fromSecretKey(Uint8Array.from(secret)) : null;
  } catch { return null; }
}

async function masterSignature(wallet: WalletLike): Promise<Uint8Array> {
  const trader = wallet.publicKey!;
  try {
    const cached = JSON.parse(localStorage.getItem(masterKey(trader)) || 'null');
    if (Array.isArray(cached) && cached.length === 64) return Uint8Array.from(cached);
  } catch { /* re-sign */ }
  if (!wallet.signMessage) throw new Error('this wallet cannot sign messages');
  const msg = new TextEncoder().encode(`MagicPad trade key v1\n${trader.toBase58()}`);
  const sig = await wallet.signMessage(msg);
  localStorage.setItem(masterKey(trader), JSON.stringify([...sig]));
  return sig;
}

/** The same (wallet, launch) pair derives the same keypair in every
 *  browser: seed = sha256(master signature ‖ launch id). */
async function derivedKeyFor(wallet: WalletLike, id: number): Promise<Keypair> {
  const sig = await masterSignature(wallet);
  const material = new Uint8Array(64 + 8);
  material.set(sig, 0);
  material.set(new BN(id).toArrayLike(Buffer, 'le', 8), 64);
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return Keypair.fromSeed(seed);
}

/** A key for a session that doesn't exist yet. Derived when the wallet can
 *  sign messages; a stored random (v1 style) when it can't. */
async function freshKeyFor(wallet: WalletLike, id: number): Promise<Keypair> {
  if (wallet.signMessage) return derivedKeyFor(wallet, id);
  const k = Keypair.generate();
  localStorage.setItem(skKey(id, wallet.publicKey!), JSON.stringify([...k.secretKey]));
  return k;
}

/** The key the chain currently demands — ER first (live truth; rotations
 *  land there), L1 snapshot as fallback. Null on positive absence. */
async function registeredKey(id: number, trader: PublicKey): Promise<PublicKey | null> {
  const session = sessionPda(id, trader);
  try {
    const er = await ensureEr(id);
    const data = (await er.getAccountInfo(session, 'confirmed'))?.data;
    if (data) return new PublicKey(decodeSession(data).sessionKey);
  } catch { /* fall through to the L1 snapshot */ }
  const l1 = (await withL1Retry(() => connection.getAccountInfo(session)))?.data;
  if (!l1) return null;
  try { return new PublicKey(decodeSession(l1).sessionKey); } catch { return null; }
}

/** The wallet re-points its session at `newKey`, inside the ER. Read-only
 *  signer, zero fee — headless with Privy, one click with an extension. */
async function rotateOnEr(wallet: WalletLike, id: number, newKey: PublicKey): Promise<void> {
  const trader = wallet.publicKey!;
  const er = await ensureEr(id);
  const tx = new Transaction().add(
    await program.methods.rotateSessionKey(newKey).accountsPartial({
      trader, session: sessionPda(id, trader),
    }).instruction(),
  );
  tx.feePayer = trader;
  tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
  const sig = await wallet.sendTransaction(tx, er, { maxRetries: 3 });
  await confirmOnEr(er, sig);
}

// one chain read per (launch, trader) per page load; dropped on a 6010 so
// the next resolution re-reads the chain
const signerMemo = new Map<string, Keypair>();
const memoKeyOf = (id: number, trader: PublicKey) => `${id}:${trader.toBase58()}`;

/** THE signer resolution: whatever key the chain expects, this browser
 *  ends up holding it — riding a still-registered v1 key, deriving the
 *  v2 key, or rotating the session when the chain disagrees with both. */
async function sessionSigner(wallet: WalletLike, id: number): Promise<Keypair> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  const hit = signerMemo.get(memoKeyOf(id, trader));
  if (hit) return hit;

  const registered = await registeredKey(id, trader);
  const settle = (k: Keypair) => { signerMemo.set(memoKeyOf(id, trader), k); return k; };

  if (!registered) return settle(await freshKeyFor(wallet, id));
  const legacy = legacyKeyFor(id, trader);
  if (legacy && registered.equals(legacy.publicKey)) return settle(legacy);
  const derived = wallet.signMessage ? await derivedKeyFor(wallet, id) : null;
  if (derived && registered.equals(derived.publicKey)) return settle(derived);

  // the chain wants a key this browser doesn't hold — the wallet rotates
  const next = derived ?? (await freshKeyFor(wallet, id));
  await rotateOnEr(wallet, id, next.publicKey);
  return settle(next);
}

/** Session key for a launch that is being created right now — resolved
 *  BEFORE the launch exists, so the creator's first buy can ride the
 *  creation tx itself. Seeds the signer memo so post-launch trading picks
 *  up the exact same keypair without another wallet signature. */
export async function launchSessionKey(wallet: WalletLike, id: number): Promise<Keypair> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  const k = await freshKeyFor(wallet, id);
  signerMemo.set(memoKeyOf(id, trader), k);
  return k;
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

  const sk = await sessionSigner(wallet, id);
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

// a sweep that found nothing stays true for a while — strays only appear
// when a top-up aborts mid-flight, and that path clears this memo
const sweepClean = new Map<string, number>();

/** Apply every unapplied delegated note into the session deposit; returns
 *  the lamports recovered. Best-effort — a sweep that can't run must not
 *  block a fresh top-up (unapplied notes refund in full at settle). */
async function sweepStrandedNotes(wallet: WalletLike, id: number): Promise<number> {
  const trader = wallet.publicKey!;
  if (Date.now() - (sweepClean.get(memoKeyOf(id, trader)) ?? 0) < 60_000) return 0;
  let recovered = 0;
  try {
    const notes = await withL1Retry(() => strandedNotes(id, trader));
    if (!notes.length) { sweepClean.set(memoKeyOf(id, trader), Date.now()); return 0; }
    const er = await ensureEr(id);
    for (const n of notes) {
      const live = await er.getAccountInfo(n.pubkey, 'confirmed').catch(() => null);
      if (live) {
        try { if (decodeTopUp(live.data).applied) continue; } catch { continue; }
      }
      // unapplied in the ER, or not cloned there yet — both worth a patient try
      if (await applyNote(wallet, id, n.nonce, n.amount, 8)) recovered += n.amount;
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
 *  an AlreadyApplied bounce from a prior attempt) still counts. Program
 *  verdicts are permanent, not race noise: a stale key re-syncs once via
 *  the signer resolution, anything else ends the loop right away. */
async function applyNote(wallet: WalletLike, id: number, nonce: number, amount: number, tries: number): Promise<boolean> {
  const trader = wallet.publicKey!;
  const session = sessionPda(id, trader);
  const note = topupPda(id, trader, nonce);
  const er = await ensureEr(id);
  const baseline = await erDeposit(id, trader);
  const applied = async () => {
    const now = await erDeposit(id, trader);
    return baseline !== null && now !== null && now >= baseline + amount;
  };
  // the ER clones delegated notes lazily; a send before the clone lands
  // just bounces through preflight. Watching for the account is cheaper
  // and catches the earliest applyable moment.
  for (const t = Date.now(); Date.now() - t < 8_000;) {
    if (await er.getAccountInfo(note, 'confirmed').catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  let healed = false;
  for (let i = 0; i < tries; i++) {
    const sk = await sessionSigner(wallet, id);
    const applyIx = await program.methods.applyTopUp(new BN(nonce)).accountsPartial({
      sessionSigner: sk.publicKey, session, launch: launchPda(id), note,
    }).instruction();
    try { await sendSessionTx(id, sk, applyIx); return true; }
    catch (e) {
      if (await applied()) return true;
      const code = programErrorCode(e);
      if (code === 6018) return true; // AlreadyApplied — the ceiling already moved
      if (code === 6010 && !healed) {
        // the chain wants a different key — drop the memo, resolve again
        healed = true;
        signerMemo.delete(memoKeyOf(id, trader));
        continue;
      }
      if (code !== null) throw humanizeTradeError(e); // any other program verdict is final
      await new Promise((r) => setTimeout(r, Math.min(400 * (i + 1), 2000)));
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
  const recovered = await sweepStrandedNotes(wallet, id);
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

  if (!(await applyNote(wallet, id, nonce, amount, 15))) {
    // a note is now parked — make sure the next attempt actually sweeps
    sweepClean.delete(memoKeyOf(id, trader));
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

async function confirmOnEr(er: Connection, sig: string): Promise<string> {
  for (let t = Date.now(); Date.now() - t < 15_000;) {
    const st = (await er.getSignatureStatus(sig).catch(() => ({ value: null }))).value;
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus) { notifyActivity(); return sig; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('ER confirm timeout');
}

async function sendSessionTx(id: number, sk: Keypair, ix: any): Promise<string> {
  const er = await ensureEr(id);
  const tx = new Transaction().add(ix);
  tx.feePayer = sk.publicKey; // non-delegated payer — gasless in the ER
  tx.recentBlockhash = (await er.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(sk);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  return confirmOnEr(er, sig);
}

/** Session tx with the self-heal: a SessionKeyMismatch means another
 *  browser rotated the session (or the chain outran our memo) — re-resolve
 *  the signer, which rotates if needed, and retry exactly once. */
async function sendHealing(
  wallet: WalletLike, id: number, buildIx: (sk: Keypair) => Promise<any>,
): Promise<string> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  let sk = await sessionSigner(wallet, id);
  try { return await sendSessionTx(id, sk, await buildIx(sk)); }
  catch (e) {
    if (programErrorCode(e) !== 6010) throw humanizeTradeError(e);
    signerMemo.delete(memoKeyOf(id, trader));
    try {
      sk = await sessionSigner(wallet, id);
      return await sendSessionTx(id, sk, await buildIx(sk));
    } catch (e2) { throw humanizeTradeError(e2); }
  }
}

export async function buyLive(wallet: WalletLike, id: number, lamports: number): Promise<string> {
  const trader = wallet.publicKey!;
  return sendHealing(wallet, id, async (sk) => program.methods.buy(new BN(lamports)).accountsPartial({
    sessionSigner: sk.publicKey, session: sessionPda(id, trader), launch: launchPda(id),
  }).instruction());
}

export async function sellLive(wallet: WalletLike, id: number, tokensRaw: string): Promise<string> {
  const trader = wallet.publicKey!;
  return sendHealing(wallet, id, async (sk) => program.methods.sell(new BN(tokensRaw)).accountsPartial({
    sessionSigner: sk.publicKey, session: sessionPda(id, trader), launch: launchPda(id),
  }).instruction());
}

/** One click, any market: open the escrow if this is the trader's first
 *  touch, raise it if the size outruns what's already in there, then buy
 *  gaslessly. The escrow legs are skipped whenever they aren't needed, so
 *  a repeat buy inside escrow stays a single ER round-trip.
 *
 *  A position that can't be read (ER hiccup) falls through to
 *  ensureTradeSession, which is itself a no-op when the session exists. */
export async function quickBuy(wallet: WalletLike, id: number, lamports: number): Promise<string> {
  const trader = wallet.publicKey;
  if (!trader) throw new Error('connect a wallet first');
  let pos: PositionView | null = null;
  try { pos = await readPosition(trader, id); } catch { /* unknown — ensure covers it */ }
  if (!pos) {
    await ensureTradeSession(wallet, id, Math.max(lamports, MIN_DEPOSIT));
  } else {
    const avail = pos.deposit + pos.solProceeds - pos.solSpent;
    if (lamports > avail) await topUpSession(wallet, id, Math.max(lamports - avail, MIN_DEPOSIT));
  }
  return buyLive(wallet, id, lamports);
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

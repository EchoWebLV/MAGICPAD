'use client';

/* The trade lane. One L1 approval opens the escrow and delegates the
 * session; from then on every buy/sell is a session-key transaction the
 * ER confirms in milliseconds and charges nothing for. The session key is
 * a per-launch throwaway in localStorage — losing it loses nothing but
 * the ability to trade (the escrow always reconciles home to the trader,
 * enforced on-chain). */

import { BN } from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  DLP, PROGRAM_ID, connection, decodeLaunch, decodeSession, erConnection,
  erEndpointFor, launchPda, program, sessionPda,
} from './magicpad';
import { WalletLike, sendWithWallet } from './wallet-tx';

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
    if (st?.confirmationStatus) return sig;
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
 *  L1 fallback (settled market). Null if no session yet. */
export async function readPosition(trader: PublicKey, id: number): Promise<PositionView | null> {
  const session = sessionPda(id, trader);
  let data: Buffer | null = null;
  try {
    const fqdn = await erEndpointFor(launchPda(id));
    if (fqdn) data = (await erConnection(fqdn).getAccountInfo(session, 'confirmed'))?.data ?? null;
  } catch { /* fall through to L1 */ }
  // on a known-dark market the session lives in the ER or nowhere — don't
  // burn an L1 request per tick confirming the obvious
  if (!data && !knownDark(id)) data = (await connection.getAccountInfo(session))?.data ?? null;
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

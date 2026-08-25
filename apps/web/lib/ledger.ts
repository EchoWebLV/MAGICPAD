/* The market's whole trail, rebuilt from chain data alone.
 *
 * Dark bonding publishes no L1 trade log while a curve runs — that is the
 * point, it is what snipers cannot read. But nothing is destroyed: escrow,
 * settlement and claims are L1 transactions on the launch account, and the
 * trades themselves are real signed transactions on the rollup's ledger.
 * Sweep both, decode every instruction, join ER session keys back to the
 * wallets that registered them, and the market reconstructs exactly.
 *
 * This module is deliberately environment-neutral: no localStorage, no
 * 'use client'. The browser terminal caches on top of it; the receipt
 * route runs the same sweep server-side and pages past the UI's cap. */

import { BN, BorshAccountsCoder, BorshInstructionCoder, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  PLATFORM, PROGRAM_ID, connection, erConnection, erEndpointFor, erLedgerEndpoints,
  launchPda, mintPda, sessionPda,
} from './core';
import idl from './idl.json';

export type HistKind =
  | 'LAUNCH' | 'DEPOSIT' | 'TOPUP' | 'BUY' | 'SELL'
  | 'FREEZE' | 'SETTLED' | 'CLAIM' | 'GRADUATED'
  | 'LOCKED' | 'POOL';

export interface HistEvent {
  sig: string;
  at: number;      // ms
  er: boolean;     // true = read from the rollup ledger
  kind: HistKind;
  signer: string;  // raw fee payer (session key for ER trades)
  sol?: number;    // lamports
  tok?: number;    // raw token units
  slot?: number;
}
export type HistRow = HistEvent & { actor: string };

const ixCoder = new BorshInstructionCoder(idl as any);
const acctCoder = new BorshAccountsCoder(idl as any);
const bnNum = (v: any) => Number(v?.toString?.() ?? v);

/* A bare BorshAccountsCoder keys off the raw IDL: PascalCase account
 * names, snake_case fields. Anchor's Program camel-cases the IDL before
 * building its own coder, which is why magicpad.ts reads `realSolRaised`.
 * Normalize here so both sides of the app see the same field names. */
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
function camelKeys(v: any): any {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === 'object' && v.constructor === Object) {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[camel(k)] = camelKeys(x);
    return o;
  }
  return v; // PublicKey, BN and Buffer pass through untouched
}

export const decodeLaunch = (d: Buffer) => camelKeys(acctCoder.decode('Launch', d));
export const decodeSession = (d: Buffer) => camelKeys(acctCoder.decode('TradeSession', d));

/** ALL activity in one tx — a buy-and-deploy creation carries LAUNCH,
 *  DEPOSIT and BUY in a single signature, and the deposit leg must still
 *  register its session key or ER trades render as raw throwaway keys.
 *  `sk` accumulates that session-key → trader map across the sweep. */
export function parseTx(
  tx: any, sig: string, er: boolean, sk: Record<string, string>, slot?: number,
): HistEvent[] {
  const msg = tx.transaction.message;
  const keys: PublicKey[] = msg.staticAccountKeys ?? msg.accountKeys;
  const signer = keys[0].toBase58();
  const at = (tx.blockTime ?? 0) * 1000;
  const out: HistEvent[] = [];
  for (const ix of msg.compiledInstructions ?? msg.instructions ?? []) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(PROGRAM_ID)) continue;
    const raw = typeof ix.data === 'string' ? utils.bytes.bs58.decode(ix.data) : ix.data;
    let dec = null;
    try { dec = ixCoder.decode(Buffer.from(raw)); } catch { /* foreign layout */ }
    if (!dec) continue;
    const a: any = dec.data;
    const base = { sig, at, er, signer, slot };
    switch (dec.name) {
      case 'create_launch': out.push({ ...base, kind: 'LAUNCH', sol: 1_000_000_000 }); break;
      case 'open_trade_session':
        sk[a.session_key.toBase58()] = signer;
        out.push({ ...base, kind: 'DEPOSIT', sol: bnNum(a.deposit) }); break;
      case 'top_up_session': out.push({ ...base, kind: 'TOPUP', sol: bnNum(a.amount) }); break;
      case 'buy': out.push({ ...base, kind: 'BUY', sol: bnNum(a.amount_in) }); break;
      case 'sell': out.push({ ...base, kind: 'SELL', tok: bnNum(a.tokens_in) }); break;
      case 'freeze_launch': out.push({ ...base, kind: 'FREEZE' }); break;
      case 'reconcile_trade_session': out.push({ ...base, kind: 'SETTLED' }); break;
      case 'claim_tokens': out.push({ ...base, kind: 'CLAIM' }); break;
      case 'graduate': out.push({ ...base, kind: 'GRADUATED' }); break;
      case 'lock_mint': out.push({ ...base, kind: 'LOCKED' }); break;
      case 'record_pool': out.push({ ...base, kind: 'POOL' }); break;
      default: break; // delegate_* / commit_* are plumbing, not activity
    }
  }
  return out;
}

export interface SweepOpts {
  /** stop after this many signatures on one layer; 0 = no ceiling */
  max?: number;
  /** ms to wait between getTransaction calls, to stay polite to public RPC */
  gapMs?: number;
  /** signatures already decoded — skipped, and added to as we go */
  seen?: Set<string>;
}

/** Every signature that ever touched an address, oldest first, paging past
 *  the 1000-per-call RPC ceiling. */
export async function allSignatures(
  conn: Connection, addr: PublicKey, max = 0,
): Promise<{ signature: string; slot: number; err: unknown }[]> {
  const acc: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(
      addr, { limit: 1000, ...(before ? { before } : {}) }, 'confirmed',
    );
    if (!page.length) break;
    acc.push(...page.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err })));
    if (max && acc.length >= max) break;
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  const trimmed = max ? acc.slice(0, max) : acc;
  return trimmed.reverse(); // oldest first: deposits register session keys before their trades
}

/** Decode one layer into events. Mutates `sk` and `opts.seen`. */
export async function sweepLayer(
  conn: Connection, addr: PublicKey, er: boolean,
  sk: Record<string, string>, opts: SweepOpts = {},
): Promise<{ events: HistEvent[]; scanned: number }> {
  const seen = opts.seen ?? new Set<string>();
  const sigs = await allSignatures(conn, addr, opts.max ?? 0);
  const events: HistEvent[] = [];
  for (const s of sigs) {
    if (seen.has(s.signature)) continue;
    if (s.err) { seen.add(s.signature); continue; } // failed txs never touched the curve
    const tx: any = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    if (!tx) continue; // not indexed yet — a later poll picks it up
    seen.add(s.signature);
    events.push(...parseTx(tx, s.signature, er, sk, s.slot));
    if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
  }
  return { events, scanned: sigs.length };
}

export interface LedgerSweep {
  events: HistEvent[];               // chronological
  rows: HistRow[];                   // same, actors resolved
  sessionKeys: Record<string, string>;
  erEndpoint: string | null;
  scanned: { l1: number; er: number };
}

/** Both layers, whole history, chronological. */
export async function sweepLedger(id: number, opts: SweepOpts = {}): Promise<LedgerSweep> {
  const launch = launchPda(id);
  const sk: Record<string, string> = {};
  const seen = opts.seen ?? new Set<string>();
  let erEndpoint: string | null = null;
  const erEvents: HistEvent[] = [];
  let erScanned = 0;

  // L1 first: it carries the open_trade_session txs that name the session
  // keys, without which ER trades cannot be attributed to a wallet.
  const l1 = await sweepLayer(connection, launch, false, sk, { ...opts, seen });

  // Then every rollup node that might still hold the ledger. `seen` dedupes,
  // so nodes that mirror each other cost one signature listing and nothing more.
  for (const fqdn of await erLedgerEndpoints(launch)) {
    try {
      const r = await sweepLayer(erConnection(fqdn), launch, true, sk, { ...opts, seen, gapMs: 0 });
      erScanned += r.scanned;
      if (r.events.length) {
        erEvents.push(...r.events);
        erEndpoint ??= fqdn;
      }
    } catch { /* node down or pruned — try the next one */ }
  }

  const events = [...l1.events, ...erEvents].sort((a, b) => a.at - b.at || (a.slot ?? 0) - (b.slot ?? 0));
  return {
    events,
    rows: events.map((e) => ({ ...e, actor: sk[e.signer] ?? e.signer })),
    sessionKeys: sk,
    erEndpoint,
    scanned: { l1: l1.scanned, er: erScanned },
  };
}

export interface SessionRow {
  pda: string;
  trader: string;
  sessionKey: string;
  deposit: number;
  solSpent: number;
  solProceeds: number;
  tokensHeld: number;
  costBasis: number;
  /** signed: positive = this trader lost into the pot, negative = took profit out */
  net: number;
  reconciled: boolean;
  tokensClaimed: boolean;
}

const toRow = (pubkey: PublicKey, data: Buffer): SessionRow => {
  const s: any = decodeSession(data);
  const spent = bnNum(s.solSpent);
  const proceeds = bnNum(s.solProceeds);
  return {
    pda: pubkey.toBase58(),
    trader: (s.trader as PublicKey).toBase58(),
    sessionKey: (s.sessionKey as PublicKey).toBase58(),
    deposit: bnNum(s.deposit),
    solSpent: spent,
    solProceeds: proceeds,
    tokensHeld: bnNum(s.tokensHeld),
    costBasis: bnNum(s.costBasis),
    net: spent - proceeds,
    reconciled: !!s.reconciled,
    tokensClaimed: !!s.tokensClaimed,
  };
};

/** Sessions for traders we already know about, read from wherever they are
 *  authoritative. While a market bonds, its session PDAs are delegated —
 *  owned by the delegation program, so an L1 getProgramAccounts sweep does
 *  not see them at all. Deriving the PDA per trader and reading it on the
 *  rollup is the only way to watch a live market's ledger. */
export async function sessionsForTraders(
  id: number, traders: string[], fqdn: string | null,
): Promise<SessionRow[]> {
  const out: SessionRow[] = [];
  for (const t of traders) {
    let trader: PublicKey;
    try { trader = new PublicKey(t); } catch { continue; }
    const pda = sessionPda(id, trader);
    for (const conn of [
      ...(fqdn ? [erConnection(fqdn)] : []), connection,
    ]) {
      try {
        const info = await conn.getAccountInfo(pda);
        if (!info || !info.data?.length) continue;
        out.push(toRow(pda, info.data as Buffer));
        break;
      } catch { /* try the other layer */ }
    }
  }
  return out;
}

/** Every escrow session opened against a launch, from the program's own
 *  accounts — the ledger the settlement math actually ran on. Only sees
 *  sessions that have come home; pair with sessionsForTraders for live ones. */
export async function sessionsFor(id: number): Promise<SessionRow[]> {
  const disc = Buffer.from(
    (idl as any).accounts.find((a: any) => a.name === 'TradeSession').discriminator,
  );
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } },
      { memcmp: { offset: 8, bytes: utils.bytes.bs58.encode(new BN(id).toArrayLike(Buffer, 'le', 8)) } },
    ],
  });
  return accts
    .map(({ pubkey, account }) => toRow(pubkey, account.data as Buffer))
    .sort((a, b) => b.deposit - a.deposit);
}

/** A launch id from either a numeric id or a mint address. Mints are PDAs
 *  seeded by id, so the mapping is a derive-and-compare over the sequence
 *  the platform account publishes — no indexer, no lookup table. */
export async function resolveLaunchId(param: string): Promise<number | null> {
  if (/^\d+$/.test(param)) {
    const id = Number(param);
    return Number.isInteger(id) && id >= 0 ? id : null;
  }
  let mint: PublicKey;
  try { mint = new PublicKey(param); } catch { return null; }
  const info = await connection.getAccountInfo(PLATFORM);
  if (!info) return null;
  const seq = bnNum(camelKeys(acctCoder.decode('Platform', info.data as Buffer)).launchSeq);
  for (let i = 0; i < seq; i++) if (mintPda(i).equals(mint)) return i;
  return null;
}

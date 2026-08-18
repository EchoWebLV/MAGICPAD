'use client';

/* Reconstructed market history. Dark bonding leaves no L1 trade log by
 * design, but the money trail is still real: escrow deposits and
 * settlement are L1 transactions on the launch account, and the trades
 * themselves sit on the ER's own ledger. This module sweeps both, joins
 * ER session signers back to the trader wallets that registered them
 * (the deposit tx carries the session key), and remembers everything in
 * localStorage so history survives reloads and ER pruning. */

import { BorshInstructionCoder, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, connection, erConnection, erEndpointFor, launchPda } from './magicpad';
import idl from './idl.json';

export type HistKind =
  | 'LAUNCH' | 'DEPOSIT' | 'TOPUP' | 'BUY' | 'SELL'
  | 'FREEZE' | 'SETTLED' | 'CLAIM' | 'RAKEBACK' | 'GRADUATED';

export interface HistEvent {
  sig: string;
  at: number;      // ms
  er: boolean;     // true = read from the rollup ledger
  kind: HistKind;
  signer: string;  // raw fee payer (session key for ER trades)
  sol?: number;    // lamports
  tok?: number;    // raw token units
}
export type HistRow = HistEvent & { actor: string };

interface Cache { events: HistEvent[]; sk: Record<string, string>; seen: string[] }

const CKEY = (id: number) => `magicpad_hist_${id}`;
const coder = new BorshInstructionCoder(idl as any);
const bnNum = (v: any) => Number(v?.toString?.() ?? v);

function load(id: number): Cache {
  try {
    const c = JSON.parse(localStorage.getItem(CKEY(id)) ?? 'null');
    if (c && Array.isArray(c.events) && Array.isArray(c.seen)) return { sk: {}, ...c };
  } catch { /* fresh */ }
  return { events: [], sk: {}, seen: [] };
}

/** ALL activity in one tx — a buy-and-deploy creation carries LAUNCH,
 *  DEPOSIT, and BUY in a single signature, and the deposit leg must still
 *  register its session key or ER trades render as raw throwaway keys. */
function parseTx(tx: any, sig: string, er: boolean, c: Cache): HistEvent[] {
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
    try { dec = coder.decode(Buffer.from(raw)); } catch { /* foreign layout */ }
    if (!dec) continue;
    const a: any = dec.data;
    switch (dec.name) {
      case 'create_launch': out.push({ sig, at, er, kind: 'LAUNCH', signer, sol: 1_000_000_000 }); break;
      case 'open_trade_session':
        c.sk[a.session_key.toBase58()] = signer;
        out.push({ sig, at, er, kind: 'DEPOSIT', signer, sol: bnNum(a.deposit) }); break;
      case 'top_up_session': out.push({ sig, at, er, kind: 'TOPUP', signer, sol: bnNum(a.amount) }); break;
      case 'buy': out.push({ sig, at, er, kind: 'BUY', signer, sol: bnNum(a.amount_in) }); break;
      case 'sell': out.push({ sig, at, er, kind: 'SELL', signer, tok: bnNum(a.tokens_in) }); break;
      case 'freeze_launch': out.push({ sig, at, er, kind: 'FREEZE', signer }); break;
      case 'reconcile_trade_session': out.push({ sig, at, er, kind: 'SETTLED', signer }); break;
      case 'claim_tokens': out.push({ sig, at, er, kind: 'CLAIM', signer }); break;
      case 'claim_rakeback': out.push({ sig, at, er, kind: 'RAKEBACK', signer }); break;
      case 'graduate': out.push({ sig, at, er, kind: 'GRADUATED', signer }); break;
      default: break; // delegate_* / commit_* are plumbing, not activity
    }
  }
  return out;
}

async function sweep(conn: Connection, id: number, er: boolean, c: Cache, seen: Set<string>, gapMs: number) {
  const sigs = await conn.getSignaturesForAddress(launchPda(id), { limit: 40 }, 'confirmed');
  for (const s of [...sigs].reverse()) { // oldest first: deposits register session keys before their trades
    if (seen.has(s.signature)) continue;
    if (s.err) { seen.add(s.signature); continue; } // failed txs never touched the curve
    const tx: any = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    if (!tx) continue; // not indexed yet — next poll
    seen.add(s.signature);
    for (const ev of parseTx(tx, s.signature, er, c)) {
      if (!c.events.some((e) => e.sig === ev.sig && e.kind === ev.kind)) c.events.push(ev);
    }
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
}

const mem = new Map<number, {
  c: Cache; seen: Set<string>; lastL1: number; inflight: Promise<HistRow[]> | null;
}>();

/** Full activity for one launch, newest first, actors resolved to trader
 *  wallets. ER swept every call (gasless node, generous limits); the L1
 *  sweep runs at most every 45s to stay polite to public devnet. */
export async function fetchHistory(id: number): Promise<HistRow[]> {
  let m = mem.get(id);
  if (!m) {
    const c = load(id);
    m = { c, seen: new Set(c.seen), lastL1: 0, inflight: null };
    mem.set(id, m);
  }
  if (m.inflight) return m.inflight;
  const me = m;
  const p = (async () => {
    try {
      const fqdn = await erEndpointFor(launchPda(id));
      if (fqdn) await sweep(erConnection(fqdn), id, true, me.c, me.seen, 0);
    } catch { /* undelegated or ER down — L1 still tells the money story */ }
    if (Date.now() - me.lastL1 > 45_000) {
      me.lastL1 = Date.now();
      try { await sweep(connection, id, false, me.c, me.seen, 250); } catch { /* next round */ }
    }
    me.c.events.sort((x, y) => y.at - x.at);
    me.c.events = me.c.events.slice(0, 60);
    me.c.seen = [...me.seen].slice(-200);
    try { localStorage.setItem(CKEY(id), JSON.stringify(me.c)); } catch { /* quota */ }
    return me.c.events.map((e) => ({ ...e, actor: me.c.sk[e.signer] ?? e.signer }));
  })();
  me.inflight = p;
  p.finally(() => { if (me.inflight === p) me.inflight = null; }).catch(() => {});
  return p;
}

'use client';

/* Deterministic curve replay. The bonding curve is pure math over
 * (virtual_sol, virtual_tok), so running the trade history through the
 * same quote functions the program uses reproduces the exact price after
 * every trade — a real chart with no indexer. Mirrors trade.rs:
 * buy: vs += in, vt -= out. sell: vs -= out, vt += tokens_in. */

import { LAMPORTS, TOKEN_TOTAL_SUPPLY, buyQuote, sellQuote } from './magicpad';
import { HistEvent } from './history';

// launch-time reserves, from programs/magicpad/src/constants.rs
const VS0 = 30_000_000_000n;
const VT0 = 1_073_000_000_000_000n;

export interface PricePoint { at: number; mcapSol: number } // at in ms
export interface ReplayOut {
  pts: PricePoint[];
  solOfSig: Record<string, number>; // lamports moved per trade sig (sells priced by replay)
  endVs: bigint; endVt: bigint;     // for verifying against the live account
}

export function replayMcap(events: HistEvent[]): ReplayOut {
  let vs = VS0;
  let vt = VT0;
  const mc = () => Number(vs) * TOKEN_TOTAL_SUPPLY / Number(vt) / LAMPORTS;
  const chron = [...events].sort((a, b) => a.at - b.at);
  const solOfSig: Record<string, number> = {};
  const pts: PricePoint[] = [{ at: (chron[0]?.at ?? Date.now()) - 1, mcapSol: mc() }];
  for (const e of chron) {
    if (e.kind === 'BUY' && e.sol) {
      const inn = BigInt(e.sol);
      const out = buyQuote(vs, vt, inn);
      vs += inn; vt -= out;
      solOfSig[e.sig] = e.sol;
    } else if (e.kind === 'SELL' && e.tok) {
      const tin = BigInt(e.tok);
      const out = sellQuote(vs, vt, tin);
      vs -= out; vt += tin;
      solOfSig[e.sig] = Number(out);
    } else continue;
    pts.push({ at: e.at, mcapSol: mc() });
  }
  return { pts, solOfSig, endVs: vs, endVt: vt };
}

export interface Candle { time: number; open: number; high: number; low: number; close: number }

/** OHLC buckets from the replay, with the live market cap pinned as the
 *  final candle so the chart always ends at now. */
export function buildCandles(pts: PricePoint[], liveMcapSol: number, bucketSec = 60): Candle[] {
  if (pts.length === 0) return [];
  const by = new Map<number, number[]>();
  const put = (b: number, v: number) => {
    const arr = by.get(b);
    if (arr) arr.push(v); else by.set(b, [v]);
  };
  for (const p of pts) put(Math.floor(p.at / 1000 / bucketSec) * bucketSec, p.mcapSol);
  put(Math.floor(Date.now() / 1000 / bucketSec) * bucketSec, liveMcapSol);
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const b of [...by.keys()].sort((a, z) => a - z)) {
    const vals = by.get(b)!;
    const open = prevClose ?? vals[0];
    const close = vals[vals.length - 1];
    out.push({ time: b, open, high: Math.max(open, ...vals), low: Math.min(open, ...vals), close });
    prevClose = close;
  }
  return out;
}

/* Deterministic curve replay. The bonding curve is pure math over
 * (virtual_sol, virtual_tok), so running the trade history through the
 * same quote functions the program uses reproduces the exact price after
 * every trade — a real chart with no indexer. Mirrors trade.rs:
 * buy: vs += in, vt -= out. sell: vs -= out, vt += tokens_in. */

import {
  LAMPORTS, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, VIRTUAL_SOL_INIT as VS0, VIRTUAL_TOK_INIT as VT0,
  buyQuote, flipTaxAt, sellQuote, weightedEntryTs,
} from './core';
import { HistEvent, HistRow } from './ledger';

export interface PricePoint {
  at: number;       // ms
  mcapSol: number;
  priceSol: number; // SOL per display token
  volSol: number;   // SOL size of this print (0 for the seed point)
}
export interface ReplayOut {
  pts: PricePoint[];
  solOfSig: Record<string, number>; // lamports moved per trade sig (sells priced by replay)
  endVs: bigint; endVt: bigint;     // for verifying against the live account
}

const priceOf = (vs: bigint, vt: bigint) =>
  Number(vs) / Number(vt) * 10 ** TOKEN_DECIMALS / LAMPORTS;
const mcapOf = (vs: bigint, vt: bigint) =>
  Number(vs) * TOKEN_TOTAL_SUPPLY / Number(vt) / LAMPORTS;

export function replayMcap(events: HistEvent[]): ReplayOut {
  let vs = VS0;
  let vt = VT0;
  const chron = [...events].sort((a, b) => a.at - b.at);
  const solOfSig: Record<string, number> = {};
  const pts: PricePoint[] = [{
    at: (chron[0]?.at ?? Date.now()) - 1,
    mcapSol: mcapOf(vs, vt),
    priceSol: priceOf(vs, vt),
    volSol: 0,
  }];
  for (const e of chron) {
    let vol = 0;
    if (e.kind === 'BUY' && e.sol) {
      const inn = BigInt(e.sol);
      const out = buyQuote(vs, vt, inn);
      vs += inn; vt -= out;
      solOfSig[e.sig] = e.sol;
      vol = e.sol / LAMPORTS;
    } else if (e.kind === 'SELL' && e.tok) {
      const tin = BigInt(e.tok);
      const out = sellQuote(vs, vt, tin);
      vs -= out; vt += tin;
      solOfSig[e.sig] = Number(out);
      vol = Number(out) / LAMPORTS;
    } else continue;
    pts.push({ at: e.at, mcapSol: mcapOf(vs, vt), priceSol: priceOf(vs, vt), volSol: vol });
  }
  return { pts, solOfSig, endVs: vs, endVt: vt };
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** OHLC buckets from the replay, with the live print pinned as the
 *  final candle so the chart always ends at now. */
export function buildCandles(
  pts: PricePoint[],
  live: number,
  bucketSec = 60,
  pick: (p: PricePoint) => number = (p) => p.mcapSol,
): Candle[] {
  if (pts.length === 0) return [];
  const by = new Map<number, { vals: number[]; vol: number }>();
  const put = (b: number, v: number, vol: number) => {
    const row = by.get(b);
    if (row) { row.vals.push(v); row.vol += vol; }
    else by.set(b, { vals: [v], vol });
  };
  for (const p of pts) put(Math.floor(p.at / 1000 / bucketSec) * bucketSec, pick(p), p.volSol);
  put(Math.floor(Date.now() / 1000 / bucketSec) * bucketSec, live, 0);
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const b of [...by.keys()].sort((a, z) => a - z)) {
    const { vals, vol } = by.get(b)!;
    const open = prevClose ?? vals[0];
    const close = vals[vals.length - 1];
    out.push({
      time: b, open, high: Math.max(open, ...vals), low: Math.min(open, ...vals), close, volume: vol,
    });
    prevClose = close;
  }
  return out;
}

export function sma(candles: Candle[], period: number): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

export interface TraderLedger {
  spent: number;
  /** net of any flip tax — directly comparable to the session's sol_proceeds */
  proceeds: number;
  tokensHeld: number;
  /** flip tax replayed at each sell's block time (0 outside fairest mode) */
  tax: number;
  /** tax bounds at ±2s of clock-vs-blocktime skew: taxLo at age+2, taxHi at age−2 */
  taxLo: number;
  taxHi: number;
}
export interface LedgerReplay {
  endVs: bigint;
  endVt: bigint;
  byTrader: Record<string, TraderLedger>;
  /** Σ tax over every sell — must land on the launch's flip_pot exactly */
  totalTax: number;
}

/* Replay that also rebuilds each trader's ledger, not just the reserves.
 *
 * The reserves alone are a weaker check than they look: constant-product
 * end state depends only on the SUM of buys and sells, so swapping two
 * same-direction trades leaves them untouched. The per-trader ledger is
 * what pins the sequence — a reordered sell fills at a different price
 * (proceeds move) and a reordered buy receives a different number of
 * tokens (tokensHeld moves). Checked against the TradeSession accounts
 * the program actually settled on, the three together leave a published
 * trade log nowhere to hide.
 *
 * Fairest mode adds one wrinkle: the program credits sellers net of the
 * flip tax. The tax is pure math over (sol_out, weighted entry ts, clock),
 * so the replay recomputes it from each trade's block time — the same
 * per-slot clock the program read. taxLo/taxHi carry a ±2s skew band so
 * one second of clock drift cannot brand an honest market a cheat; the
 * exact pot equality (Σ tax == flip_pot) is checked chain-vs-chain by the
 * caller and has no time in it at all. */
export function replayLedger(rows: HistRow[], fairMode = false): LedgerReplay {
  let vs = VS0;
  let vt = VT0;
  const byTrader: Record<string, TraderLedger> = {};
  const entryTs: Record<string, bigint> = {};
  const of = (a: string) =>
    (byTrader[a] ??= { spent: 0, proceeds: 0, tokensHeld: 0, tax: 0, taxLo: 0, taxHi: 0 });
  let totalTax = 0;
  for (const e of [...rows].sort((a, b) => a.at - b.at || (a.slot ?? 0) - (b.slot ?? 0))) {
    const now = BigInt(Math.floor(e.at / 1000));
    if (e.kind === 'BUY' && e.sol) {
      const inn = BigInt(e.sol);
      const out = buyQuote(vs, vt, inn);
      vs += inn; vt -= out;
      const t = of(e.actor);
      if (fairMode) {
        entryTs[e.actor] = weightedEntryTs(
          entryTs[e.actor] ?? 0n, BigInt(t.tokensHeld), now, out,
        );
      }
      t.spent += e.sol; t.tokensHeld += Number(out);
    } else if (e.kind === 'SELL' && e.tok) {
      const tin = BigInt(e.tok);
      const out = sellQuote(vs, vt, tin);
      vs -= out; vt += tin;
      const t = of(e.actor);
      let tax = 0n;
      if (fairMode) {
        const entry = entryTs[e.actor] ?? 0n;
        tax = flipTaxAt(out, entry, now);
        t.taxLo += Number(flipTaxAt(out, entry, now + 2n));
        t.taxHi += Number(flipTaxAt(out, entry, now - 2n));
      }
      t.tax += Number(tax);
      totalTax += Number(tax);
      t.proceeds += Number(out - tax); t.tokensHeld -= e.tok;
    }
  }
  return { endVs: vs, endVt: vt, byTrader, totalTax };
}

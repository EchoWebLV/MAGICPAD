/* The settlement receipt: everything needed to check a dark market from
 * the outside, after it is over.
 *
 * A curve that hides its order flow while it runs owes the world a proof
 * when it stops. This assembles one from chain data only — every trade
 * with its signature and slot, every escrow session with the numbers the
 * program actually settled on, and two independent reconciliations:
 *
 *   money    Σ(sol_spent − sol_proceeds) over every session == real_sol_raised.
 *            Winners were paid out of losers, and nothing else moved.
 *   ordering replaying the published trades through the program's own quote
 *            math must land on the reserves the chain is holding right now.
 *            Reorder a trade, drop one, or invent one, and it will not.
 *
 * The second is the one that matters. Conservation proves nobody stole;
 * only the replay proves the sequence we published is the sequence that
 * ran. Both are computed here and reported even when they fail. */

import { PublicKey } from '@solana/web3.js';
import {
  GRADUATION_LAMPORTS, LAMPORTS, PROGRAM_ID, RPC_URL, connection, erConnection,
  erEndpointFor, launchPda, mintPda, poolRecordPda,
} from './core';
import {
  HistRow, SessionRow, decodeLaunch, sessionsFor, sessionsForTraders, sweepLedger,
} from './ledger';
import { PricePoint, replayLedger, replayMcap } from './replay';

export const STATE = ['BONDING', 'FROZEN', 'RECONCILED', 'GRADUATED'] as const;

export interface LedgerCheck {
  trader: string;
  session: string;
  replaySpent: number; chainSpent: number;
  replayProceeds: number; chainProceeds: number;
  replayTokens: number; chainTokens: number;
  matches: boolean;
}

/* Three states, not two. A market whose rollup ledger has been pruned
 * cannot be checked — but "cannot be checked" is not "caught cheating",
 * and a receipt that conflates them would smear every old launch. */
export type Verdict = 'VERIFIED' | 'UNVERIFIABLE' | 'FAILED';

export interface Receipt {
  ok: boolean;
  verdict: Verdict;
  verdictReason: string;
  launchId: number;
  launch: string;
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  state: (typeof STATE)[number];
  createdAt: number;
  generatedAt: number;
  source: { programId: string; rpc: string; erEndpoint: string | null; live: 'er' | 'l1' };
  counts: { events: number; trades: number; sessions: number; scannedL1: number; scannedEr: number };
  events: HistRow[];
  sessions: SessionRow[];
  money: {
    realSolRaised: number;
    sumNets: number;
    balances: boolean;
    deposits: number;
    sessionsSettled: number;
    potLamports: number;
    graduationTargetLamports: number;
  };
  ordering: {
    /** end reserves: catches dropped, inserted and amount-tampered trades */
    replayVirtualSol: string;
    replayVirtualTok: string;
    chainVirtualSol: string;
    chainVirtualTok: string;
    reservesMatch: boolean;
    /** per-trader fills: catches reordering, which reserves alone cannot */
    ledger: LedgerCheck[];
    ledgerMatches: boolean;
    matches: boolean;
    note: string;
  };
  curve: PricePoint[];
  pool: string | null;
}

/** Read the launch account from wherever it is authoritative right now:
 *  the rollup while it is delegated, L1 once the state has come home. */
async function liveLaunch(id: number) {
  const pda = launchPda(id);
  const l1 = await connection.getAccountInfo(pda);
  if (!l1) return null;
  const home = decodeLaunch(l1.data as Buffer);
  const fqdn = await erEndpointFor(pda);
  if (fqdn) {
    try {
      const er = await erConnection(fqdn).getAccountInfo(pda);
      if (er) return { acct: decodeLaunch(er.data as Buffer), live: 'er' as const, fqdn, potLamports: l1.lamports };
    } catch { /* node gone — the L1 snapshot is what we have */ }
  }
  return { acct: home, live: 'l1' as const, fqdn, potLamports: l1.lamports };
}

const n = (v: any) => Number(v?.toString?.() ?? v);

export async function buildReceipt(id: number): Promise<Receipt | null> {
  const live = await liveLaunch(id);
  if (!live) return null;
  const { acct: l, potLamports } = live;

  const [sweep, homeSessions] = await Promise.all([
    sweepLedger(id, { gapMs: 0 }),
    sessionsFor(id),
  ]);

  // A bonding market's session PDAs are delegated, so the L1 sweep above
  // cannot see them. Every trader who ever opened one is named in a DEPOSIT
  // on L1 — derive their PDA and read it off the rollup instead.
  const known = new Set(homeSessions.map((s) => s.trader));
  const traders = [...new Set(sweep.rows
    .filter((e) => e.kind === 'DEPOSIT')
    .map((e) => e.actor))].filter((t) => !known.has(t));
  const liveSessions = traders.length
    ? await sessionsForTraders(id, traders, live.fqdn)
    : [];
  const sessions = [...homeSessions, ...liveSessions].sort((a, b) => b.deposit - a.deposit);

  const rep = replayMcap(sweep.events);
  const chainVs = BigInt(n(l.virtualSol));
  const chainVt = BigInt(n(l.virtualTok));
  const reservesMatch = rep.endVs === chainVs && rep.endVt === chainVt;

  // Reserves alone cannot see a reordering — replay each trader's fills and
  // hold them against the session accounts settlement actually ran on.
  const led = replayLedger(sweep.rows);
  const ledger: LedgerCheck[] = sessions.map((s) => {
    const r = led.byTrader[s.trader] ?? { spent: 0, proceeds: 0, tokensHeld: 0 };
    return {
      trader: s.trader,
      session: s.pda,
      replaySpent: r.spent, chainSpent: s.solSpent,
      replayProceeds: r.proceeds, chainProceeds: s.solProceeds,
      replayTokens: r.tokensHeld, chainTokens: s.tokensHeld,
      matches: r.spent === s.solSpent && r.proceeds === s.solProceeds
        && r.tokensHeld === s.tokensHeld,
    };
  });
  const ledgerMatches = ledger.length > 0 && ledger.every((x) => x.matches);
  const matches = reservesMatch && ledgerMatches;

  const sumNets = sessions.reduce((s, x) => s + x.net, 0);
  const settled = sessions.filter((x) => x.reconciled).length;
  const realSolRaised = n(l.realSolRaised);
  const deposits = sessions.reduce((s, x) => s + x.deposit, 0);
  const trades = sweep.events.filter((e) => e.kind === 'BUY' || e.kind === 'SELL').length;

  let pool: string | null = null;
  try {
    const rec = await connection.getAccountInfo(poolRecordPda(mintPda(id)));
    if (rec) pool = new PublicKey((rec.data as Buffer).subarray(48, 80)).toBase58();
  } catch { /* not migrated */ }

  const note = matches
    ? 'Replaying the trades above through the program’s own quote math reproduces both the reserves the chain is holding and every trader’s settled ledger. Drop a trade, insert one, change an amount by a single lamport, or swap two trades, and at least one of those numbers moves. This order flow is the one that ran.'
    : reservesMatch && !ledgerMatches
      ? 'Reserves reconcile but per-trader fills do not. Either the recovered trades are out of sequence, or sessions settled against a history this sweep could not fully reach.'
      : sessions.length === 0
        ? 'Nothing has settled yet. This market is still bonding, so there is no final ledger to check against. Reserves are compared against the rollup’s live state.'
        : 'Reserves do not reconcile against the replayed trades. Treat this market as unverified until the full rollup history is reachable.';

  /* Can this market be checked at all, and if not, why not?
   *
   * A receipt is a SETTLEMENT receipt: it renders a verdict once a market
   * is over. While one is still bonding its reserves move between reads,
   * so there is nothing stable to hold a replay against. And the rollup
   * keeps a settled market's ledger for a while, not forever — once those
   * trades are pruned the reserves cannot reconcile no matter how honest
   * the market was.
   *
   * Missing history and wrong history look nothing alike, and the sessions
   * say which is which. If the chain settled a trader for SOL our replay
   * never saw them spend, trades are missing from our sweep. If we saw the
   * same spend but computed different proceeds or tokens, the numbers
   * genuinely disagree — and only that is a failure. */
  const finalised = l.state === 2 || l.state === 3; // RECONCILED | GRADUATED
  const historyIncomplete = trades === 0
    || sessions.some((s) => (led.byTrader[s.trader]?.spent ?? 0) < s.solSpent);

  const verdict: Verdict = matches && sumNets === realSolRaised
    ? 'VERIFIED'
    : !finalised || historyIncomplete || sessions.length === 0
      ? 'UNVERIFIABLE'
      : 'FAILED';

  const verdictReason = verdict === 'VERIFIED'
    ? `Reserves and all ${sessions.length} settled ledgers reproduce exactly from the ${trades} published trades.`
    : verdict === 'FAILED'
      ? 'Every trade this market settled on was recovered, and replaying them does not reproduce the chain’s own numbers.'
      : !finalised
        ? `This market is still ${STATE[l.state] === 'FROZEN' ? 'settling' : 'bonding'}. Its reserves are still moving, so there is no final ledger to check a replay against yet. Pull this receipt again once it has settled.`
        : sessions.length === 0
          ? 'No escrow sessions were ever opened against this market, so there is nothing to reconcile.'
          : 'This market traded, but no rollup node still holds the whole ledger. The money reconciles on L1; the order flow can no longer be fully recovered, so it can be neither confirmed nor faulted.';

  return {
    ok: verdict === 'VERIFIED',
    verdict,
    verdictReason,
    launchId: id,
    launch: launchPda(id).toBase58(),
    mint: (l.mint as PublicKey).toBase58(),
    name: l.name,
    symbol: l.symbol,
    creator: (l.creator as PublicKey).toBase58(),
    state: STATE[l.state] ?? 'BONDING',
    createdAt: n(l.createdTs) * 1000,
    generatedAt: Date.now(),
    source: {
      programId: PROGRAM_ID.toBase58(),
      rpc: RPC_URL,
      erEndpoint: sweep.erEndpoint,
      live: live.live,
    },
    counts: {
      events: sweep.events.length,
      trades,
      sessions: sessions.length,
      scannedL1: sweep.scanned.l1,
      scannedEr: sweep.scanned.er,
    },
    events: sweep.rows,
    sessions,
    money: {
      realSolRaised,
      sumNets,
      balances: sumNets === realSolRaised,
      sessionsSettled: settled,
      deposits,
      potLamports,
      graduationTargetLamports: GRADUATION_LAMPORTS,
    },
    ordering: {
      replayVirtualSol: rep.endVs.toString(),
      replayVirtualTok: rep.endVt.toString(),
      chainVirtualSol: chainVs.toString(),
      chainVirtualTok: chainVt.toString(),
      reservesMatch,
      ledger,
      ledgerMatches,
      matches,
      note,
    },
    curve: rep.pts,
    pool,
  };
}

export const fmtSol = (lamports: number, dp = 4) => (lamports / LAMPORTS).toFixed(dp);

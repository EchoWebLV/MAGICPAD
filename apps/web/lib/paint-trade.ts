'use client';

/* Optimistic fill bookkeeping for the market page. The ER confirm is
 * the source of truth for "this tx landed"; the next account/history
 * read can still be a beat behind, so we paint locally and hold that
 * paint until the trader's own session has caught up. */

import { HistRow } from './history';
import { GRADUATION_LAMPORTS, MIN_DEPOSIT } from './magicpad';
import { PositionView } from './trade-live';

export const emptyPos = (): PositionView => ({
  deposit: 0, solSpent: 0, solProceeds: 0, tokensHeld: 0n,
  costBasis: 0, realizedLoss: 0, reconciled: false, tokensClaimed: false,
});

export interface CurveSnap {
  virtualSol: bigint;
  virtualTok: bigint;
  realSolRaised: number;
  tokensSold: number;
  sessionsOpened: number;
  state: number;
}

export interface PaintPending {
  vs: bigint;
  pos: PositionView;
  rows: HistRow[];
}

/** Same deposit the live `quickBuy` path actually escrows. */
export function escrowDepositAdd(
  pos: PositionView | null, buyLamports: number, avail: number,
): number {
  if (!pos) return Math.max(buyLamports, MIN_DEPOSIT);
  if (buyLamports > avail) return Math.max(buyLamports - avail, MIN_DEPOSIT);
  return 0;
}

export function bumpBuy<T extends CurveSnap>(
  live: T, pos: PositionView | null, solIn: number, tokOut: bigint, depositAdd: number,
): { live: T; pos: PositionView } {
  const first = !pos;
  const raised = live.realSolRaised + solIn;
  return {
    live: {
      ...live,
      virtualSol: live.virtualSol + BigInt(solIn),
      virtualTok: live.virtualTok - tokOut,
      realSolRaised: raised,
      tokensSold: live.tokensSold + Number(tokOut),
      sessionsOpened: live.sessionsOpened + (first ? 1 : 0),
      state: raised >= GRADUATION_LAMPORTS ? 1 : live.state,
    },
    pos: {
      ...(pos ?? emptyPos()),
      deposit: (pos?.deposit ?? 0) + depositAdd,
      solSpent: (pos?.solSpent ?? 0) + solIn,
      tokensHeld: (pos?.tokensHeld ?? 0n) + tokOut,
      costBasis: (pos?.costBasis ?? 0) + solIn,
    },
  };
}

export function bumpSell<T extends CurveSnap>(
  live: T, pos: PositionView, tokIn: bigint, solOut: number,
): { live: T; pos: PositionView } {
  const basisSlice = Number((BigInt(pos.costBasis) * tokIn) / pos.tokensHeld);
  const loss = solOut < basisSlice ? basisSlice - solOut : 0;
  return {
    live: {
      ...live,
      virtualSol: live.virtualSol - BigInt(solOut),
      virtualTok: live.virtualTok + tokIn,
      realSolRaised: live.realSolRaised - solOut,
      tokensSold: live.tokensSold - Number(tokIn),
    },
    pos: {
      ...pos,
      solProceeds: pos.solProceeds + solOut,
      tokensHeld: pos.tokensHeld - tokIn,
      costBasis: pos.costBasis - basisSlice,
      realizedLoss: pos.realizedLoss + loss,
    },
  };
}

function fillKey(e: Pick<HistRow, 'actor' | 'kind' | 'sol' | 'tok'>): string {
  return `${e.actor}:${e.kind}:${e.sol ?? ''}:${e.tok ?? ''}`;
}

/** Local rows the chain has not yet produced a counterpart for. Same-size
 *  repeats match one-for-one against real (non-`local:`) rows so two 0.1◎
 *  buys do not collapse into one. */
export function unmatchedLocals(chain: HistRow[], local: HistRow[]): HistRow[] {
  if (local.length === 0) return [];
  const used = new Set<number>();
  const extra: HistRow[] = [];
  for (const row of local) {
    const k = fillKey(row);
    const idx = chain.findIndex((e, i) => (
      !used.has(i) && !e.sig.startsWith('local:') && fillKey(e) === k
    ));
    if (idx >= 0) used.add(idx);
    else extra.push(row);
  }
  return extra;
}

export function mergeHist(chain: HistRow[], local: HistRow[]): HistRow[] {
  const extra = unmatchedLocals(chain, local);
  return extra.length ? [...extra, ...chain] : chain;
}

/** Session ledger is only written by this trader — spent/proceeds/deposit
 *  are monotonic, so catching up to the painted values means the fill is
 *  visible. No wall-clock timeout: a confirmed fill that the ER has not
 *  re-read yet must not snap back to the pre-fill snapshot. */
export function posCaughtUp(
  chain: PositionView | null | undefined, painted: PositionView,
): boolean {
  if (!chain) return false;
  return chain.solSpent >= painted.solSpent
    && chain.solProceeds >= painted.solProceeds
    && chain.deposit >= painted.deposit;
}

export function pushPending(
  hold: PaintPending | null, baselineVs: bigint, pos: PositionView, row: HistRow,
): PaintPending {
  return {
    vs: hold?.vs ?? baselineVs,
    pos,
    rows: [...(hold?.rows ?? []), row],
  };
}

'use client';

/* The browser's view of a market's history: the shared sweep in ./ledger,
 * plus a localStorage cache so the terminal survives reloads and ER
 * pruning, and a tighter signature budget than the server takes. The ER
 * is swept every call (gasless node, generous limits); the L1 sweep runs
 * at most every 45s to stay polite to public devnet. For the whole,
 * uncapped, shareable version of this same data see /api/receipt. */

import { CLUSTER, connection, erConnection, erLedgerEndpoints, launchPda } from './core';
import { HistEvent, HistKind, HistRow, sweepLayer } from './ledger';

export type { HistEvent, HistKind, HistRow };

const CKEY = (id: number) => `magicpad_hist_${CLUSTER}_${id}`; // ids restart per cluster
const UI_SIG_CAP = 40;   // newest N signatures per layer
const UI_EVENT_CAP = 60; // rows kept in the terminal

interface Cache { events: HistEvent[]; sk: Record<string, string>; seen: string[] }

function load(id: number): Cache {
  try {
    const c = JSON.parse(localStorage.getItem(CKEY(id)) ?? 'null');
    if (c && Array.isArray(c.events) && Array.isArray(c.seen)) return { sk: {}, ...c };
  } catch { /* fresh */ }
  return { events: [], sk: {}, seen: [] };
}

const mem = new Map<number, {
  c: Cache; seen: Set<string>; lastL1: number; inflight: Promise<HistRow[]> | null;
}>();

function absorb(c: Cache, events: HistEvent[]) {
  for (const ev of events) {
    if (!c.events.some((e) => e.sig === ev.sig && e.kind === ev.kind)) c.events.push(ev);
  }
}

/** Full activity for one launch, newest first, actors resolved to trader wallets. */
export async function fetchHistory(id: number): Promise<HistRow[]> {
  let m = mem.get(id);
  if (!m) {
    const c = load(id);
    m = { c, seen: new Set(c.seen), lastL1: 0, inflight: null };
    mem.set(id, m);
  }
  if (m.inflight) return m.inflight;
  const me = m;
  const launch = launchPda(id);
  const p = (async () => {
    // Ask the router first, then the known nodes. A settled market is no
    // longer routed anywhere, but its node still holds the ledger — without
    // this fallback the terminal loses every dark trade the moment a market
    // comes home, and the chart flattens to nothing.
    for (const fqdn of await erLedgerEndpoints(launch)) {
      try {
        const { events } = await sweepLayer(erConnection(fqdn), launch, true, me.c.sk,
          { max: UI_SIG_CAP, seen: me.seen });
        absorb(me.c, events);
        if (events.length) break;
      } catch { /* node down or pruned — try the next */ }
    }
    if (Date.now() - me.lastL1 > 45_000) {
      me.lastL1 = Date.now();
      try {
        const { events } = await sweepLayer(connection, launch, false, me.c.sk,
          { max: UI_SIG_CAP, gapMs: 250, seen: me.seen });
        absorb(me.c, events);
      } catch { /* next round */ }
    }
    me.c.events.sort((x, y) => y.at - x.at);
    me.c.events = me.c.events.slice(0, UI_EVENT_CAP);
    me.c.seen = [...me.seen].slice(-200);
    try { localStorage.setItem(CKEY(id), JSON.stringify(me.c)); } catch { /* quota */ }
    return me.c.events.map((e) => ({ ...e, actor: me.c.sk[e.signer] ?? e.signer }));
  })();
  me.inflight = p;
  p.finally(() => { if (me.inflight === p) me.inflight = null; }).catch(() => {});
  return p;
}

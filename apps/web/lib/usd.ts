'use client';

/* SOL/USD garnish. One public API, cached hard (module + localStorage).
 * The terminal keeps working when the feed is down — consumers always
 * handle null, and a stale price beats no price for display. */

let cached: { v: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

export async function getSolUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < 300_000) return cached.v;
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const v = (await r.json())?.solana?.usd;
      if (typeof v !== 'number') throw new Error('bad shape');
      cached = { v, at: Date.now() };
      try { localStorage.setItem('magicpad_solusd', JSON.stringify(cached)); } catch { /* fine */ }
      return v;
    } catch {
      if (!cached) {
        try { cached = JSON.parse(localStorage.getItem('magicpad_solusd') ?? 'null'); } catch { /* none */ }
      }
      return cached?.v ?? null;
    }
  })();
  inflight = p;
  p.finally(() => { if (inflight === p) inflight = null; }).catch(() => {});
  return p;
}

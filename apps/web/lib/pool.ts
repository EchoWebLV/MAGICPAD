'use client';

/** Public market after graduation. Prefer the on-chain mint-seeded pool
 *  PDA, then the local record / Meteora API, then Jupiter. */

import { PublicKey } from '@solana/web3.js';
import { connection } from './magicpad';
import { readRecordedPool } from './pool-record';

const WSOL = 'So11111111111111111111111111111111111111112';

export type PublicMarket = {
  pool: string | null;
  meteora: string | null;
  jupiter: string;
};

export function jupiterSwap(mint: string) {
  return `https://jup.ag/swap/SOL-${mint}`;
}

export function meteoraPoolUrl(pool: string) {
  return `https://app.meteora.ag/pools/${pool}`;
}

async function fromRecord(mint: string): Promise<string | null> {
  try {
    const r = await fetch('/migrations.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.[mint]?.pool ?? null;
  } catch { return null; }
}

async function fromMeteoraApi(mint: string): Promise<string | null> {
  try {
    const q = new URLSearchParams({ token_a_mint: mint, token_b_mint: WSOL });
    const r = await fetch(`https://dammv2-api.meteora.ag/pools?${q}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const row = Array.isArray(j?.data) ? j.data[0] : (Array.isArray(j) ? j[0] : null);
    return row?.pool_address || row?.address || row?.pubkey || null;
  } catch { return null; }
}

export async function findPublicMarket(mint: string): Promise<PublicMarket> {
  let pool: string | null = null;
  try {
    const rec = await readRecordedPool(connection, new PublicKey(mint));
    if (rec) pool = rec.toBase58();
  } catch { /* not a pubkey / RPC down */ }
  if (!pool) pool = (await fromRecord(mint)) || (await fromMeteoraApi(mint));
  return {
    pool,
    meteora: pool ? meteoraPoolUrl(pool) : null,
    jupiter: jupiterSwap(mint),
  };
}

'use client';

/** Public market after graduation. Prefer the on-chain mint-seeded pool
 *  PDA, then the local record / Meteora API, then Jupiter. */

import { PublicKey } from '@solana/web3.js';
import { connection } from './magicpad';
import { readRecordedPool } from './pool-record';

const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export function raydiumPoolUrl(pool: string) {
  return `https://raydium.io/liquidity/increase/?mode=add&pool_id=${pool}`;
}

const WSOL = 'So11111111111111111111111111111111111111112';

export type PublicMarket = {
  pool: string | null;
  meteora: string | null;
  raydium: string | null;
  jupiter: string;
  venue: 'meteora' | 'raydium' | null;
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
  let venue: PublicMarket['venue'] = null;
  if (pool) {
    try {
      const acc = await connection.getAccountInfo(new PublicKey(pool));
      venue = acc?.owner.equals(RAYDIUM_CPMM) ? 'raydium' : 'meteora';
    } catch { venue = 'meteora'; }
  }
  return {
    pool,
    meteora: pool && venue !== 'raydium' ? meteoraPoolUrl(pool) : null,
    raydium: pool && venue === 'raydium' ? raydiumPoolUrl(pool) : null,
    jupiter: jupiterSwap(mint),
    venue,
  };
}

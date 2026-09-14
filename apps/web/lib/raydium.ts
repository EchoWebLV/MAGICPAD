/* Raydium CPMM after a Mooner graduation. Quotes and swap txs go through
 * Raydium's HTTP APIs so the web bundle does not pull in the full SDK. */

import { NATIVE_MINT } from '@solana/spl-token';
import { Connection, PublicKey, Transaction, clusterApiUrl } from '@solana/web3.js';
import { readRecordedPool } from './pool-record';

export type SwapSide = 'buy' | 'sell';
export type SwapQuote = {
  pool: string;
  inMint: string;
  outMint: string;
  amountIn: string;
  amountOut: string;
  minOut: string;
  impact: number;
};
export type Spot = {
  pool: string;
  solPerToken: number;
  supply: string;
  mcSol: number;
  venue?: 'meteora' | 'raydium';
};

export const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const WSOL = NATIVE_MINT.toBase58();
const API = 'https://api-v3.raydium.io';
const TX = 'https://transaction-v1.raydium.io';
const SLIPPAGE_BPS = 100;
const RPC = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || clusterApiUrl('devnet');

function conn() {
  return new Connection(RPC, 'confirmed');
}

export function raydiumPoolUrl(pool: string) {
  return `https://raydium.io/liquidity/increase/?mode=add&pool_id=${pool}`;
}

export function raydiumSwapUrl(mint: string) {
  return `https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`;
}

type MintPool = { id?: string; type?: string; mintA?: { address?: string }; mintB?: { address?: string }; price?: number };

export async function findRaydiumPool(mint: string): Promise<string | null> {
  const c = conn();
  const recorded = await readRecordedPool(c, new PublicKey(mint)).catch(() => null);
  if (recorded) {
    const acc = await c.getAccountInfo(recorded, 'confirmed');
    if (acc?.owner.equals(RAYDIUM_CPMM)) return recorded.toBase58();
  }
  const q = new URLSearchParams({
    mint1: mint, mint2: WSOL, poolType: 'all', poolSortField: 'liquidity',
    sortType: 'desc', pageSize: '5', page: '1',
  });
  const r = await fetch(`${API}/pools/info/mint?${q}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  const rows: MintPool[] = j?.data?.data ?? j?.data ?? [];
  const hit = rows.find((p) => p.id && (p.mintA?.address === mint || p.mintB?.address === mint));
  return hit?.id ?? null;
}

export async function isRaydiumPool(pool: string): Promise<boolean> {
  try {
    const acc = await conn().getAccountInfo(new PublicKey(pool), 'confirmed');
    return !!acc?.owner.equals(RAYDIUM_CPMM);
  } catch { return false; }
}

export async function quoteRaydium(
  mint: string, side: SwapSide, amount: string,
): Promise<SwapQuote> {
  const inputMint = side === 'buy' ? WSOL : mint;
  const outputMint = side === 'buy' ? mint : WSOL;
  const q = new URLSearchParams({
    inputMint, outputMint, amount, slippageBps: String(SLIPPAGE_BPS), txVersion: 'LEGACY',
  });
  const r = await fetch(`${TX}/compute/swap-base-in?${q}`, { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok || !j?.success) throw new Error(j?.msg ?? 'no Raydium pool yet');
  const d = j.data;
  const pool = await findRaydiumPool(mint);
  return {
    pool: pool ?? '',
    inMint: inputMint,
    outMint: outputMint,
    amountIn: amount,
    amountOut: String(d.outputAmount ?? d.otherAmountThreshold ?? '0'),
    minOut: String(d.otherAmountThreshold ?? d.outputAmount ?? '0'),
    impact: Number(d.priceImpactPct ?? 0),
  };
}

export async function buildRaydiumSwap(
  mint: string, side: SwapSide, amount: string, user: string,
): Promise<Transaction> {
  const inputMint = side === 'buy' ? WSOL : mint;
  const outputMint = side === 'buy' ? mint : WSOL;
  const compute = await fetch(`${TX}/compute/swap-base-in?${new URLSearchParams({
    inputMint, outputMint, amount, slippageBps: String(SLIPPAGE_BPS), txVersion: 'LEGACY',
  })}`, { cache: 'no-store' }).then((r) => r.json());
  if (!compute?.success) throw new Error(compute?.msg ?? 'no Raydium route');
  const r = await fetch(`${TX}/transaction/swap-base-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: String(process.env.CU_PRICE || 50_000),
      swapResponse: compute,
      txVersion: 'LEGACY',
      wallet: user,
      wrapSol: side === 'buy',
      unwrapSol: side === 'sell',
      inputAccount: undefined,
      outputAccount: undefined,
    }),
  });
  const j = await r.json();
  const b64 = j?.data?.[0]?.transaction ?? j?.data?.transaction;
  if (!b64) throw new Error(j?.msg ?? 'Raydium did not return a transaction');
  return Transaction.from(Buffer.from(b64, 'base64'));
}

export async function spotRaydium(mint: string): Promise<Spot> {
  const pool = await findRaydiumPool(mint);
  if (!pool) throw new Error('no Raydium pool yet');
  const r = await fetch(`${API}/pools/info/ids?ids=${pool}`, { cache: 'no-store' });
  const j = await r.json();
  const row = (j?.data ?? [])[0];
  const price = Number(row?.price ?? 0);
  const mintA = row?.mintA?.address;
  const solPerToken = mintA === WSOL ? (price > 0 ? 1 / price : 0) : price;
  const c = conn();
  const supply = await c.getTokenSupply(new PublicKey(mint));
  const ui = Number(supply.value.uiAmountString ?? supply.value.uiAmount ?? 0);
  return { pool, solPerToken, supply: supply.value.amount, mcSol: solPerToken * ui, venue: 'raydium' };
}

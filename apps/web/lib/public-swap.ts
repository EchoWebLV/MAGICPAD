'use client';

import { PublicKey, Transaction } from '@solana/web3.js';
import { connection } from './magicpad';

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

export async function meteoraQuote(
  mint: string, side: SwapSide, amount: string,
): Promise<SwapQuote> {
  const q = new URLSearchParams({ mint, side, amount });
  const r = await fetch(`/api/swap/quote?${q}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'quote failed');
  return j as SwapQuote;
}

export async function meteoraSwapTx(
  mint: string, side: SwapSide, amount: string, user: string,
): Promise<Transaction> {
  const r = await fetch('/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mint, side, amount, user }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'swap failed');
  const raw = Uint8Array.from(atob(j.tx as string), (c) => c.charCodeAt(0));
  return Transaction.from(raw);
}

export type Spot = {
  pool: string;
  solPerToken: number;
  supply: string;
  mcSol: number;
};

export async function meteoraSpot(mint: string): Promise<Spot> {
  const r = await fetch(`/api/swap/spot?mint=${mint}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'spot failed');
  return j as Spot;
}

export type SplHolder = { owner: string; amount: bigint };

export async function splHolders(mint: string): Promise<SplHolder[]> {
  const r = await connection.getTokenLargestAccounts(new PublicKey(mint));
  const rows = await Promise.all(r.value.map(async (acc) => {
    const info = await connection.getParsedAccountInfo(acc.address);
    const parsed = (info.value?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed;
    return { owner: parsed?.info?.owner ?? acc.address.toBase58(), amount: BigInt(acc.amount) };
  }));
  return rows.filter((x) => x.amount > 0n);
}

/* Mint-agnostic Meteora DAMM v2 swap. Any SPL mint with a SOL pool can
 * quote and swap — Mooner graduates first, other tokens later. Server only. */

import { BN } from '@coral-xyz/anchor';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey, Transaction, clusterApiUrl } from '@solana/web3.js';
import { CpAmm, getPriceFromSqrtPrice } from '@meteora-ag/cp-amm-sdk';
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

const SLIPPAGE_BPS = 100; // 1%
const RPC = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || clusterApiUrl('devnet');

function conn() {
  return new Connection(RPC, 'confirmed');
}

function amm() {
  return new CpAmm(conn());
}

async function tokenProgramOf(c: Connection, mint: PublicKey): Promise<PublicKey> {
  const acc = await c.getAccountInfo(mint, 'confirmed');
  if (!acc) throw new Error('mint not found');
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function decimalsOf(c: Connection, mint: PublicKey): Promise<number> {
  const acc = await c.getParsedAccountInfo(mint, 'confirmed');
  const parsed = (acc.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed;
  const d = parsed?.info?.decimals;
  if (typeof d !== 'number') throw new Error('mint decimals unread');
  return d;
}

/** Prefer the on-chain Mooner record, then any SOL pair. Works for any mint. */
export async function findSolPool(mint: PublicKey) {
  const c = conn();
  const recorded = await readRecordedPool(c, mint);
  if (recorded) {
    try {
      const account = await amm().fetchPoolState(recorded);
      return { publicKey: recorded, account };
    } catch { /* recorded address stale — fall through */ }
  }
  const pools = await amm().fetchPoolStatesByTokenMint(mint);
  const solPair = pools.find(({ account }) =>
    account.tokenAMint.equals(NATIVE_MINT) || account.tokenBMint.equals(NATIVE_MINT));
  return solPair ?? pools[0] ?? null;
}

export async function quoteMeteora(
  mintStr: string, side: SwapSide, amountInStr: string,
): Promise<SwapQuote> {
  const mint = new PublicKey(mintStr);
  const amountIn = new BN(amountInStr);
  if (amountIn.lten(0)) throw new Error('amount must be > 0');

  const hit = await findSolPool(mint);
  if (!hit) throw new Error('no Meteora pool yet');

  const c = conn();
  const { publicKey: pool, account: poolState } = hit;
  const inputTokenMint = side === 'buy' ? NATIVE_MINT : mint;
  const outputTokenMint = side === 'buy' ? mint : NATIVE_MINT;
  if (!poolState.tokenAMint.equals(inputTokenMint) && !poolState.tokenBMint.equals(inputTokenMint)) {
    throw new Error('pool is not a SOL pair');
  }

  const [tokenADecimal, tokenBDecimal, slot] = await Promise.all([
    decimalsOf(c, poolState.tokenAMint),
    decimalsOf(c, poolState.tokenBMint),
    c.getSlot('confirmed'),
  ]);

  const q = amm().getQuote({
    inAmount: amountIn,
    inputTokenMint,
    slippage: SLIPPAGE_BPS,
    poolState,
    currentTime: Math.floor(Date.now() / 1000),
    currentSlot: slot,
    tokenADecimal,
    tokenBDecimal,
  });

  return {
    pool: pool.toBase58(),
    inMint: inputTokenMint.toBase58(),
    outMint: outputTokenMint.toBase58(),
    amountIn: amountIn.toString(),
    amountOut: q.swapOutAmount.toString(),
    minOut: q.minSwapOutAmount.toString(),
    impact: Number(q.priceImpact.toString()),
  };
}

export async function buildMeteoraSwap(
  mintStr: string, side: SwapSide, amountInStr: string, userStr: string,
): Promise<Transaction> {
  const mint = new PublicKey(mintStr);
  const user = new PublicKey(userStr);
  const quote = await quoteMeteora(mintStr, side, amountInStr);
  const hit = await findSolPool(mint);
  if (!hit) throw new Error('no Meteora pool yet');

  const c = conn();
  const { publicKey: pool, account: poolState } = hit;
  const inputTokenMint = new PublicKey(quote.inMint);
  const outputTokenMint = new PublicKey(quote.outMint);
  const [tokenAProgram, tokenBProgram] = await Promise.all([
    tokenProgramOf(c, poolState.tokenAMint),
    tokenProgramOf(c, poolState.tokenBMint),
  ]);

  return await amm().swap({
    payer: user,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn: new BN(quote.amountIn),
    minimumAmountOut: new BN(quote.minOut),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram,
    tokenBProgram,
    referralTokenAccount: null,
    poolState,
  });
}

export type Spot = {
  pool: string;
  solPerToken: number; // UI SOL per UI token
  supply: string;
  mcSol: number;
};

export async function spotMeteora(mintStr: string): Promise<Spot> {
  const mint = new PublicKey(mintStr);
  const hit = await findSolPool(mint);
  if (!hit) throw new Error('no Meteora pool yet');
  const c = conn();
  const { publicKey: pool, account: ps } = hit;
  const [aDec, bDec, supply] = await Promise.all([
    decimalsOf(c, ps.tokenAMint),
    decimalsOf(c, ps.tokenBMint),
    c.getTokenSupply(mint),
  ]);
  const raw = getPriceFromSqrtPrice(ps.sqrtPrice, aDec, bDec).toNumber();
  // price is tokenB per tokenA. We want SOL per project token.
  const aIsSol = ps.tokenAMint.equals(NATIVE_MINT);
  const solPerToken = aIsSol ? (raw > 0 ? 1 / raw : 0) : raw;
  const ui = Number(supply.value.uiAmountString ?? supply.value.uiAmount ?? 0);
  return {
    pool: pool.toBase58(),
    solPerToken,
    supply: supply.value.amount,
    mcSol: solPerToken * ui,
  };
}

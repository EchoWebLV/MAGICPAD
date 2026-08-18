'use client';

/* The chain rail, client-side and read-frugal (stakehouse rules): one
 * getProgramAccounts sweep per poll window, 2.5s memo, fail-fast on 429s.
 * A launch lives in one of two places — home under the program, or DARK
 * under the delegation program while it bonds inside the ER. The L1 copy
 * of a dark launch is a stale pre-delegation snapshot, so live curve
 * numbers come from the ER node the router points at. */

import { AnchorProvider, BN, Program, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import idl from './idl.json';

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl('devnet');
export const ROUTER = process.env.NEXT_PUBLIC_ROUTER_URL || 'https://devnet-router.magicblock.app';
export const PROGRAM_ID = new PublicKey((idl as any).address);
export const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
export const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export const LAMPORTS = 1_000_000_000;
export const GRADUATION_LAMPORTS = 5 * LAMPORTS;
export const TOKEN_DECIMALS = 6;
export const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000; // raw units
export const FIRST_WINDOW_MAX_BUY = 0.5 * LAMPORTS;
export const MIN_DEPOSIT = 0.01 * LAMPORTS;

export const connection = new Connection(RPC_URL, {
  commitment: 'confirmed', disableRetryOnRateLimit: true,
});

const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const PLATFORM = pda(Buffer.from('platform'));
export const RAKEBACK = pda(Buffer.from('rakeback'));
export const launchPda = (id: number) =>
  pda(Buffer.from('launch'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const mintPda = (id: number) =>
  pda(Buffer.from('mint'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const sessionPda = (id: number, trader: PublicKey) =>
  pda(Buffer.from('tsession'), new BN(id).toArrayLike(Buffer, 'le', 8), trader.toBuffer());
export const topupPda = (id: number, trader: PublicKey, nonce: number) =>
  pda(Buffer.from('topup'), new BN(id).toArrayLike(Buffer, 'le', 8), trader.toBuffer(),
    new BN(nonce).toArrayLike(Buffer, 'le', 8));

// read-only program — tx building + decode only, never signs
const deadWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error('read-only')),
  signAllTransactions: () => Promise.reject(new Error('read-only')),
};
export const program = new Program(
  idl as any,
  new AnchorProvider(connection, deadWallet as any, { commitment: 'confirmed' }),
);

export const decodeLaunch = (d: Buffer) => program.coder.accounts.decode('launch', d);
export const decodeSession = (d: Buffer) => program.coder.accounts.decode('tradeSession', d);
export const decodeTopUp = (d: Buffer) => program.coder.accounts.decode('topUp', d);
export const TOPUP_DISCRIMINATOR = Buffer.from(
  (idl as any).accounts.find((a: any) => a.name === 'TopUp').discriminator as number[],
);
export const TOPUP_SPACE = 66; // 8 disc + 8 launch_id + 32 trader + 8 nonce + 8 amount + 1 applied + 1 bump

export const STATE = ['BONDING', 'FROZEN', 'RECONCILED', 'GRADUATED'] as const;

export interface LaunchView {
  id: number;
  name: string;
  symbol: string;
  state: number;
  dark: boolean;          // delegated = bonding inside the ER
  createdTs: number;
  virtualSol: bigint;
  virtualTok: bigint;
  realSolRaised: number;  // lamports
  tokensSold: number;     // raw units
  sessionsOpened: number;
  mint: string;
}

function toView(id: number, l: any, dark: boolean): LaunchView {
  return {
    id,
    name: l.name as string,
    symbol: l.symbol as string,
    state: l.state as number,
    dark,
    createdTs: (l.createdTs as BN).toNumber(),
    virtualSol: BigInt((l.virtualSol as BN).toString()),
    virtualTok: BigInt((l.virtualTok as BN).toString()),
    realSolRaised: (l.realSolRaised as BN).toNumber(),
    tokensSold: (l.tokensSold as BN).toNumber(),
    sessionsOpened: (l.sessionsOpened as BN).toNumber(),
    mint: (l.mint as PublicKey).toBase58(),
  };
}

// ---- ER discovery (fqdn cache; misses negative-cached briefly so home
// markets don't ping the router every poll tick) -----------------------------
const fqdnCache = new Map<string, { fqdn: string | null; at: number }>();
export async function erEndpointFor(account: PublicKey): Promise<string | null> {
  const key = account.toBase58();
  const hit = fqdnCache.get(key);
  if (hit && (hit.fqdn || Date.now() - hit.at < 15_000)) return hit.fqdn;
  try {
    const r = await fetch(`${ROUTER}/getDelegationStatus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [key] }),
    }).then((x) => x.json());
    const fqdn = r?.result?.fqdn ?? null;
    fqdnCache.set(key, { fqdn, at: Date.now() });
    return fqdn;
  } catch { return null; }
}

const erConns = new Map<string, Connection>();
export function erConnection(fqdn: string): Connection {
  let c = erConns.get(fqdn);
  if (!c) { c = new Connection(fqdn, { commitment: 'confirmed', disableRetryOnRateLimit: true }); erConns.set(fqdn, c); }
  return c;
}

// ---- fetchLaunches: dual sweep + live ER overlay, 2.5s memo ----------------
const LAUNCH_DISC = Buffer.from((idl as any).accounts.find((a: any) => a.name === 'Launch').discriminator);
const launchFilter = [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(LAUNCH_DISC) } }];

let memo: { at: number; data: LaunchView[] } | null = null;
let inflight: Promise<LaunchView[]> | null = null;

export async function fetchLaunches(): Promise<LaunchView[]> {
  if (memo && Date.now() - memo.at < 6000) return memo.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const [home, dark] = await Promise.all([
      connection.getProgramAccounts(PROGRAM_ID, { filters: launchFilter }),
      connection.getProgramAccounts(DLP, { filters: launchFilter }),
    ]);
    const views: LaunchView[] = [];
    for (const { account } of home) {
      const l = decodeLaunch(account.data);
      views.push(toView((l.id as BN).toNumber(), l, false));
    }
    // dark launches: the delegation program hosts EVERY program's delegated
    // accounts, and anchor discriminators hash only the account name — a
    // foreign "Launch" collides. Identity is the PDA, not the discriminator.
    for (const { pubkey, account } of dark) {
      let stale: any, id: number;
      try {
        stale = decodeLaunch(account.data);
        id = (stale.id as BN).toNumber();
      } catch { continue; }
      if (!launchPda(id).equals(pubkey)) continue;
      // L1 data is the stale pre-delegation snapshot — overlay the live ER copy
      let view = toView(id, stale, true);
      const fqdn = await erEndpointFor(pubkey);
      if (fqdn) {
        try {
          const live = await erConnection(fqdn).getAccountInfo(pubkey, 'confirmed');
          if (live) view = toView(id, decodeLaunch(live.data), true);
        } catch { /* keep the stale snapshot — better than a blank row */ }
      }
      views.push(view);
    }
    views.sort((a, b) => b.id - a.id);
    memo = { at: Date.now(), data: views };
    return views;
  })();
  // clear the latch on settle either way — a failed sweep must not wedge the
  // board. The finally-derived promise re-throws the rejection, so absorb it:
  // callers handle the ORIGINAL promise; the derived one is bookkeeping only.
  const p = inflight;
  p.finally(() => { if (inflight === p) inflight = null; }).catch(() => { /* observed via p */ });
  return p;
}

// ---- curve math, mirrored from curve.rs (BigInt, trader-adverse +1) --------
export function buyQuote(vs: bigint, vt: bigint, solIn: bigint): bigint {
  if (solIn === 0n) return 0n;
  const k = vs * vt;
  const nvt = k / (vs + solIn) + 1n;
  return nvt >= vt ? 0n : vt - nvt;
}
export function sellQuote(vs: bigint, vt: bigint, tokIn: bigint): bigint {
  if (tokIn === 0n) return 0n;
  const k = vs * vt;
  const nvs = k / (vt + tokIn) + 1n;
  return nvs >= vs ? 0n : vs - nvs;
}

// spot price in lamports per raw unit → market cap over total supply, in SOL
export function marketCapSol(l: LaunchView): number {
  return Number(l.virtualSol) * TOKEN_TOTAL_SUPPLY / Number(l.virtualTok) / LAMPORTS;
}

// ---- display helpers -------------------------------------------------------
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;

export const fmtSol = (lamports: number, dp = 3) => (lamports / LAMPORTS).toFixed(dp);
export const fmtTok = (raw: number | bigint) =>
  (Number(raw) / 10 ** TOKEN_DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 0 });
export function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

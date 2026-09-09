'use client';

/* The chain rail, client-side and read-frugal (stakehouse rules): walk
 * launch PDAs from platform.seq — never getProgramAccounts. GPA on the
 * delegation program is a 429 on any shared RPC (it hosts every program's
 * delegated accounts), and a failed sweep used to leave the board on
 * "loading" forever. A launch lives in one of two places — home under the
 * program, or DARK under the delegation program while it bonds inside the
 * ER. The L1 copy of a dark launch is a stale pre-delegation snapshot, so
 * live curve numbers come from the ER node the router points at. */

import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  CLUSTER, CONFIG, DLP, ENV_LAUNCH_FEE_LAMPORTS, ENV_LAUNCH_TAX_BPS, GATE, LAMPORTS,
  PLATFORM, PROGRAM_ID, PUBLIC_RPC_URL, RPC_URL, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY,
  connection, erConnection, erEndpointFor, idl, launchPda, mintPda,
  publicConnection,
} from './core';

/* Constants, PDAs, curve math and the connection factories live in
 * ./core so server code (the receipt route) can use them without
 * crossing this file's client boundary. Re-exported here unchanged. */
export {
  CLUSTER, RPC_URL, PUBLIC_RPC_URL, ROUTER, PROGRAM_ID, DLP, MAGIC_PROGRAM, MAGIC_CONTEXT, TOKEN_PROGRAM,
  LAMPORTS, GRADUATION_LAMPORTS, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, MIN_DEPOSIT,
  VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT, CURVE_TOKEN_ALLOC, maxCurveBuy, connection,
  publicConnection, PLATFORM, CONFIG, GATE, ENV_LAUNCH_FEE_LAMPORTS, ENV_LAUNCH_TAX_BPS, launchPda,
  mintPda, sessionPda, topupPda, poolRecordPda, pumpPda, buyQuote, sellQuote, erEndpointFor,
  erConnection,
} from './core';

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

export async function fetchFees(): Promise<{ launchFeeLamports: number; launchTaxBps: number }> {
  try {
    const c = await (program.account as any).platformConfig.fetch(CONFIG);
    return {
      launchFeeLamports: Number((c.launchFeeLamports as BN).toString()),
      launchTaxBps: Number(c.launchTaxBps),
    };
  } catch {
    return { launchFeeLamports: ENV_LAUNCH_FEE_LAMPORTS, launchTaxBps: ENV_LAUNCH_TAX_BPS };
  }
}

/** Canonical market URL is the mint CA. Numeric /launch/7 still resolves
 *  so old links redirect once the page has the mint. */
export const launchHref = (mint: string) => `/launch/${mint}`;

export async function launchIdFromPath(param: string): Promise<number | null> {
  if (/^\d+$/.test(param)) {
    const id = Number(param);
    return Number.isInteger(id) ? id : null;
  }
  let mint: PublicKey;
  try { mint = new PublicKey(param); } catch { return null; }
  try {
    const platform = await (program.account as any).platform.fetch(PLATFORM);
    const seq = (platform.launchSeq as BN).toNumber();
    for (let i = 0; i < seq; i++) {
      if (mintPda(i).equals(mint)) return i;
    }
  } catch { /* platform unread — treat as missing */ }
  return null;
}

export const decodeGate = (d: Buffer) => program.coder.accounts.decode('gate', d);

/** The armed entry co-signer, or null while entry is permissionless.
 *  Cached a minute — arming the gate is an admin act, not a per-click one. */
let gateCache: { key: PublicKey | null; at: number } | null = null;
export async function fetchGateKey(): Promise<PublicKey | null> {
  if (gateCache && Date.now() - gateCache.at < 60_000) return gateCache.key;
  let key: PublicKey | null = null;
  try {
    const acc = await connection.getAccountInfo(GATE);
    if (acc && acc.data.length > 8) {
      const g = decodeGate(acc.data);
      if (!(g.key as PublicKey).equals(PublicKey.default)) key = g.key;
    }
  } catch { /* RPC hiccup — treat as unknown, retry next call */
    return gateCache?.key ?? null;
  }
  gateCache = { key, at: Date.now() };
  return key;
}

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
  creator: string;
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
    creator: (l.creator as PublicKey).toBase58(),
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

// ---- fetchLaunches: platform.seq walk + live ER overlay, 6s memo ----------

let memo: { at: number; data: LaunchView[] } | null = null;
let inflight: Promise<LaunchView[]> | null = null;

async function sweepLaunches(conn: Connection): Promise<LaunchView[]> {
  const plat = await conn.getAccountInfo(PLATFORM);
  if (!plat) return [];
  const seq = (program.coder.accounts.decode('platform', plat.data).launchSeq as BN).toNumber();
  if (seq <= 0) return [];
  const keys = Array.from({ length: seq }, (_, i) => launchPda(i));
  const accs: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>> = [];
  for (let i = 0; i < keys.length; i += 100) {
    accs.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)));
  }
  const overlays = accs.map(async (account, i) => {
    if (!account) return null;
    const dark = account.owner.equals(DLP);
    if (!dark && !account.owner.equals(PROGRAM_ID)) return null;
    let stale: ReturnType<typeof decodeLaunch>;
    try { stale = decodeLaunch(account.data); } catch { return null; }
    const id = (stale.id as BN).toNumber();
    const pubkey = keys[i];
    if (!launchPda(id).equals(pubkey)) return null;
    let view = toView(id, stale, dark);
    if (!dark) return view;
    const fqdn = await erEndpointFor(pubkey);
    if (fqdn) {
      try {
        const live = await erConnection(fqdn).getAccountInfo(pubkey, 'confirmed');
        if (live) view = toView(id, decodeLaunch(live.data), true);
      } catch { /* keep the stale snapshot — better than a blank row */ }
    }
    return view;
  });
  const views: LaunchView[] = [];
  for (const v of await Promise.all(overlays)) if (v) views.push(v);
  views.sort((a, b) => b.id - a.id);
  return views;
}

export async function fetchLaunches(): Promise<LaunchView[]> {
  if (memo && Date.now() - memo.at < 6000) return memo.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return await sweepLaunches(connection);
    } catch {
      if (RPC_URL === PUBLIC_RPC_URL) throw new Error('rpc');
      return await sweepLaunches(publicConnection);
    }
  })().then((views) => {
    memo = { at: Date.now(), data: views };
    return views;
  });
  // clear the latch on settle either way — a failed sweep must not wedge the
  // board. The finally-derived promise re-throws the rejection, so absorb it:
  // callers handle the ORIGINAL promise; the derived one is bookkeeping only.
  const p = inflight;
  p.finally(() => { if (inflight === p) inflight = null; }).catch(() => { /* observed via p */ });
  return p;
}

// ---- curve math, mirrored from curve.rs (BigInt, trader-adverse +1) --------
// spot price in lamports per raw unit → market cap over total supply, in SOL
export function marketCapSol(l: LaunchView): number {
  return Number(l.virtualSol) * TOKEN_TOTAL_SUPPLY / Number(l.virtualTok) / LAMPORTS;
}

// ---- display helpers -------------------------------------------------------
const clusterSuffix = CLUSTER === 'mainnet' ? '' : `?cluster=${CLUSTER}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}${clusterSuffix}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}${clusterSuffix}`;

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

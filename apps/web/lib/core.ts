/* The parts of the rail that do not care where they run. Constants, PDA
 * derivations, the curve math and the two connection factories are pure
 * and universal, so they live here rather than behind the 'use client'
 * boundary in magicpad.ts — the receipt route rebuilds a whole market
 * server-side from exactly these. magicpad.ts re-exports all of it, so
 * client code keeps importing from where it always did. */

import { BN, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import idlDevnet from './idl.json';
import idlMainnet from './idl-v3.json';

/* One codebase, two deployments. The devnet demo program still speaks the
 * old 2-arg create_launch, mainnet runs v3 (3-arg, fairest mode) — same
 * program id on both nets, so the IDL is the only per-cluster choice. */
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER || 'mainnet';
export const idl: any = CLUSTER === 'mainnet' ? idlMainnet : idlDevnet;

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL
  || 'https://mainnet.helius-rpc.com/?api-key=3e7ced32-76bb-4def-926a-05f0ed38e528';
export const PUBLIC_RPC_URL =
  CLUSTER === 'mainnet' ? clusterApiUrl('mainnet-beta') : clusterApiUrl('devnet');
export const ROUTER = process.env.NEXT_PUBLIC_ROUTER_URL
  || (CLUSTER === 'mainnet' ? 'https://router.magicblock.app' : 'https://devnet-router.magicblock.app');
export const PROGRAM_ID = new PublicKey((idl as any).address);
export const DLP = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
export const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export const LAMPORTS = 1_000_000_000;
export const GRADUATION_LAMPORTS =
  Number(process.env.NEXT_PUBLIC_GRADUATION_LAMPORTS || 5 * LAMPORTS);
// pump.fun launches freeze at 0.2 SOL — fixed in the program (PUMP_GRADUATION_LAMPORTS)
export const PUMP_GRADUATION_LAMPORTS = 200_000_000;
export const TOKEN_DECIMALS = 6;
export const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000; // raw units
export const MIN_DEPOSIT = 0.01 * LAMPORTS;
// launch-time virtual reserves, from programs/magicpad/src/constants.rs —
// a launch-tx dev buy quotes against EXACTLY these, so its fill is exact
export const VIRTUAL_SOL_INIT = 30_000_000_000n;
export const VIRTUAL_TOK_INIT = 1_073_000_000_000_000n;
export const CURVE_TOKEN_ALLOC = 793_100_000_000_000n; // 79.31% sellable on curve

/** Lamports the curve can still absorb before the token alloc is spent —
 *  the program hard-rejects (BadQuote) a buy past it, so the UI clamps
 *  instead of letting the tx revert. Mirrors trade.rs:58. */
export function maxCurveBuy(vs: bigint, vt: bigint): number {
  const cap = (vs * vt) / (VIRTUAL_TOK_INIT - CURVE_TOKEN_ALLOC) - vs - 1n;
  return cap < 0n ? 0 : Number(cap);
}

export const connection = new Connection(RPC_URL, {
  commitment: 'confirmed', disableRetryOnRateLimit: true,
});
export const publicConnection = new Connection(PUBLIC_RPC_URL, {
  commitment: 'confirmed', disableRetryOnRateLimit: true,
});

const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const PLATFORM = pda(Buffer.from('platform'));
export const CONFIG = pda(Buffer.from('config'));
export const GATE = pda(Buffer.from('gate'));
export const ENV_LAUNCH_FEE_LAMPORTS = Number(process.env.NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS || '0');
export const ENV_LAUNCH_TAX_BPS = Number(process.env.NEXT_PUBLIC_LAUNCH_TAX_BPS || '0');
export const launchPda = (id: number) =>
  pda(Buffer.from('launch'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const mintPda = (id: number) =>
  pda(Buffer.from('mint'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const sessionPda = (id: number, trader: PublicKey) =>
  pda(Buffer.from('tsession'), new BN(id).toArrayLike(Buffer, 'le', 8), trader.toBuffer());
export const topupPda = (id: number, trader: PublicKey, nonce: number) =>
  pda(Buffer.from('topup'), new BN(id).toArrayLike(Buffer, 'le', 8), trader.toBuffer(),
    new BN(nonce).toArrayLike(Buffer, 'le', 8));
export const poolRecordPda = (mint: PublicKey) =>
  pda(Buffer.from('pool'), mint.toBuffer());
// the pump.fun marker: exists ⇔ the launch graduates on pump.fun at 0.2 SOL
export const pumpPda = (id: number) =>
  pda(Buffer.from('pump'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const pumpUrl = (mint: string) => `https://pump.fun/coin/${mint}`;

export const LAUNCH_DISC = Buffer.from(
  (idl as any).accounts.find((a: any) => a.name === 'Launch').discriminator,
);
export const launchFilter = [
  { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(LAUNCH_DISC) } },
];

// ---- curve math, mirroring programs/magicpad/src/instructions/trade.rs -----
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

/* ---- fairest mode, mirroring programs/magicpad/src/fair.rs ----------------
 * Pure integer math so a receipt can replay taxed sells to the lamport:
 * the tax depends only on (sol_out, weighted entry ts, clock), all of
 * which the published trade log carries. */
export const FLIP_TAX_START_BPS = 2_500n; // constants.rs: 25% on an instant flip
export const FLIP_DECAY_SECS = 1_800n;    // constants.rs: fades to zero over 30 min
export const BPS_DENOM = 10_000n;

/** Tokens-weighted average entry timestamp after a buy (fair.rs semantics:
 *  stamped BEFORE tokens_held moves, so `held` is the pre-buy balance). */
export function weightedEntryTs(entry: bigint, held: bigint, now: bigint, bought: bigint): bigint {
  const total = held + bought;
  if (total === 0n) return entry;
  return (entry * held + now * bought) / total;
}

/** Lamports of flip tax on `solOut` sold at `now` for a position whose
 *  weighted entry is `entry`. Linear decay, rounds down, skew-safe. */
export function flipTaxAt(solOut: bigint, entry: bigint, now: bigint): bigint {
  const age = now > entry ? now - entry : 0n;
  if (age >= FLIP_DECAY_SECS) return 0n;
  const bps = FLIP_TAX_START_BPS * (FLIP_DECAY_SECS - age) / FLIP_DECAY_SECS;
  return solOut * bps / BPS_DENOM;
}

// ---- the rollup: ask the router where a delegated account lives -----------
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

/* Known rollup nodes. The router only answers for LIVE delegations, but a
 * node keeps a settled market's ledger long after it routes home — so a
 * receipt for a finished launch still has somewhere to read its trades. */
export const ER_NODES = (process.env.NEXT_PUBLIC_ER_NODES
  || (CLUSTER === 'mainnet'
    ? 'https://eu.magicblock.app'
    : 'https://devnet-as.magicblock.app,https://devnet.magicblock.app'))
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Every endpoint worth asking for an account's rollup history: whoever the
 *  router names first, then the known nodes. Deduped, trailing slash-safe. */
export async function erLedgerEndpoints(account: PublicKey): Promise<string[]> {
  const live = await erEndpointFor(account);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [live, ...ER_NODES]) {
    if (!e) continue;
    const norm = e.replace(/\/+$/, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

const erConns = new Map<string, Connection>();
export function erConnection(fqdn: string): Connection {
  let c = erConns.get(fqdn);
  if (!c) {
    c = new Connection(fqdn, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    erConns.set(fqdn, c);
  }
  return c;
}

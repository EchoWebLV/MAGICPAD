'use client';

/* Token faces without a database. The metadata JSON lives on IPFS; its CID
 * rides the chain as an SPL memo on a transaction that touches the launch
 * PDA — the creation tx for new launches, a later transfer-0-lamport tx for
 * retrofits. getSignaturesForAddress returns memo strings in the listing,
 * so resolving a launch's art is ONE cheap RPC call plus one gateway fetch,
 * then cached in localStorage forever (the winning memo is immutable-ish:
 * newest creator-signed memo wins, so creators can re-skin, nobody else
 * can — the fee payer of the memo tx must be the launch creator). */

import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { connection, launchPda } from './magicpad';

// devnet-live verified: executable, and sig listings carry its memo text
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PREFIX = 'magicpad:meta:v1:';
// the account's dedicated Pinata gateway — serves our pins instantly where
// public gateways lag fresh CIDs by minutes
export const GATEWAY = 'https://tomato-fancy-finch-338.mypinata.cloud/ipfs/';

export interface LaunchMeta {
  cid: string;
  image?: string;       // resolved to an https gateway url
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export const ipfsUrl = (uri: string | undefined): string | undefined =>
  uri?.startsWith('ipfs://') ? GATEWAY + uri.slice(7) : uri;

// ---- pinning (the JWT never leaves the server — /api/pin holds it) ---------

export interface PinFields {
  image: File;
  name: string;
  symbol: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
}

/** Pin image + metadata JSON to IPFS through our API route. Returns the
 *  metadata CID, verified to resolve over HTTP before we trust it. */
export async function pinAssets(f: PinFields): Promise<string> {
  const form = new FormData();
  form.append('image', f.image);
  form.append('name', f.name);
  form.append('symbol', f.symbol);
  form.append('description', f.description);
  form.append('twitter', f.twitter);
  form.append('telegram', f.telegram);
  form.append('website', f.website);
  const r = await fetch('/api/pin', { method: 'POST', body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `pinning failed (${r.status})`);
  return body.cid as string;
}

/** Downscale to a 512px cover-cropped square webp so uploads stay light.
 *  Small gifs pass through untouched — canvas would kill the animation. */
export async function squashImage(file: File): Promise<File> {
  if (file.type === 'image/gif' && file.size <= 1_000_000) return file;
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 512, 512);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.85));
  if (!blob) throw new Error('could not process that image — try a png or jpg');
  return new File([blob], 'token.webp', { type: 'image/webp' });
}

// ---- the memo rail ---------------------------------------------------------

export const metaMemoIx = (cid: string): TransactionInstruction =>
  new TransactionInstruction({
    programId: MEMO_PROGRAM, keys: [], data: Buffer.from(PREFIX + cid, 'utf8'),
  });

/** Retrofit metadata onto an existing launch. The 0-lamport transfer exists
 *  only to put the launch PDA in the tx's account list so the memo shows up
 *  in the PDA's signature history; it credits nothing (reconcile-safe,
 *  devnet-verified against a live delegated launch). */
export function attachMetaTx(launchId: number, creator: PublicKey, cid: string): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: creator, toPubkey: launchPda(launchId), lamports: 0 }),
    metaMemoIx(cid),
  );
}

// ---- resolving -------------------------------------------------------------

const CKEY = (id: number) => `magicpad_meta_${id}`;
const mem = new Map<number, LaunchMeta | null>();
const missAt = new Map<number, number>();      // negative cache — 60s
const inflight = new Map<number, Promise<LaunchMeta | null>>();

// two lookups at a time keeps a full board from stampeding the RPC
let slots = 2;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (slots === 0) await new Promise<void>((res) => waiters.push(res));
  else slots--;
  try { return await fn(); } finally { const w = waiters.shift(); if (w) w(); else slots++; }
}

const MEMO_RE = /^(?:\[\d+\] )?magicpad:meta:v1:([A-Za-z0-9]+)$/;

async function lookup(id: number, creator: string): Promise<LaunchMeta | null> {
  const sigs = await connection.getSignaturesForAddress(launchPda(id), { limit: 100 }, 'confirmed');
  const candidates = sigs.filter((s) => !s.err && s.memo && MEMO_RE.test(s.memo));
  for (const s of candidates.slice(0, 3)) {  // newest first; strangers' memos get skipped
    const cid = MEMO_RE.exec(s.memo!)![1];
    const tx: any = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys: PublicKey[] = msg.staticAccountKeys ?? msg.accountKeys;
    if (keys[0].toBase58() !== creator) continue;  // only the creator names a market
    const json = await fetch(GATEWAY + cid, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!json || typeof json !== 'object') continue;
    return {
      cid,
      image: ipfsUrl(json.image),
      description: typeof json.description === 'string' ? json.description : undefined,
      twitter: json.extensions?.twitter, telegram: json.extensions?.telegram,
      website: json.extensions?.website,
    };
  }
  return null;
}

/** The launch's face, or null when it never got one. Cached forever once
 *  found; misses retry after a minute (a fresh launch's tx may not be
 *  indexed yet). Throws never — a broken RPC just means no art this tick. */
export function resolveMeta(id: number, creator: string): Promise<LaunchMeta | null> {
  if (mem.has(id)) return Promise.resolve(mem.get(id)!);
  try {
    const hit = JSON.parse(localStorage.getItem(CKEY(id)) ?? 'null');
    if (hit?.cid) { mem.set(id, hit); return Promise.resolve(hit as LaunchMeta); }
  } catch { /* fall through to chain */ }
  const miss = missAt.get(id);
  if (miss && Date.now() - miss < 60_000) return Promise.resolve(null);
  const running = inflight.get(id);
  if (running) return running;
  const p = withSlot(() => lookup(id, creator)).then((meta) => {
    if (meta) {
      mem.set(id, meta);
      try { localStorage.setItem(CKEY(id), JSON.stringify(meta)); } catch { /* quota */ }
    } else missAt.set(id, Date.now());
    return meta;
  }).catch(() => { missAt.set(id, Date.now()); return null; });
  inflight.set(id, p);
  p.finally(() => { if (inflight.get(id) === p) inflight.delete(id); }).catch(() => {});
  return p;
}

/** Forget one launch's cached face — call after a retrofit lands. */
export function clearMeta(id: number): void {
  mem.delete(id); missAt.delete(id);
  try { localStorage.removeItem(CKEY(id)); } catch { /* fine */ }
}

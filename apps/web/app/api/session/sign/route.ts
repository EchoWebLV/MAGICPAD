import { NextResponse } from 'next/server';
import { Keypair, Message, PublicKey, Transaction } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import fs from 'node:fs';
import idl from '../../../../lib/idl.json';

export const runtime = 'nodejs';

/* The other half of the entry gate. The on-chain half (set_gate) makes
 * open_trade_session / top_up_session demand the gate key's signature;
 * THIS route is the only place that signature exists. It co-signs exactly
 * one shape of transaction — session entry into our own program — and only
 * for callers this policy admits. Everything else about the rail stays
 * trustless: we decide who walks in, we can never touch what walks out. */

const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

// the ONLY instructions worth a gate signature: entry + its bundled delegate
const ALLOWED = new Set(
  (idl as { instructions: { name: string; discriminator: number[] }[] }).instructions
    .filter((i) => ['open_trade_session', 'delegate_trade_session', 'top_up_session', 'delegate_top_up'].includes(i.name))
    .map((i) => Buffer.from(i.discriminator).toString('hex')),
);

function loadGate(): Keypair | null {
  const env = process.env.GATE_KEYPAIR;
  if (!env) return null;
  const raw = env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/* WHO gets a signature — the policy seam. With Privy server creds set the
 * caller must present a valid Privy access token (a real account in our
 * app). Without them (bare devnet) entry is origin-checked only — set
 * PRIVY_APP_SECRET before pointing real money at this. Per-user session
 * caps, captcha, wallet heuristics: they all belong in here. */
async function authorize(req: Request): Promise<string | null> {
  const appId = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) return null; // dev mode — no identity to verify
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('sign in to open a session');
  const { PrivyClient } = await import('@privy-io/server-auth');
  const claims = await new PrivyClient(appId, secret).verifyAuthToken(token)
    .catch(() => { throw new Error('session sign-in expired — log in again'); });
  return claims.userId;
}

// naive per-IP throttle — enough for devnet; production wants real infra
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const w = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  w.push(now);
  hits.set(ip, w);
  return w.length > 20;
}

export async function POST(req: Request) {
  const gate = loadGate();
  if (!gate) return NextResponse.json({ error: 'gate signing not configured' }, { status: 501 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (throttled(ip)) return NextResponse.json({ error: 'slow down' }, { status: 429 });

  try { await authorize(req); }
  catch (e) { return NextResponse.json({ error: String((e as Error).message) }, { status: 401 }); }

  let body: { message?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!body.message) return NextResponse.json({ error: 'message required' }, { status: 400 });
  const raw = Buffer.from(body.message, 'base64');
  if (raw.length === 0 || raw.length > 1600) {
    return NextResponse.json({ error: 'not a transaction message' }, { status: 400 });
  }

  // inspect before signing: this key co-signs session entry, nothing else
  let msg: Message;
  try { msg = Message.from(raw); } catch { return NextResponse.json({ error: 'unparseable message' }, { status: 400 }); }
  for (const ix of msg.instructions) {
    const prog = msg.accountKeys[ix.programIdIndex];
    if (prog.toBase58() === COMPUTE_BUDGET) continue;
    if (!prog.equals(PROGRAM_ID)) {
      return NextResponse.json({ error: 'foreign program in transaction' }, { status: 400 });
    }
    const disc = Buffer.from(utils.bytes.bs58.decode(ix.data)).subarray(0, 8).toString('hex');
    if (!ALLOWED.has(disc)) {
      return NextResponse.json({ error: 'not a session-entry transaction' }, { status: 400 });
    }
  }
  const gateIdx = msg.accountKeys.findIndex((k) => k.equals(gate.publicKey));
  if (gateIdx <= 0 || msg.isAccountWritable(gateIdx)) {
    // index 0 is the fee payer — the gate never pays, never moves
    return NextResponse.json({ error: 'gate account misused' }, { status: 400 });
  }

  const tx = Transaction.populate(msg, []);
  tx.partialSign(gate);
  const sig = tx.signatures.find((s) => s.publicKey.equals(gate.publicKey))?.signature;
  if (!sig) return NextResponse.json({ error: 'signing failed' }, { status: 500 });
  return NextResponse.json({
    signature: Buffer.from(sig).toString('base64'),
    signer: gate.publicKey.toBase58(),
  });
}

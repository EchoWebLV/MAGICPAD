import { NextResponse } from 'next/server';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { buildMeteoraSwap, type SwapSide } from '../../../lib/meteora';

export const runtime = 'nodejs';

const rpc = new Connection(
  process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || clusterApiUrl('devnet'),
  'confirmed',
);

export async function POST(req: Request) {
  let body: { mint?: string; side?: string; amount?: string; user?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const { mint, amount, user } = body;
  const side = body.side as SwapSide;
  if (!mint || !user || (side !== 'buy' && side !== 'sell') || !amount || !/^\d+$/.test(amount)) {
    return NextResponse.json({ error: 'mint, side, amount, user required' }, { status: 400 });
  }
  try {
    const tx = await buildMeteoraSwap(mint, side, amount, user);
    const bh = await rpc.getLatestBlockhash('confirmed');
    tx.feePayer = new PublicKey(user);
    tx.recentBlockhash = bh.blockhash;
    return NextResponse.json({
      tx: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = /no Meteora pool/i.test(msg) ? 404 : 400;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status });
  }
}

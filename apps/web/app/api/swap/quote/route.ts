import { NextResponse } from 'next/server';
import { quoteMeteora, type SwapSide } from '../../../../lib/meteora';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get('mint') ?? '';
  const side = (url.searchParams.get('side') ?? '') as SwapSide;
  const amount = url.searchParams.get('amount') ?? '';
  if (!mint || (side !== 'buy' && side !== 'sell') || !/^\d+$/.test(amount)) {
    return NextResponse.json({ error: 'mint, side, amount required' }, { status: 400 });
  }
  try {
    const q = await quoteMeteora(mint, side, amount);
    return NextResponse.json(q);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = /no Meteora pool/i.test(msg) ? 404 : 400;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status });
  }
}

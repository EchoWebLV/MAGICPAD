import { NextResponse } from 'next/server';
import { spotMeteora } from '../../../../lib/meteora';
import { spotRaydium } from '../../../../lib/raydium';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get('mint') ?? '';
  if (!mint) return NextResponse.json({ error: 'mint required' }, { status: 400 });
  try {
    return NextResponse.json(await spotMeteora(mint));
  } catch (meteoraErr: any) {
    try {
      return NextResponse.json(await spotRaydium(mint));
    } catch (e: any) {
      const msg = String(e?.message ?? meteoraErr?.message ?? e);
      const status = /no (Meteora|Raydium) pool/i.test(msg) ? 404 : 400;
      return NextResponse.json({ error: msg.slice(0, 200) }, { status });
    }
  }
}

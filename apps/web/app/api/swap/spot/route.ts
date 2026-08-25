import { NextResponse } from 'next/server';
import { spotMeteora } from '../../../../lib/meteora';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get('mint') ?? '';
  if (!mint) return NextResponse.json({ error: 'mint required' }, { status: 400 });
  try {
    return NextResponse.json(await spotMeteora(mint));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = /no Meteora pool/i.test(msg) ? 404 : 400;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status });
  }
}

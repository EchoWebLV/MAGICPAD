/* GET /api/receipt/<launch id | mint>
 *
 * The whole market, rebuilt server-side from chain data and returned as
 * plain JSON: every trade with its signature, every session with the
 * numbers settlement ran on, and the two reconciliations. Nothing here is
 * privileged — scripts/verify-receipt.mjs reproduces the same object from
 * a raw RPC, so this endpoint is a convenience, never the authority. */

import { NextRequest, NextResponse } from 'next/server';
import { buildReceipt } from '../../../../lib/receipt';
import { resolveLaunchId } from '../../../../lib/ledger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: param } = await ctx.params;
  let id = Number(param);
  if (!Number.isInteger(id) || id < 0) {
    const resolved = await resolveLaunchId(param);
    if (resolved === null) {
      return NextResponse.json({ error: 'no such launch' }, { status: 404 });
    }
    id = resolved;
  }
  try {
    const receipt = await buildReceipt(id);
    if (!receipt) return NextResponse.json({ error: 'no such launch' }, { status: 404 });
    return NextResponse.json(receipt, {
      headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'sweep failed' }, { status: 502 });
  }
}

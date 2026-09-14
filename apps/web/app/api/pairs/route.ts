import { NextResponse } from 'next/server';
import { pairsFor, type Venue } from '../../../lib/pairings';

export const runtime = 'nodejs';

const VENUES: Venue[] = ['pump', 'meteora', 'raydium'];

export async function GET(req: Request) {
  const venue = (new URL(req.url).searchParams.get('venue') ?? 'meteora') as Venue;
  if (!VENUES.includes(venue)) {
    return NextResponse.json({ error: 'venue must be pump, meteora, or raydium' }, { status: 400 });
  }
  const pairs = await pairsFor(venue);
  return NextResponse.json({ venue, pairs });
}

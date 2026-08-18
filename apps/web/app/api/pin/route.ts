/* Server-side IPFS pinning. The Pinata JWT lives in apps/web/.env.local and
 * never reaches the browser — the create form POSTs its image + fields here,
 * we pin the image, build the metadata JSON, pin that, and only answer once
 * the metadata actually resolves over a public gateway. The returned CID is
 * what rides the launch tx as a memo. Uses Pinata's v3 uploads API with
 * network=public — same rail the bundler proved out. */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// the account's dedicated gateway serves its own pins the moment they land —
// public gateways can lag fresh CIDs by minutes
const GATEWAY = 'https://tomato-fancy-finch-338.mypinata.cloud/ipfs/';
const UPLOADS = 'https://uploads.pinata.cloud/v3/files';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE = 2_000_000; // client squashes to ≤512px webp; this is the backstop

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

const str = (form: FormData, key: string, max: number): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
};

async function pin(jwt: string, blob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', blob, filename);
  const r = await fetch(UPLOADS, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form,
  });
  if (!r.ok) throw new Error(`Pinata upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const cid = j.data?.cid ?? j.cid;
  if (!cid) throw new Error(`Pinata response missing cid: ${JSON.stringify(j).slice(0, 200)}`);
  return cid;
}

export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return bad('PINATA_JWT missing in apps/web/.env.local', 500);

  const form = await req.formData().catch(() => null);
  if (!form) return bad('send multipart form data');
  const image = form.get('image');
  if (!(image instanceof File)) return bad('an image is required');
  if (!IMAGE_TYPES.includes(image.type)) return bad('image must be png, jpg, webp, or gif');
  if (image.size > MAX_IMAGE) return bad('image too large — keep it under 2MB');
  const name = str(form, 'name', 32);
  const symbol = str(form, 'symbol', 10).toUpperCase();
  if (!name || !symbol) return bad('name and symbol are required');
  const description = str(form, 'description', 600);
  const links = {
    twitter: str(form, 'twitter', 120),
    telegram: str(form, 'telegram', 120),
    website: str(form, 'website', 120),
  };

  try {
    const imageCid = await pin(
      jwt, image, `${symbol.toLowerCase()}.${image.type.split('/')[1]}`,
    );
    const extensions = Object.fromEntries(Object.entries(links).filter(([, v]) => v));
    // canonical ipfs:// in the pinned JSON keeps it portable; the web
    // client rewrites to the fast gateway at render time
    const metadata = {
      name, symbol,
      ...(description ? { description } : {}),
      image: `ipfs://${imageCid}`,
      ...(Object.keys(extensions).length ? { extensions } : {}),
    };
    const cid = await pin(
      jwt, new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json',
    );

    // pinned is not the same as reachable — prove the metadata resolves
    // before we let a launch carry this CID forever
    for (let i = 0; i < 6; i++) {
      const live = await fetch(GATEWAY + cid, { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (live?.name === name) return NextResponse.json({ cid, imageCid });
      await new Promise((r) => setTimeout(r, 4000));
    }
    return bad('metadata pinned but no gateway serves it yet — try again in a minute', 502);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 502);
  }
}

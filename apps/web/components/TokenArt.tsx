'use client';

/* A market's face, anywhere it's listed. Resolves the launch's IPFS
 * metadata (cached forever after the first hit) and falls back to a
 * deterministic gradient tile — every market has a face even before its
 * creator gives it one, and the board never layout-shifts. */

import { useEffect, useState } from 'react';
import { LaunchMeta, resolveMeta } from '../lib/metadata';

/** One launch's face and links. resolveMeta memoises per id, so every
 *  caller on a row shares a single lookup. */
export function useLaunchMeta(id: number, creator: string): LaunchMeta | null {
  const [meta, setMeta] = useState<LaunchMeta | null>(null);
  useEffect(() => {
    let live = true;
    resolveMeta(id, creator).then((m) => { if (live) setMeta(m); });
    return () => { live = false; };
  }, [id, creator]);
  return meta;
}

export default function TokenArt({ id, creator, symbol, size }: {
  id: number; creator: string; symbol: string; size: number;
}) {
  const meta = useLaunchMeta(id, creator);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [meta?.image]);

  const px = { width: size, height: size };
  if (meta?.image && !broken) {
    return (
      <img
        className="tokenart" style={px} src={meta.image} alt={symbol}
        loading="lazy" onError={() => setBroken(true)}
      />
    );
  }
  // no face yet: stay on palette and let the light angle carry the identity
  const angle = (id * 137.5) % 360;
  return (
    <div
      className="tokenart blank"
      style={{
        ...px, fontSize: size * 0.42,
        background: `linear-gradient(${angle}deg, rgba(255,199,0,0.18), rgba(255,199,0,0.02) 64%), #0d0d0c`,
        color: 'rgba(255,199,0,0.8)',
      }}
    >
      {symbol.slice(0, 1)}
    </div>
  );
}

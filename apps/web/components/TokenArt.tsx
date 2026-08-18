'use client';

/* A market's face, anywhere it's listed. Resolves the launch's IPFS
 * metadata (cached forever after the first hit) and falls back to a
 * deterministic gradient tile — every market has a face even before its
 * creator gives it one, and the board never layout-shifts. */

import { useEffect, useState } from 'react';
import { LaunchMeta, resolveMeta } from '../lib/metadata';

export default function TokenArt({ id, creator, symbol, size }: {
  id: number; creator: string; symbol: string; size: number;
}) {
  const [meta, setMeta] = useState<LaunchMeta | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let live = true;
    setBroken(false);
    resolveMeta(id, creator).then((m) => { if (live) setMeta(m); });
    return () => { live = false; };
  }, [id, creator]);

  const px = { width: size, height: size };
  if (meta?.image && !broken) {
    return (
      <img
        className="tokenart" style={px} src={meta.image} alt={symbol}
        loading="lazy" onError={() => setBroken(true)}
      />
    );
  }
  const hue = (id * 137.5) % 360;
  return (
    <div
      className="tokenart blank"
      style={{
        ...px, fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 40) % 360} 55% 12%))`,
        color: `hsl(${hue} 70% 72%)`,
      }}
    >
      {symbol.slice(0, 1)}
    </div>
  );
}

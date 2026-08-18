'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { connection, fmtSol } from '../lib/magicpad';

export default function Nav() {
  const { publicKey } = useWallet();
  const [bal, setBal] = useState<number | null>(null);
  // the multi-button renders wallet state that only exists client-side —
  // mount-gate it or hydration screams
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    setBal(null);
    if (!publicKey) return;
    let live = true;
    const tick = async () => {
      try { const b = await connection.getBalance(publicKey); if (live) setBal(b); } catch { /* next tick */ }
    };
    tick();
    const t = setInterval(tick, 12000);
    return () => { live = false; clearInterval(t); };
  }, [publicKey]);

  return (
    <nav className="nav">
      <Link href="/" className="brand">MAGIC<span>PAD</span></Link>
      <span className="tag">the launchpad that pays you to trade</span>
      <div className="grow" />
      {publicKey && bal !== null && (
        <span className="pill mono"><span className="magic">◈</span> {fmtSol(bal, 3)}◎</span>
      )}
      {mounted && <WalletMultiButton />}
      <Link href="/create" className="btn">+ Launch</Link>
    </nav>
  );
}

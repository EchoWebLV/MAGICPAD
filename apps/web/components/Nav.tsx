'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtSol, short } from '../lib/magicpad';
import { burnerBalance, getBurner } from '../lib/burner';

export default function Nav() {
  const [addr, setAddr] = useState('');
  const [bal, setBal] = useState<number | null>(null);

  useEffect(() => {
    setAddr(getBurner().publicKey.toBase58());
    let live = true;
    const tick = async () => { try { const b = await burnerBalance(); if (live) setBal(b); } catch { /* next tick */ } };
    tick();
    const t = setInterval(tick, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);

  return (
    <nav className="nav">
      <Link href="/" className="brand">MAGIC<span>PAD</span></Link>
      <span className="tag">the launchpad that pays you to trade</span>
      <div className="grow" />
      {addr && (
        <span className="pill mono" title={addr}>
          <span className="magic">◈</span> {short(addr)}
          <span className="dim">{bal === null ? '…' : `${fmtSol(bal, 3)}◎`}</span>
        </span>
      )}
      <Link href="/create" className="btn">+ Launch</Link>
    </nav>
  );
}

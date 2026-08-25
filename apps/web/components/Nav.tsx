'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BaseWalletMultiButton } from '@solana/wallet-adapter-react-ui';
import Glyph from './Glyph';
import { connection, fmtSol, short } from '../lib/magicpad';
import { requestAirdrop } from '../lib/wallet-tx';
import { privyEnabled, useActiveWallet } from '../lib/use-active-wallet';

const WALLET_LABELS = {
  'change-wallet': 'Change wallet',
  connecting: 'Connecting…',
  'copy-address': 'Copy address',
  copied: 'Copied',
  disconnect: 'Disconnect',
  'has-wallet': 'Connect',
  'no-wallet': 'Connect',
} as const;

export default function Nav() {
  const w = useActiveWallet();
  const { publicKey } = w;
  const [bal, setBal] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
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
    window.addEventListener('magicpad:activity', tick);
    return () => { live = false; clearInterval(t); window.removeEventListener('magicpad:activity', tick); };
  }, [publicKey]);

  const drop = async () => {
    if (!publicKey || dropping) return;
    setDropping(true);
    try { await requestAirdrop(publicKey); setBal(await connection.getBalance(publicKey)); }
    catch { /* faucet dry — the balance tick keeps polling */ }
    setDropping(false);
  };

  return (
    <div className="navwrap">
      <nav className="nav">
        <Link href="/" className="brand">
          <Glyph n="spark" size={18} />
          mooner
        </Link>
        <div className="nav-links">
          <Link href="/">Mooner</Link>
          <a href="/#how">How it works</a>
          <Link href="/explore">Explore</Link>
          <a href="/#how">About</a>
        </div>
        <div className="grow" />
        {publicKey && bal !== null && (
          <span className="pill mono"><i className="dot" />{fmtSol(bal, 3)}◎</span>
        )}
        {mounted && w.source === 'privy' && bal !== null && bal < 20_000_000 && (
          <button className="pill mono" onClick={drop} disabled={dropping}>
            {dropping ? 'dropping…' : '+1◎ devnet'}
          </button>
        )}
        {mounted && w.source === 'privy' && (
          <Link href="/wallet" className="pill icon" aria-label="your wallet" title={short(publicKey?.toBase58() ?? '')}>
            <Glyph n="wallet" size={15} />
          </Link>
        )}
        {mounted && w.source !== 'privy' && publicKey && (
          <BaseWalletMultiButton labels={WALLET_LABELS} />
        )}
        {mounted && !publicKey && (
          <button
            className="btn nav-cta"
            onClick={w.connect}
            disabled={privyEnabled && !w.privyReady}
          >
            Connect <Glyph n="arrow" size={15} />
          </button>
        )}
        {publicKey && (
          <Link href="/create" className="btn">Start launch</Link>
        )}
      </nav>
    </div>
  );
}

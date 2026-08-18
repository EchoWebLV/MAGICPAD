'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { connection, fmtSol, short } from '../lib/magicpad';
import { requestAirdrop } from '../lib/wallet-tx';
import { privyEnabled, useActiveWallet } from '../lib/use-active-wallet';

export default function Nav() {
  const w = useActiveWallet();
  const { publicKey } = w;
  const [bal, setBal] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  // wallet state only exists client-side — mount-gate it or hydration screams
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

  const drop = async () => {
    if (!publicKey || dropping) return;
    setDropping(true);
    try { await requestAirdrop(publicKey); setBal(await connection.getBalance(publicKey)); }
    catch { /* faucet dry — the balance tick keeps polling */ }
    setDropping(false);
  };

  return (
    <nav className="nav">
      <Link href="/" className="brand">MAGIC<span>PAD</span></Link>
      <span className="tag">the launchpad that pays you to trade</span>
      <div className="grow" />
      {publicKey && bal !== null && (
        <span className="pill mono"><span className="magic">◈</span> {fmtSol(bal, 3)}◎</span>
      )}
      {/* fresh embedded wallets start empty — hand them devnet SOL in place */}
      {mounted && w.source === 'privy' && bal !== null && bal < 20_000_000 && (
        <button className="pill mono" onClick={drop} disabled={dropping}>
          {dropping ? 'dropping…' : '+1◎ devnet'}
        </button>
      )}
      {mounted && privyEnabled && !w.privyAuthed && w.login && (
        <button className="btn" onClick={w.login} disabled={!w.privyReady}>Log in</button>
      )}
      {mounted && w.source === 'privy' && (
        <span className="pill mono" title={publicKey?.toBase58()}>
          {w.who ?? short(publicKey?.toBase58() ?? '')}
          {w.logout && (
            <button className="linkish" onClick={() => w.logout!()} style={{ marginLeft: 8 }}>out</button>
          )}
        </span>
      )}
      {mounted && w.source !== 'privy' && <WalletMultiButton />}
      <Link href="/create" className="btn">+ Launch</Link>
    </nav>
  );
}

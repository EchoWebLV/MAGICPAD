'use client';

/* The wallet room: receive (QR + full address), live balance, private-key
 * export, and logout. Reached by clicking your name in the nav. Export
 * opens Privy's own secure window — the key renders inside Privy's iframe
 * and never touches this app's code. */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { connection, fmtSol, solscanAccount } from '../../lib/magicpad';
import { privyEnabled, useActiveWallet } from '../../lib/use-active-wallet';
import { useExportWallet } from '@privy-io/react-auth/solana';

// only rendered under PrivyProvider (privyEnabled + privy source) — the
// hook must never run outside it
function ExportKeyButton({ address }: { address: string }) {
  const { exportWallet } = useExportWallet();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await exportWallet({ address }); } catch { /* user closed the modal */ }
        setBusy(false);
      }}
    >
      {busy ? 'opening…' : 'Export private key'}
    </button>
  );
}

export default function WalletPage() {
  const w = useActiveWallet();
  const router = useRouter();
  const { publicKey } = w;
  const address = publicKey?.toBase58() ?? null;

  // wallet state only exists client-side — mount-gate it or hydration screams
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) { setQr(null); return; }
    QRCode.toDataURL(address, { width: 260, margin: 1, color: { dark: '#0a0a0a', light: '#f2f0e9' } })
      .then(setQr).catch(() => setQr(null));
  }, [address]);

  const [bal, setBal] = useState<number | null>(null);
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

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!address) return;
    let ok = false;
    try { await navigator.clipboard.writeText(address); ok = true; }
    catch {
      // embedded/older contexts deny the async API — legacy path still
      // rides the click's user gesture
      const ta = document.createElement('textarea');
      ta.value = address;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { /* stays false */ }
      ta.remove();
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      // last resort: hand the user a ready-made selection to ⌘C
      const el = document.querySelector('.wallet-page .addr');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };

  if (!mounted) return <main className="wrap"><p className="empty">…</p></main>;

  if (!address) {
    return (
      <main className="wrap wallet-page">
        <div className="panel">
          <h3>wallet</h3>
          <p className="dim">No wallet connected.</p>
          {privyEnabled && w.login && (
            <button className="btn" onClick={w.login} disabled={!w.privyReady}>Log in</button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="wrap wallet-page">
      <div className="panel">
        <h3>wallet</h3>
        {w.who && <div className="kv"><span className="k">account</span><span className="mono">{w.who}</span></div>}
        <div className="kv"><span className="k">network</span><span className="mono">Solana devnet</span></div>
        <div className="kv">
          <span className="k">balance</span>
          <span className="mono">{bal === null ? '…' : `${fmtSol(bal, 4)}◎`}</span>
        </div>

        {qr && (
          <div className="qr-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="wallet address QR" width={260} height={260} />
          </div>
        )}

        <p className="dim addr-label">deposit address — scan or copy, then send devnet SOL to it</p>
        <div className="addr mono">{address}</div>

        <div className="wallet-actions">
          <button className="btn ghost" onClick={copy}>{copied ? 'copied ✓' : 'Copy address'}</button>
          <a className="btn ghost" href={solscanAccount(address)} target="_blank" rel="noreferrer">View on Solscan</a>
          {privyEnabled && w.source === 'privy' && <ExportKeyButton address={address} />}
          {w.source === 'privy' && w.logout && (
            <button
              className="btn ghost logout"
              onClick={async () => { await w.logout!(); router.push('/'); }}
            >
              Log out
            </button>
          )}
        </div>

        <p className="faint keynote">
          Export opens Privy&apos;s own secure window — the key never touches this app.
        </p>
      </div>
      <p className="dim backrow"><Link className="linkish" href="/">← back to the board</Link></p>
    </main>
  );
}

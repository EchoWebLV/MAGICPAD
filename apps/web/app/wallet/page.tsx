'use client';

/* The wallet room: who you are, everything you hold, receive (QR + full
 * address), live balance, private-key export, and the way out. Reached by
 * the wallet mark in the nav. Export opens Privy's own secure window — the
 * key renders inside Privy's iframe and never touches this app's code. */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { PublicKey } from '@solana/web3.js';
import TokenArt from '../../components/TokenArt';
import Glyph from '../../components/Glyph';
import { copyText } from '../../lib/clip';
import {
  LaunchView, STATE, connection, fetchLaunches, fmtSol, fmtTok, sellQuote, solscanAccount,
} from '../../lib/magicpad';
import { PositionView, readPosition } from '../../lib/trade-live';
import { privyEnabled, useActiveWallet } from '../../lib/use-active-wallet';
import { useExportWallet } from '@privy-io/react-auth/solana';

interface Holding { l: LaunchView; pos: PositionView; value: number; escrow: number }

// below this a number reads as 0.000◎ — not worth a line
const DUST = 1_000_000;

/** Everything this wallet is in: one position read per market, ER first.
 *  A market shows up if tokens are held or SOL is still parked in its
 *  escrow — both are money that belongs to the trader. */
function Holdings({ owner }: { owner: PublicKey }) {
  const [rows, setRows] = useState<Holding[] | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const launches = await fetchLaunches();
        const found: Holding[] = [];
        await Promise.all(launches.map(async (l) => {
          let pos: PositionView | null = null;
          try { pos = await readPosition(owner, l.id); } catch { return; }
          if (!pos) return;
          const escrow = pos.deposit + pos.solProceeds - pos.solSpent;
          if (pos.tokensHeld === 0n && escrow <= 0) return;
          const value = Number(sellQuote(l.virtualSol, l.virtualTok, pos.tokensHeld));
          found.push({ l, pos, value, escrow });
        }));
        found.sort((a, b) => (b.value + b.escrow) - (a.value + a.escrow));
        if (live) setRows(found);
      } catch { /* next tick */ }
    };
    tick();
    const t = setInterval(tick, 15000);
    window.addEventListener('magicpad:activity', tick);
    return () => { live = false; clearInterval(t); window.removeEventListener('magicpad:activity', tick); };
  }, [owner]);

  const worth = rows?.reduce((s, r) => s + r.value + r.escrow, 0) ?? 0;

  return (
    <div className="panel gap">
      <h3>
        holdings
        <span className="faint">{rows === null ? 'reading' : `${rows.length} market${rows.length === 1 ? '' : 's'}`}</span>
        {rows !== null && rows.length > 0 && <span className="hworth mono">{fmtSol(worth)}◎</span>}
      </h3>
      {rows === null && <div className="empty">looking through the markets</div>}
      {rows !== null && rows.length === 0 && (
        <div className="empty">nothing held yet — <Link className="linkish" href="/">find a market</Link></div>
      )}
      {rows?.map(({ l, pos, value, escrow }) => {
        const pnl = value - pos.costBasis;
        const rake = Math.floor(pos.realizedLoss / 10);
        const held = pos.tokensHeld > 0n;
        return (
          <Link key={l.id} href={`/launch/${l.id}`} className="hold">
            <TokenArt id={l.id} creator={l.creator} symbol={l.symbol} size={38} />
            <div className="hbody">
              <div className="htop">
                <span className="name">{l.name}</span>
                <span className="mono y">${l.symbol}</span>
                {l.state !== 0 && <span className="chip frozen">{STATE[l.state]}</span>}
              </div>
              <div className="hstats mono">
                {held && <span>{fmtTok(pos.tokensHeld)} {l.symbol}</span>}
                {escrow > 0 && <span className="faint">escrow {fmtSol(escrow)}◎</span>}
                {/* dust rounds to 0.000◎ — say nothing rather than say zero */}
                {rake >= DUST && <span className="faint">rakeback {fmtSol(rake)}◎</span>}
              </div>
            </div>
            <div className="hval mono">
              <b>{fmtSol(value + escrow)}◎</b>
              {held && Math.abs(pnl) >= DUST && (
                <em className={pnl >= 0 ? 'green' : 'red'}>
                  {pnl >= 0 ? '+' : '−'}{fmtSol(Math.abs(pnl))}◎
                </em>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

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
    const ok = await copyText(address);
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
        {w.who && (
          <div className="whorow">
            <span className="k">signed in as</span>
            <span className="mono who-mail">{w.who}</span>
            {w.source === 'privy' && w.logout && (
              <button
                className="btn ghost logout out"
                onClick={async () => { await w.logout!(); router.push('/'); }}
              >
                <Glyph n="out" size={12} />Log out
              </button>
            )}
          </div>
        )}
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
        </div>

        <p className="faint keynote">
          Export opens Privy&apos;s own secure window — the key never touches this app.
        </p>
      </div>
      {publicKey && <Holdings owner={publicKey} />}
      <p className="dim backrow"><Link className="linkish" href="/">← back to the board</Link></p>
    </main>
  );
}

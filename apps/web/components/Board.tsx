'use client';

/* Live market board: New / Final Stretch / Migrated. */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Glyph from './Glyph';
import TokenArt, { useLaunchMeta } from './TokenArt';
import { copyText } from '../lib/clip';
import { SHOW_DARK_CHIP } from '../lib/flags';
import { LaunchMeta } from '../lib/metadata';
import { useActiveWallet } from '../lib/use-active-wallet';
import { BUY_PRESETS, DEFAULT_BUY, readBuyPreset, writeBuyPreset } from '../lib/buy-size';
import { quickBuy } from '../lib/trade-live';
import { meteoraSwapTx } from '../lib/public-swap';
import { sendWithWallet } from '../lib/wallet-tx';
import {
  GRADUATION_LAMPORTS, LAMPORTS, LaunchView, STATE, fetchLaunches, fmtAge, fmtSol, marketCapSol,
} from '../lib/magicpad';

const HOUR = 3600;

function Socials({ meta, mint }: { meta: LaunchMeta | null; mint: string }) {
  const [copied, setCopied] = useState(false);
  const links: [string, string][] = [];
  if (meta?.twitter) links.push(['x', meta.twitter]);
  if (meta?.telegram) links.push(['tg', meta.telegram]);
  if (meta?.website) links.push(['web', meta.website]);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!await copyText(mint)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="socials">
      {links.map(([k, href]) => (
        <a
          key={k} href={href} target="_blank" rel="noreferrer" aria-label={k}
          onClick={(e) => e.stopPropagation()}
        >
          <Glyph n={k} size={12} />
        </a>
      ))}
      <button onClick={copy} aria-label="copy mint" title={mint} className={copied ? 'on' : ''}>
        <Glyph n="copy" size={12} />
      </button>
      {copied && <span className="copied mono">mint copied</span>}
    </div>
  );
}

function QuickBuy({ l, size }: { l: LaunchView; size: number }) {
  const wallet = useActiveWallet();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'' | 'ok' | 'no'>('');
  const [msg, setMsg] = useState('');
  const tradable = (l.state === 0 && l.dark) || l.state === 3;

  const fire = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (busy || !wallet.publicKey) {
      if (!wallet.publicKey) wallet.connect();
      return;
    }
    setBusy(true); setState(''); setMsg('');
    try {
      const lamports = Math.round(size * LAMPORTS);
      if (l.state === 3) {
        if (!wallet.publicKey) throw new Error('connect a wallet');
        const tx = await meteoraSwapTx(l.mint, 'buy', String(lamports), wallet.publicKey.toBase58());
        await sendWithWallet(wallet, tx);
      } else {
        await quickBuy(wallet, l.id, lamports);
      }
      setState('ok');
    } catch (err: any) {
      setState('no');
      setMsg(String(err?.message ?? err).slice(0, 90));
    }
    setBusy(false);
    setTimeout(() => { setState(''); setMsg(''); }, 3200);
  };

  if (!tradable) return null;
  return (
    <div className="qb">
      <button
        className={`qbuy${state === 'ok' ? ' done' : ''}${state === 'no' ? ' bad' : ''}`}
        onClick={fire} disabled={busy}
        title={`buy ${size}◎ of ${l.symbol}`}
      >
        <Glyph n="bolt" size={11} />
        <span className="mono">{busy ? '…' : state === 'ok' ? 'filled' : `${size}◎`}</span>
      </button>
      {state === 'no' && msg && <span className="qberr">{msg}</span>}
    </div>
  );
}

function Row({ l, size }: { l: LaunchView; size: number }) {
  const pct = Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const meta = useLaunchMeta(l.id, l.creator);
  const chip = l.state === 0
    ? (SHOW_DARK_CHIP
      ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : l.state === 3
      ? <span className="chip grad">GRADUATED</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;
  return (
    <div className="row">
      <Link href={`/launch/${l.mint}`} className="rowlink" aria-label={l.name} />
      <div className="rowgrid">
        <TokenArt id={l.id} creator={l.creator} symbol={l.symbol} size={44} />
        <div className="rowbody">
          <div className="top">
            <span className="name">{l.name}</span>
            <span className="sym mono">${l.symbol}</span>
            {chip}
            <span className="age mono">{fmtAge(l.createdTs)}</span>
          </div>
          <div className="stats mono">
            <span>MC <b>{marketCapSol(l).toFixed(1)}◎</b></span>
            <span>raised <b>{fmtSol(l.realSolRaised)}◎</b></span>
            <span>traders <b>{l.sessionsOpened}</b></span>
          </div>
          <Socials meta={meta} mint={l.mint} />
        </div>
        <QuickBuy l={l} size={size} />
      </div>
      <div className={`bar${pct >= 60 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Col({ idx, title, hint, items, size }: {
  idx: string; title: string; hint: string; items: LaunchView[]; size: number;
}) {
  return (
    <section className="col">
      <h2>
        <span className="idx mono">{idx}</span>
        {title}
        <span className="count mono">{items.length}</span>
      </h2>
      {items.length === 0 && <div className="empty">{hint}</div>}
      {items.map((l) => <Row key={l.id} l={l} size={size} />)}
    </section>
  );
}

export default function Board() {
  const [launches, setLaunches] = useState<LaunchView[] | null>(null);
  const [size, setSize] = useState(DEFAULT_BUY);

  useEffect(() => { setSize(readBuyPreset()); }, []);
  const pick = useCallback((v: number) => {
    setSize(v);
    writeBuyPreset(v);
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const data = await fetchLaunches(); if (live) setLaunches(data); } catch { /* next tick */ }
    };
    tick();
    const t = setInterval(tick, 8000);
    window.addEventListener('magicpad:activity', tick);
    return () => { live = false; clearInterval(t); window.removeEventListener('magicpad:activity', tick); };
  }, []);

  const all = useMemo(() => launches ?? [], [launches]);
  const now = Math.floor(Date.now() / 1000);
  const bonding = all.filter((l) => l.state === 0);
  const stretch = bonding.filter((l) => l.realSolRaised >= 0.6 * GRADUATION_LAMPORTS);
  const fresh = bonding.filter((l) => !stretch.includes(l) && now - l.createdTs < HOUR);
  const lingering = bonding.filter((l) => !stretch.includes(l) && !fresh.includes(l));
  const migrated = all.filter((l) => l.state >= 1);

  return (
    <main className="wrap">
      <div className="boardbar">
        <span className="eyebrow">Quick buy</span>
        <div className="presets">
          {BUY_PRESETS.map((v) => (
            <button key={v} className={`preset mono${v === size ? ' on' : ''}`} onClick={() => pick(v)}>
              {v}◎
            </button>
          ))}
        </div>
        <span className="faint bbnote">one click from any row — gasless, zero fee</span>
      </div>
      <div className="board">
        <Col idx="01" title="New" hint={launches ? 'nothing bonding right now' : 'loading'}
          items={[...fresh, ...lingering]} size={size} />
        <Col idx="02" title="Final Stretch" hint="no market past 60% of graduation yet"
          items={stretch} size={size} />
        <Col idx="03" title="Migrated" hint="graduations land here" items={migrated} size={size} />
      </div>
    </main>
  );
}

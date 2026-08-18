'use client';

/* The market: three columns, 8s poll. New = fresh dark bonding. Final
 * Stretch = bonding past 60% of graduation. Migrated = frozen and beyond
 * (settling, settled, graduated). A bonding launch always shows somewhere:
 * one that outgrew "New" without reaching the stretch stays in New — a
 * market must never vanish from the board.
 *
 * Every row carries the whole market: face, links, numbers, and a buy that
 * fires from the board — one click opens the escrow if it has to, raises it
 * if it has to, and trades gaslessly either way. */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Featured, { pickFeatured } from '../components/Featured';
import Glyph from '../components/Glyph';
import TokenArt, { useLaunchMeta } from '../components/TokenArt';
import { copyText } from '../lib/clip';
import { SHOW_DARK_CHIP, SHOW_PITCH } from '../lib/flags';
import { LaunchMeta } from '../lib/metadata';
import { useActiveWallet } from '../lib/use-active-wallet';
import { quickBuy } from '../lib/trade-live';
import {
  GRADUATION_LAMPORTS, LAMPORTS, LaunchView, STATE, fetchLaunches, fmtAge, fmtSol, marketCapSol,
} from '../lib/magicpad';

const HOUR = 3600;
const PRESETS = [0.05, 0.1, 0.5, 1];
const PRESET_KEY = 'magicpad_quickbuy';

function Socials({ meta, mint }: { meta: LaunchMeta | null; mint: string }) {
  const [copied, setCopied] = useState(false);
  const links: [string, string][] = [];
  if (meta?.twitter) links.push(['x', meta.twitter]);
  if (meta?.telegram) links.push(['tg', meta.telegram]);
  if (meta?.website) links.push(['web', meta.website]);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!await copyText(mint)) return;   // denied — the mint is on the market page too
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
  const tradable = l.state === 0 && l.dark;

  const fire = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (busy || !wallet.publicKey) {
      if (!wallet.publicKey) { setState('no'); setMsg('connect a wallet'); setTimeout(() => setState(''), 1800); }
      return;
    }
    setBusy(true); setState(''); setMsg('');
    try {
      await quickBuy(wallet, l.id, Math.round(size * LAMPORTS));
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
      <Link href={`/launch/${l.id}`} className="rowlink" aria-label={l.name} />
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

export default function Home() {
  const [launches, setLaunches] = useState<LaunchView[] | null>(null);
  const [size, setSize] = useState(0.1);

  useEffect(() => {
    const saved = Number(localStorage.getItem(PRESET_KEY));
    if (PRESETS.includes(saved)) setSize(saved);
  }, []);
  const pick = useCallback((v: number) => {
    setSize(v);
    try { localStorage.setItem(PRESET_KEY, String(v)); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const data = await fetchLaunches(); if (live) setLaunches(data); } catch { /* next tick */ }
    };
    tick();
    // the board reads L1 (two GPA sweeps per refresh) — stay polite to
    // public devnet; the terminal page is where live-feel matters, on the ER
    const t = setInterval(tick, 8000);
    window.addEventListener('magicpad:activity', tick);
    return () => { live = false; clearInterval(t); window.removeEventListener('magicpad:activity', tick); };
  }, []);

  const all = useMemo(() => launches ?? [], [launches]);
  const featured = useMemo(() => pickFeatured(all), [all]);
  const now = Math.floor(Date.now() / 1000);
  const bonding = all.filter((l) => l.state === 0);
  const stretch = bonding.filter((l) => l.realSolRaised >= 0.6 * GRADUATION_LAMPORTS);
  const fresh = bonding.filter((l) => !stretch.includes(l) && now - l.createdTs < HOUR);
  // bonding, older than an hour, under the stretch line — still belongs on the board
  const lingering = bonding.filter((l) => !stretch.includes(l) && !fresh.includes(l));
  const migrated = all.filter((l) => l.state >= 1);
  const raised = all.reduce((sum, l) => sum + l.realSolRaised, 0);

  return (
    <main className="wrap">
      <Featured items={featured} loading={!launches} />
      {SHOW_PITCH && (
        <section className="pitchbar">
          <div>
            <span className="eyebrow">Dark bonding</span>
            <h1>Nothing to <em>snipe.</em></h1>
            <p className="lede">
              Every market bonds inside a rollup. Trades cost no gas and pay no fee,
              the mint holds zero supply until graduation, and losing hands you 10% back.
            </p>
          </div>
          <div className="statgrid">
            <div className="cell">
              <span className="k">markets</span>
              <span className="v mono">{launches ? all.length : '—'}</span>
            </div>
            <div className="cell">
              <span className="k">bonding now</span>
              <span className="v mono">{launches ? bonding.length : '—'}</span>
            </div>
            <div className="cell">
              <span className="k">raised</span>
              <span className="v mono">{launches ? `${fmtSol(raised)}◎` : '—'}</span>
            </div>
            <div className="cell">
              <span className="k">trading fee</span>
              <span className="v mono y">zero</span>
            </div>
          </div>
        </section>
      )}
      <div className="boardbar">
        <span className="eyebrow">Quick buy</span>
        <div className="presets">
          {PRESETS.map((v) => (
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
      <p className="note" style={{ margin: '22px 0 44px', maxWidth: '62ch' }}>
        DARK means the market is live inside a MagicBlock Ephemeral Rollup. Trades run
        on a session key, so there is no L1 trail to read and nothing to front-run.
      </p>
    </main>
  );
}

'use client';

/* The market: three columns, 4s poll. New = fresh dark bonding. Final
 * Stretch = bonding past 60% of graduation. Migrated = frozen and beyond
 * (settling, settled, graduated). A bonding launch always shows somewhere:
 * one that outgrew "New" without reaching the stretch stays in New — a
 * market must never vanish from the board. */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import TokenArt from '../components/TokenArt';
import {
  GRADUATION_LAMPORTS, LaunchView, STATE, fetchLaunches, fmtAge, fmtSol, marketCapSol,
} from '../lib/magicpad';

const HOUR = 3600;

function Row({ l }: { l: LaunchView }) {
  const pct = Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const chip = l.state === 0
    ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
    : l.state === 3
      ? <span className="chip grad">GRADUATED</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;
  return (
    <Link href={`/launch/${l.id}`} className="row">
      <div className="rowgrid">
        <TokenArt id={l.id} creator={l.creator} symbol={l.symbol} size={40} />
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
        </div>
      </div>
      <div className={`bar${pct >= 60 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
    </Link>
  );
}

function Col({ idx, title, hint, items }: {
  idx: string; title: string; hint: string; items: LaunchView[];
}) {
  return (
    <section className="col">
      <h2>
        <span className="idx mono">{idx}</span>
        {title}
        <span className="count mono">{items.length}</span>
      </h2>
      {items.length === 0 && <div className="empty">{hint}</div>}
      {items.map((l) => <Row key={l.id} l={l} />)}
    </section>
  );
}

export default function Home() {
  const [launches, setLaunches] = useState<LaunchView[] | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const data = await fetchLaunches(); if (live) setLaunches(data); } catch { /* next tick */ }
    };
    tick();
    // the board reads L1 (two GPA sweeps per refresh) — stay polite to
    // public devnet; the terminal page is where live-feel matters, on the ER
    const t = setInterval(tick, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const all = launches ?? [];
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
      <header className="masthead">
        <div>
          <span className="eyebrow">Dark bonding</span>
          <h1>Nothing<br />to <em>snipe.</em></h1>
          <p className="lede">
            Every market bonds inside a rollup. Trades cost no gas and pay no fee,
            the mint holds zero supply until graduation, and losing hands you 10% back.
          </p>
        </div>
        <div className="mh-stats">
          <div className="stat">
            <span className="k">markets</span>
            <span className="v mono">{launches ? all.length : '—'}</span>
          </div>
          <div className="stat">
            <span className="k">bonding now</span>
            <span className="v mono">{launches ? bonding.length : '—'}</span>
          </div>
          <div className="stat">
            <span className="k">raised</span>
            <span className="v mono">{launches ? `${fmtSol(raised)}◎` : '—'}</span>
          </div>
          <div className="stat">
            <span className="k">trading fee</span>
            <span className="v mono y">zero</span>
          </div>
        </div>
      </header>
      <div className="board">
        <Col idx="01" title="New" hint={launches ? 'nothing bonding right now' : 'loading'}
          items={[...fresh, ...lingering]} />
        <Col idx="02" title="Final Stretch" hint="no market past 60% of graduation yet" items={stretch} />
        <Col idx="03" title="Migrated" hint="graduations land here" items={migrated} />
      </div>
      <p className="note" style={{ margin: '22px 0 44px', maxWidth: '62ch' }}>
        DARK means the market is live inside a MagicBlock Ephemeral Rollup. Trades run
        on a session key, so there is no L1 trail to read and nothing to front-run.
      </p>
    </main>
  );
}

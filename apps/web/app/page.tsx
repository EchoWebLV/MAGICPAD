'use client';

/* The market: three columns, 4s poll. New = fresh dark bonding. Final
 * Stretch = bonding past 60% of graduation. Migrated = frozen and beyond
 * (settling, settled, graduated). A bonding launch always shows somewhere:
 * one that outgrew "New" without reaching the stretch stays in New — a
 * market must never vanish from the board. */

import Link from 'next/link';
import { useEffect, useState } from 'react';
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
      <div className={`bar${pct >= 60 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
    </Link>
  );
}

function Col({ title, hint, items }: { title: string; hint: string; items: LaunchView[] }) {
  return (
    <section className="col">
      <h2>{title} <span className="count">{items.length}</span></h2>
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
    const t = setInterval(tick, 4000);
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

  return (
    <main className="wrap">
      <div className="cols">
        <Col title="New" hint={launches ? 'nothing bonding right now — launch something' : 'loading…'}
          items={[...fresh, ...lingering]} />
        <Col title="Final Stretch" hint="no market past 60% of graduation yet" items={stretch} />
        <Col title="Migrated" hint="graduations land here" items={migrated} />
      </div>
      <p className="note wrap" style={{ paddingBottom: 18 }}>
        Bonding happens inside a MagicBlock Ephemeral Rollup: gasless trades on a session key,
        zero supply on L1 until graduation, and losses pay 10% back. DARK means live and unsnipable.
      </p>
    </main>
  );
}

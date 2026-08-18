'use client';

/* The top of the page moves. Five markets ride a rail, one at a time, and
 * four layers drift at different rates under the pointer and the scroll:
 * the token's own art washed across the back, its ticker ghosted behind the
 * tile, the tile itself, and the copy — each on its own multiplier, so the
 * band has depth instead of a picture pasted on black.
 *
 * Nothing here is decoration on top of nothing: "featured" means the live
 * bonding markets with the most SOL behind them right now, and every number
 * on the slide is the same chain read the board below runs on. */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import TokenArt from './TokenArt';
import { SHOW_DARK_CHIP } from '../lib/flags';
import { LaunchMeta, resolveMeta } from '../lib/metadata';
import {
  GRADUATION_LAMPORTS, LaunchView, STATE, fmtAge, fmtSol, marketCapSol,
} from '../lib/magicpad';

const DWELL = 7000;   // ms per slide
const SEATS = 5;      // how many markets make the rail

const pad = (n: number) => String(n).padStart(2, '0');

/** Loudest first: live bonding markets by SOL raised, then the rest by age.
 *  Recomputed every poll, so a market that pulls ahead takes the front. */
export function pickFeatured(all: LaunchView[]): LaunchView[] {
  const live = all.filter((l) => l.state === 0)
    .sort((a, b) => b.realSolRaised - a.realSolRaised || b.createdTs - a.createdTs);
  const rest = all.filter((l) => l.state !== 0).sort((a, b) => b.createdTs - a.createdTs);
  return [...live, ...rest].slice(0, SEATS);
}

export default function Featured({ items, loading }: { items: LaunchView[]; loading: boolean }) {
  const [n, setN] = useState(0);              // raw counter; the index is n % count
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);  // prefers-reduced-motion
  const [metas, setMetas] = useState<Record<number, LaunchMeta | null>>({});
  const asked = useRef(new Set<number>());
  const box = useRef<HTMLElement>(null);

  const count = items.length;
  const idx = count ? ((n % count) + count) % count : 0;
  const cur = items[idx];

  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => setStill(q.matches);
    read();
    q.addEventListener('change', read);
    return () => q.removeEventListener('change', read);
  }, []);

  // faces for the rail — resolveMeta caches forever, so each id costs one look
  useEffect(() => {
    let live = true;
    for (const l of items) {
      if (asked.current.has(l.id)) continue;
      asked.current.add(l.id);
      resolveMeta(l.id, l.creator).then((m) => {
        if (live) setMetas((p) => ({ ...p, [l.id]: m }));
      });
    }
    return () => { live = false; };
  }, [items]);

  // the dwell restarts whenever the slide changes, however it changed
  useEffect(() => {
    if (paused || still || count < 2) return;
    const t = setTimeout(() => setN((v) => v + 1), DWELL);
    return () => clearTimeout(t);
  }, [idx, paused, still, count]);

  // scroll depth, written straight to a custom property — no re-render per frame
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const el = box.current;
      if (el) el.style.setProperty('--sy', Math.min(1, window.scrollY / 420).toFixed(3));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [still]);

  const onMove = (e: React.MouseEvent) => {
    const el = box.current;
    if (!el || still) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  };

  const rest = () => {
    const el = box.current;
    if (!el) return;
    el.style.setProperty('--px', '0');
    el.style.setProperty('--py', '0');
  };

  if (!cur) {
    return (
      <section className="featured bare">
        <div className="fhead">
          <span className="eyebrow">Featured</span>
          <div className="fprog" />
        </div>
        <div className="fwait">{loading ? 'reading the chain' : 'the first market lands here'}</div>
      </section>
    );
  }

  const pct = Math.min(100, (cur.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const desc = metas[cur.id]?.description?.trim();
  const chip = cur.state === 0
    ? (SHOW_DARK_CHIP
      ? (cur.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : cur.state === 3
      ? <span className="chip grad">GRADUATED</span>
      : <span className="chip frozen">{STATE[cur.state]}</span>;

  return (
    <section
      className="featured" ref={box}
      onMouseMove={onMove} onMouseLeave={() => { rest(); setPaused(false); }}
      onMouseEnter={() => setPaused(true)}
      onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}
    >
      <div className="fbgs" aria-hidden="true">
        {items.map((l, i) => {
          const img = metas[l.id]?.image;
          return (
            <div
              key={l.id} className={`fbg${i === idx ? ' on' : ''}`}
              style={img
                ? { backgroundImage: `url(${img})` }
                : { background: `linear-gradient(${(l.id * 137.5) % 360}deg, rgba(255,199,0,0.5), transparent 66%)` }}
            />
          );
        })}
      </div>
      <div className="fveil" aria-hidden="true" />

      <div className="fhead">
        <span className="eyebrow">Featured</span>
        <div className="fprog">
          {count > 1 && !still && (
            <i
              key={`${idx}-${paused}`}
              style={{ animationDuration: `${DWELL}ms`, animationPlayState: paused ? 'paused' : 'running' }}
            />
          )}
        </div>
        <span className="fcount mono">{pad(idx + 1)} / {pad(count)}</span>
      </div>

      <article className="fslide" key={cur.id}>
        <div className="fbody">
          <div className="fmeta">
            {chip}
            <span className="mono faint">{fmtAge(cur.createdTs)} old</span>
            <span className="mono faint">market {pad(cur.id)}</span>
          </div>
          <Link href={`/launch/${cur.id}`} className="fname">{cur.name}</Link>
          <p className="fdesc">{desc || `Bonding on the curve. ${cur.sessionsOpened} traders in so far.`}</p>
          <div className="fnums">
            <span><b className="mono">{marketCapSol(cur).toFixed(1)}◎</b><em>market cap</em></span>
            <span><b className="mono">{fmtSol(cur.realSolRaised)}◎</b><em>raised</em></span>
            <span><b className="mono">{cur.sessionsOpened}</b><em>traders</em></span>
          </div>
          <div className={`bar${pct >= 60 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
          <div className="fgo">
            <Link href={`/launch/${cur.id}`} className="btn">Trade ${cur.symbol}</Link>
            <span className="mono faint">{pct.toFixed(0)}% of the way to graduation</span>
          </div>
        </div>
        <div className="fartwrap">
          <span className="fghost" aria-hidden="true">{cur.symbol}</span>
          <Link href={`/launch/${cur.id}`} className="fart" aria-label={cur.name}>
            <TokenArt id={cur.id} creator={cur.creator} symbol={cur.symbol} size={240} />
          </Link>
        </div>
      </article>

      <div className="frail">
        {items.map((l, i) => (
          <button
            key={l.id} className={`fthumb${i === idx ? ' on' : ''}`} onClick={() => setN(i)}
            aria-label={`show ${l.name}`} aria-current={i === idx}
          >
            <TokenArt id={l.id} creator={l.creator} symbol={l.symbol} size={38} />
          </button>
        ))}
        {count > 1 && (
          <div className="fnav">
            <button onClick={() => setN(idx - 1)} aria-label="previous market">‹</button>
            <button onClick={() => setN(idx + 1)} aria-label="next market">›</button>
          </div>
        )}
      </div>
    </section>
  );
}

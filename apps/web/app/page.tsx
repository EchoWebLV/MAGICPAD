'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Glyph from '../components/Glyph';
import TokenArt from '../components/TokenArt';
import { pickFeatured } from '../components/Featured';
import {
  GRADUATION_LAMPORTS, LaunchView, fetchLaunches, fmtSol,
} from '../lib/magicpad';

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function Landing() {
  const [launches, setLaunches] = useState<LaunchView[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchLaunches().then((d) => { if (live) setLaunches(d); }).catch(() => { /* next */ });
    return () => { live = false; };
  }, []);

  const all = launches ?? [];
  const featured = useMemo(() => pickFeatured(all).slice(0, 3), [all]);
  const raised = all.reduce((s, l) => s + l.realSolRaised, 0);
  const traders = all.reduce((s, l) => s + l.sessionsOpened, 0);

  return (
    <main className="lp">
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <h1>
            Launch the<br />
            <span className="lp-mark">fairest</span>
            token
          </h1>
          <p>
            No bundles. No snipers. The curve trades gasless in the dark until graduation —
            then the market goes public.
          </p>
          <div className="lp-cta">
            <Link href="/create" className="btn lp-btn">
              Start launch <Glyph n="arrow" size={16} />
            </Link>
            <Link href="/explore" className="btn ghost lp-btn">
              Explore launches
            </Link>
          </div>
        </div>
        <div className="lp-hero-art">
          <img src="/mascot-hero.png" alt="" />
        </div>
      </section>

      <section className="lp-block" id="explore">
        <div className="lp-block-head">
          <h2><Glyph n="spark" size={16} /> Featured launches</h2>
          <Link href="/explore" className="lp-more">
            View all launches <Glyph n="arrow" size={14} />
          </Link>
        </div>
        <div className="lp-cards">
          {(featured.length ? featured : [null, null, null]).map((l, i) => (
            l ? (
              <Link key={l.id} href={`/launch/${l.mint}`} className="lp-card">
                <TokenArt id={l.id} creator={l.creator} symbol={l.symbol} size={72} />
                <div className="lp-card-body">
                  <div className="lp-card-top">
                    <b>{l.name}</b>
                    <span className="chip">${l.symbol}</span>
                  </div>
                  <div className="lp-prog">
                    <i style={{ width: `${Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100)}%` }} />
                    <span>{Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100).toFixed(0)}%</span>
                  </div>
                  <div className="lp-card-meta">
                    <div>
                      <em>Raised</em>
                      <strong>{fmtSol(l.realSolRaised)}◎</strong>
                    </div>
                    <div>
                      <em>Launch date</em>
                      <strong>{fmtDate(l.createdTs)}</strong>
                    </div>
                  </div>
                </div>
              </Link>
            ) : (
              <div key={i} className="lp-card lp-card-empty">{launches ? '—' : 'loading'}</div>
            )
          ))}
        </div>
      </section>

      <section className="lp-steps" id="how">
        <div className="lp-step">
          <img src="/step-create.png" alt="" />
          <div>
            <h3>Create token</h3>
            <p>Set up your token with just a few clicks.</p>
          </div>
        </div>
        <div className="lp-step">
          <img src="/step-dark.png" alt="" />
          <div>
            <h3>Bond dark</h3>
            <p>The curve trades gasless on the rollup — nothing to snipe.</p>
          </div>
        </div>
        <div className="lp-step">
          <img src="/step-live.png" alt="" />
          <div>
            <h3>Go live</h3>
            <p>Graduation takes the market public. Let the community in.</p>
          </div>
        </div>
      </section>

      <section className="lp-stats">
        <div className="lp-stat">
          <span className="lp-ico">$</span>
          <div>
            <b>{launches ? `${fmtSol(raised)}◎` : '—'}</b>
            <em>Total raised</em>
          </div>
        </div>
        <div className="lp-stat">
          <span className="lp-ico">↑</span>
          <div>
            <b>{launches ? all.length : '—'}</b>
            <em>Launches</em>
          </div>
        </div>
        <div className="lp-stat">
          <span className="lp-ico">☺</span>
          <div>
            <b>{launches ? traders.toLocaleString('en-US') : '—'}</b>
            <em>Traders</em>
          </div>
        </div>
      </section>

      <section className="lp-banner">
        <img src="/mascot.png" alt="" />
        <div>
          <h2>Ready to launch something legendary?</h2>
          <p>Join creators bonding in the dark — then graduating in the light.</p>
        </div>
        <Link href="/create" className="btn lp-btn">
          Start your launch <Glyph n="arrow" size={16} />
        </Link>
      </section>
    </main>
  );
}

/* /receipt/<id> — the shareable proof that a dark market settled straight.
 *
 * Rendered on the server from chain data at request time. Everything here
 * is reproducible by a stranger: scripts/verify-receipt.mjs rebuilds the
 * same numbers from a public RPC, which is why the page ends by telling
 * you how to check it instead of asking you to believe it. */

import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { LAMPORTS, TOKEN_DECIMALS } from '../../../lib/core';
import { resolveLaunchId } from '../../../lib/ledger';
import { Receipt, buildReceipt } from '../../../lib/receipt';
import './receipt.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const sol = (l: number, dp = 6) => (l / LAMPORTS).toFixed(dp);
const tok = (raw: number) =>
  (raw / 10 ** TOKEN_DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 6 });
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const scanTx = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`;
const scanAcct = (a: string) => `https://solscan.io/account/${a}?cluster=devnet`;
const when = (ms: number) =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

async function load(param: string): Promise<Receipt | null> {
  const id = await resolveLaunchId(param);
  return id === null ? null : buildReceipt(id);
}

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<Metadata> {
  const { id } = await params;
  const r = await load(id).catch(() => null);
  if (!r) return { title: 'Receipt — Mooner' };
  return {
    title: `${r.symbol} settlement receipt — ${r.verdict}`,
    description: r.verdictReason,
  };
}

function Check({ state }: { state: 'y' | 'n' | 'q' }) {
  const label = state === 'y' ? 'reproduces' : state === 'n' ? 'does not reproduce' : 'not checkable yet';
  return <span className={`rc-chk ${state} mono`}>{label}</span>;
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: param } = await params;
  const r = await load(param).catch(() => null);
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host') ?? 'localhost:3020'}`;

  if (!r) {
    return (
      <main className="rc">
        <Link href="/explore" className="rc-back">← all markets</Link>
        <div className="rc-head"><h1 className="rc-title">No such market</h1>
          <p className="rc-sub">Nothing on this program matches <span className="mono">{param}</span>.</p>
        </div>
      </main>
    );
  }

  const o = r.ordering;
  const m = r.money;
  const trades = r.events.filter((e) => e.kind === 'BUY' || e.kind === 'SELL');
  const tone = r.verdict === 'VERIFIED' ? 'ok' : r.verdict === 'FAILED' ? 'no' : '';
  // Only a settled market can fail a check; before that a red cross would
  // be reporting a race, not a finding.
  const st = (pass: boolean): 'y' | 'n' | 'q' =>
    pass ? 'y' : r.verdict === 'UNVERIFIABLE' ? 'q' : 'n';

  return (
    <main className="rc">
      <Link href={`/launch/${r.mint}`} className="rc-back">← {r.name} market</Link>

      <header className="rc-head">
        <h1 className="rc-title">{r.name} <span>settlement receipt</span></h1>
        <p className="rc-sub mono">
          launch #{r.launchId} · {r.state} · created {when(r.createdAt)} ·{' '}
          <a href={scanAcct(r.mint)} target="_blank" rel="noreferrer">{r.mint}</a>
        </p>
      </header>

      <section className={`rc-verdict ${tone}`}>
        <span className="rc-badge">{r.verdict}</span>
        <p className="rc-why">{r.verdictReason}</p>
      </section>

      <section className="rc-sec">
        <div className="rc-h">
          <h2>Money · winners were paid out of losers</h2>
          <Check state={m.balances ? 'y' : 'q'} />
        </div>
        <p className="rc-note">
          Every trader escrows into their own session account, and settlement moves
          the losers’ net into the pot before any winner can draw from it. Summing
          each session’s signed net has to land on the launch’s own{' '}
          <span className="mono">real_sol_raised</span>. Nothing else moved.
        </p>
        <div className="rc-card rc-scroll">
          <table className="rc-t mono">
            <thead>
              <tr>
                <th>trader</th><th>deposit</th><th>spent</th><th>proceeds</th>
                <th>net</th><th>settled</th>
              </tr>
            </thead>
            <tbody>
              {r.sessions.map((s) => (
                <tr key={s.pda}>
                  <td><a href={scanAcct(s.trader)} target="_blank" rel="noreferrer">{short(s.trader)}</a></td>
                  <td>{sol(s.deposit)}</td>
                  <td>{sol(s.solSpent)}</td>
                  <td>{sol(s.solProceeds)}</td>
                  <td className={s.net > 0 ? 'red' : s.net < 0 ? 'green' : 'dim'}>
                    {s.net > 0 ? '+' : ''}{sol(s.net)}
                  </td>
                  <td className={s.reconciled ? 'dim' : 'faint'}>{s.reconciled ? 'yes' : 'pending'}</td>
                </tr>
              ))}
              {!r.sessions.length && (
                <tr><td colSpan={6} className="faint" style={{ textAlign: 'left' }}>no sessions opened</td></tr>
              )}
              <tr className="sum">
                <td>Σ nets</td>
                <td colSpan={3} className="faint" style={{ textAlign: 'left' }}>
                  must equal real_sol_raised {m.realSolRaised.toLocaleString('en-US')}
                </td>
                <td colSpan={2}>{m.sumNets.toLocaleString('en-US')} lamports</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="rc-sec">
        <div className="rc-h">
          <h2>Reserves · nothing added, dropped or altered</h2>
          <Check state={st(o.reservesMatch)} />
        </div>
        <p className="rc-note">
          Replaying the trades below through the program’s own quote math has to end
          on the virtual reserves the chain is holding. Drop a trade, insert one, or
          change an amount by a single lamport and these numbers separate.
        </p>
        <div className="rc-card rc-pair mono">
          <div><div className="k">replayed from the trade log</div>
            <div className="v">{o.replayVirtualSol}<br />{o.replayVirtualTok}</div></div>
          <div><div className="k">held on chain right now</div>
            <div className="v">{o.chainVirtualSol}<br />{o.chainVirtualTok}</div></div>
        </div>
      </section>

      <section className="rc-sec">
        <div className="rc-h">
          <h2>Fills · nothing reordered</h2>
          <Check state={st(o.ledgerMatches)} />
        </div>
        <p className="rc-note">
          Reserves alone are a weaker check than they look: under constant product the
          end state depends only on the sums, so two same-direction trades could be
          swapped without moving them. Each trader’s settled ledger is what closes
          that door — a reordered sell fills at a different price, and a reordered buy
          receives a different number of tokens.
        </p>
        <div className="rc-card rc-scroll">
          <table className="rc-t mono">
            <thead>
              <tr>
                <th>trader</th><th>spent (replay / chain)</th>
                <th>proceeds (replay / chain)</th><th>tokens (replay / chain)</th><th></th>
              </tr>
            </thead>
            <tbody>
              {o.ledger.map((c) => (
                <tr key={c.session}>
                  <td><a href={scanAcct(c.trader)} target="_blank" rel="noreferrer">{short(c.trader)}</a></td>
                  <td>{sol(c.replaySpent)} / {sol(c.chainSpent)}</td>
                  <td>{sol(c.replayProceeds)} / {sol(c.chainProceeds)}</td>
                  <td>{tok(c.replayTokens)} / {tok(c.chainTokens)}</td>
                  <td className={c.matches ? 'green' : 'red'}>{c.matches ? '=' : '≠'}</td>
                </tr>
              ))}
              {!o.ledger.length && (
                <tr><td colSpan={5} className="faint" style={{ textAlign: 'left' }}>
                  nothing settled yet — no ledger to hold the replay against
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rc-sec">
        <div className="rc-h">
          <h2>Order flow · {trades.length} trades, {r.counts.events} events</h2>
          <span className="rc-chk q mono">
            {r.counts.scannedL1} L1 + {r.counts.scannedEr} rollup signatures scanned
          </span>
        </div>
        <p className="rc-note">
          Hidden while the curve ran — this is what snipers could not read. Published
          in full the moment it stopped, every line a real signed transaction.
        </p>
        <div className="rc-card rc-scroll">
          <table className="rc-t mono">
            <thead>
              <tr><th>time</th><th>event</th><th>where</th><th>actor</th><th>amount</th><th>signature</th></tr>
            </thead>
            <tbody>
              {r.events.map((e) => (
                <tr key={`${e.sig}-${e.kind}`}>
                  <td style={{ textAlign: 'left' }} className="faint">{when(e.at).slice(5, 19)}</td>
                  <td style={{ textAlign: 'left' }}>
                    <span className={`tag ${e.kind === 'BUY' ? 'buy' : e.kind === 'SELL' ? 'sell' : ''}`}>{e.kind}</span>
                  </td>
                  <td><span className={`tag ${e.er ? 'er' : ''}`}>{e.er ? 'rollup' : 'L1'}</span></td>
                  <td><a href={scanAcct(e.actor)} target="_blank" rel="noreferrer">{short(e.actor)}</a></td>
                  <td>{e.sol ? `${sol(e.sol)} SOL` : e.tok ? `${tok(e.tok)} ${r.symbol}` : ''}</td>
                  <td><a href={scanTx(e.sig)} target="_blank" rel="noreferrer">{short(e.sig)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rc-sec">
        <div className="rc-h"><h2>Check it yourself</h2></div>
        <div className="rc-how">
          <p>
            None of this needs Mooner to be honest, and none of it needs this page to
            be up. The verifier reads a public Solana RPC and the MagicBlock rollup
            nodes, rebuilds the market from scratch, and then diffs its own findings
            against what this page served — so if we lied, it says so.
          </p>
          <div className="rc-cmd mono">node scripts/verify-receipt.mjs {r.mint} --against {origin}/api/receipt/{r.launchId}</div>
        </div>
      </section>

      <footer className="rc-foot mono">
        program {r.source.programId}<br />
        launch account <a href={scanAcct(r.launch)} target="_blank" rel="noreferrer">{r.launch}</a>
        {r.pool && <> · pool <a href={scanAcct(r.pool)} target="_blank" rel="noreferrer">{short(r.pool)}</a></>}<br />
        live state read from {r.source.live === 'er' ? 'the rollup' : 'L1'}
        {r.source.erEndpoint && <> · ledger recovered from {r.source.erEndpoint}</>}<br />
        generated {when(r.generatedAt)}
      </footer>
    </main>
  );
}

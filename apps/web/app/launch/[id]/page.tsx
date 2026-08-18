'use client';

/* The terminal for one market. Left: live curve + activity implied from
 * curve deltas (the whole point of dark bonding is that there is no public
 * trade log to scrape — the curve moving IS the only tell). Right: the
 * wallet's session — one approved deposit, then gasless ER buys/sells. */

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  FIRST_WINDOW_MAX_BUY, GRADUATION_LAMPORTS, LAMPORTS, MIN_DEPOSIT, STATE,
  TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, buyQuote, fmtSol, fmtTok, sellQuote, short,
} from '../../../lib/magicpad';
import {
  PositionView, buyLive, ensureTradeSession, readLaunchLive, readPosition, sellLive,
} from '../../../lib/trade-live';
import { walletBalance } from '../../../lib/wallet-tx';

interface Live {
  name: string; symbol: string; state: number; dark: boolean; createdTs: number;
  virtualSol: bigint; virtualTok: bigint; realSolRaised: number; tokensSold: number;
  sessionsOpened: number; mint: string;
}
interface Tick { side: 'BUY' | 'SELL'; sol: number; tok: number; at: number }

const toLive = (l: any, dark: boolean): Live => ({
  name: l.name, symbol: l.symbol, state: l.state, dark,
  createdTs: l.createdTs.toNumber(),
  virtualSol: BigInt(l.virtualSol.toString()),
  virtualTok: BigInt(l.virtualTok.toString()),
  realSolRaised: l.realSolRaised.toNumber(),
  tokensSold: l.tokensSold.toNumber(),
  sessionsOpened: l.sessionsOpened.toNumber(),
  mint: l.mint.toBase58(),
});

export default function LaunchPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number.parseInt(idParam ?? '', 10);
  const wallet = useWallet();
  const { publicKey } = wallet;

  const [live, setLive] = useState<Live | null>(null);
  const [gone, setGone] = useState(false);
  const [pos, setPos] = useState<PositionView | null>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [feed, setFeed] = useState<Tick[]>([]);
  const prev = useRef<Live | null>(null);

  const [depositIn, setDepositIn] = useState('0.05');
  const [buyIn, setBuyIn] = useState('0.01');
  const [sellIn, setSellIn] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const refreshBal = useCallback(() => {
    if (!publicKey) { setBal(null); return; }
    walletBalance(publicKey).then(setBal).catch(() => { /* next call */ });
  }, [publicKey]);
  useEffect(() => { refreshBal(); }, [refreshBal]);

  // the tick rides the ER (gasless node, generous limits); L1 only gets the
  // rare owner-flip check — public devnet 429s anything chattier
  const refresh = useCallback(async () => {
    if (!Number.isInteger(id)) return;
    const [r, p] = await Promise.all([
      readLaunchLive(id).catch(() => null),
      publicKey ? readPosition(publicKey, id).catch(() => null) : Promise.resolve(null),
    ]);
    if (r) {
      const v = toLive(r.l, r.dark);
      const was = prev.current;
      if (was && v.tokensSold !== was.tokensSold) {
        const dTok = v.tokensSold - was.tokensSold;
        const dSol = v.realSolRaised - was.realSolRaised;
        const t: Tick = dTok > 0
          ? { side: 'BUY', sol: dSol, tok: dTok, at: Date.now() }
          : { side: 'SELL', sol: -dSol, tok: -dTok, at: Date.now() };
        setFeed((f) => [t, ...f].slice(0, 40));
      }
      prev.current = v;
      setLive(v);
    } else if (r === null && live === null) setGone(true);
    setPos(p);
  }, [id, live, publicKey]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!Number.isInteger(id)) return <main className="wrap"><p className="empty">bad launch id</p></main>;
  if (gone && !live) return <main className="wrap"><p className="empty">no such market</p></main>;
  if (!live) return <main className="wrap"><p className="empty">loading market…</p></main>;

  const l = live;
  const pct = Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const mc = Number(l.virtualSol) * TOKEN_TOTAL_SUPPLY / Number(l.virtualTok) / LAMPORTS;
  const spotPerTok = Number(l.virtualSol) / Number(l.virtualTok) * 10 ** TOKEN_DECIMALS; // lamports per display token
  const now = Math.floor(Date.now() / 1000);
  const inFirstWindow = l.state === 0 && now - l.createdTs < 60;
  const tradable = l.state === 0 && l.dark;

  // escrow available for buys = deposit + proceeds − spent
  const avail = pos ? pos.deposit + pos.solProceeds - pos.solSpent : 0;
  const net = pos ? pos.solProceeds - pos.solSpent : 0;

  const buyLamports = Math.round((Number.parseFloat(buyIn) || 0) * LAMPORTS);
  const buyOut = buyLamports > 0 ? buyQuote(l.virtualSol, l.virtualTok, BigInt(buyLamports)) : 0n;
  const sellRawWanted = BigInt(Math.round((Number.parseFloat(sellIn) || 0) * 10 ** TOKEN_DECIMALS));
  const sellRaw = pos && sellRawWanted > pos.tokensHeld ? pos.tokensHeld : sellRawWanted;
  const sellOut = sellRaw > 0n ? sellQuote(l.virtualSol, l.virtualTok, sellRaw) : 0n;

  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(''); setOk(''); setBusy(label);
    try { await fn(); setOk(`${label} confirmed`); await refresh(); refreshBal(); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy('');
  };

  const depositLamports = Math.round((Number.parseFloat(depositIn) || 0) * LAMPORTS);
  const chip = l.state === 0
    ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
    : l.state === 3 ? <span className="chip grad">GRADUATED</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;

  return (
    <main className="wrap">
      <div className="trade-grid">
        <section>
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 18 }}>{l.name}</span>
              <span className="mono magic">${l.symbol}</span>
              {chip}
              <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }} title={l.mint}>
                mint {short(l.mint)}
              </span>
            </div>
            <div className="kv" style={{ marginTop: 10 }}>
              <span className="k">market cap</span><span className="mono">{mc.toFixed(2)}◎</span>
            </div>
            <div className="kv">
              <span className="k">spot</span>
              <span className="mono">{(spotPerTok / LAMPORTS).toFixed(9)}◎ / {l.symbol}</span>
            </div>
            <div className="kv">
              <span className="k">raised</span>
              <span className="mono">{fmtSol(l.realSolRaised)}◎ / {fmtSol(GRADUATION_LAMPORTS, 0)}◎</span>
            </div>
            <div className="kv">
              <span className="k">tokens sold</span><span className="mono">{fmtTok(l.tokensSold)}</span>
            </div>
            <div className="kv">
              <span className="k">traders</span><span className="mono">{l.sessionsOpened}</span>
            </div>
            <div className={`bar${pct >= 60 ? ' hot' : ''}`} style={{ marginTop: 10 }}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <p className="note">
              {l.state === 0 && l.dark && 'Bonding dark inside the Ephemeral Rollup. On L1 this mint has zero supply and zero trades — nothing to snipe.'}
              {l.state === 0 && !l.dark && 'Bonding but not delegated — trades open once it goes dark.'}
              {l.state === 1 && 'Frozen. The keeper is committing state home and reconciling sessions.'}
              {l.state === 2 && 'Reconciled. Tokens are being claimed to traders, rakeback paid on losses.'}
              {l.state === 3 && 'Graduated. Liquidity moves to the DEX; tokens are in traders’ wallets.'}
            </p>
            {inFirstWindow && (
              <p className="note gold">
                first window: buys capped at {fmtSol(FIRST_WINDOW_MAX_BUY, 1)}◎ gross per session for the first 60s
              </p>
            )}
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h3>curve activity <span className="faint">(implied from curve deltas — dark markets have no public trade log)</span></h3>
            <div className="feed">
              {feed.length === 0 && <div className="empty" style={{ padding: 18 }}>watching the curve…</div>}
              {feed.map((t) => (
                <div className="t mono" key={t.at + t.side}>
                  <span className={t.side === 'BUY' ? 'green' : 'red'}>{t.side}</span>
                  <span>{fmtSol(t.sol, 4)}◎</span>
                  <span className="dim">{fmtTok(t.tok)} {l.symbol}</span>
                  <span className="faint" style={{ marginLeft: 'auto' }}>
                    {new Date(t.at).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          {!pos && !publicKey && (
            <div className="panel">
              <h3>trade this market</h3>
              <p className="note" style={{ marginTop: 0 }}>
                Connect a wallet (top right) to open a session. One approval escrows your stake;
                every trade after that is gasless — no popups, no fees.
              </p>
            </div>
          )}
          {!pos && publicKey && (
            <div className="panel">
              <h3>open a session</h3>
              <p className="note" style={{ marginTop: 0 }}>
                Your wallet approves one transaction: it escrows your stake and hands a throwaway
                session key to the ER. Every trade after that is gasless — no popups.
              </p>
              <div className="field">
                <label>deposit (min {fmtSol(MIN_DEPOSIT, 2)}◎ · balance {bal === null ? '…' : `${fmtSol(bal)}◎`})</label>
                <input value={depositIn} onChange={(e) => setDepositIn(e.target.value)} inputMode="decimal" />
              </div>
              <button
                className="btn" style={{ width: '100%' }}
                disabled={!!busy || !tradable || depositLamports < MIN_DEPOSIT || bal === null || bal < depositLamports + 5e6}
                onClick={run('session open', () => ensureTradeSession(wallet, id, depositLamports))}
              >
                {busy === 'session open' ? 'waiting for wallet…' : `Deposit ${fmtSol(depositLamports)}◎ & go dark`}
              </button>
              {!tradable && <p className="note">this market is not tradable ({l.dark ? STATE[l.state] : 'not delegated'})</p>}
              {tradable && bal !== null && bal < depositLamports + 5e6 && (
                <p className="note">not enough devnet SOL for this deposit — top up or airdrop from the launch page</p>
              )}
            </div>
          )}

          {pos && (
            <div className="panel">
              <h3>your session</h3>
              <div className="kv"><span className="k">deposit</span><span className="mono">{fmtSol(pos.deposit)}◎</span></div>
              <div className="kv"><span className="k">available</span><span className="mono">{fmtSol(avail)}◎</span></div>
              <div className="kv"><span className="k">holding</span><span className="mono">{fmtTok(pos.tokensHeld)} {l.symbol}</span></div>
              <div className="kv">
                <span className="k">realized net</span>
                <span className={`mono ${net > 0 ? 'green' : net < 0 ? 'red' : ''}`}>
                  {net >= 0 ? '+' : '−'}{fmtSol(Math.abs(net), 4)}◎
                </span>
              </div>
              {pos.realizedLoss > 0 && (
                <div className="kv">
                  <span className="k">rakeback owed</span>
                  <span className="mono green">{fmtSol(Math.floor(pos.realizedLoss / 10), 4)}◎</span>
                </div>
              )}
              {pos.reconciled && (
                <p className="ok">settled — escrow returned; token claims and rakeback are cranked automatically</p>
              )}
            </div>
          )}

          {pos && !pos.reconciled && tradable && (
            <>
              <div className="panel" style={{ marginTop: 12 }}>
                <h3>buy <span className="faint">gasless · zero fee</span></h3>
                <div className="field">
                  <label>spend (SOL)</label>
                  <input value={buyIn} onChange={(e) => setBuyIn(e.target.value)} inputMode="decimal" />
                </div>
                <div className="kv"><span className="k">you get</span>
                  <span className="mono green">{fmtTok(buyOut)} {l.symbol}</span></div>
                <button
                  className="btn buy" style={{ width: '100%', marginTop: 6 }}
                  disabled={!!busy || !publicKey || buyLamports <= 0 || buyLamports > avail}
                  onClick={run('buy', () => buyLive(publicKey!, id, buyLamports))}
                >
                  {busy === 'buy' ? 'buying…' : `Buy ${l.symbol}`}
                </button>
                {buyLamports > avail && <p className="err">exceeds available escrow ({fmtSol(avail)}◎)</p>}
              </div>

              <div className="panel" style={{ marginTop: 12 }}>
                <h3>sell <span className="faint">gasless · zero fee</span></h3>
                <div className="field">
                  <label>
                    amount ({l.symbol}) ·{' '}
                    <a className="magic" style={{ cursor: 'pointer' }}
                      onClick={() => setSellIn((Number(pos.tokensHeld) / 10 ** TOKEN_DECIMALS).toFixed(6))}>
                      max {fmtTok(pos.tokensHeld)}
                    </a>
                  </label>
                  <input value={sellIn} onChange={(e) => setSellIn(e.target.value)} inputMode="decimal" />
                </div>
                <div className="kv"><span className="k">you get</span>
                  <span className="mono red">{fmtSol(Number(sellOut), 4)}◎</span></div>
                <button
                  className="btn sell" style={{ width: '100%', marginTop: 6 }}
                  disabled={!!busy || !publicKey || sellRaw <= 0n || pos.tokensHeld === 0n}
                  onClick={run('sell', () => sellLive(publicKey!, id, sellRaw.toString()))}
                >
                  {busy === 'sell' ? 'selling…' : `Sell ${l.symbol}`}
                </button>
              </div>
            </>
          )}

          {(err || ok) && (
            <div className="panel" style={{ marginTop: 12 }}>
              {ok && <p className="ok" style={{ margin: 0 }}>{ok}</p>}
              {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

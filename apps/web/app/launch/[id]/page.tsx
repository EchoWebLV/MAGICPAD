'use client';

/* The terminal for one market. Left: live curve + activity implied from
 * curve deltas (the whole point of dark bonding is that there is no public
 * trade log to scrape — the curve moving IS the only tell). Right: the
 * wallet's session — one approved deposit, then gasless ER buys/sells. */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { privyEnabled, useActiveWallet } from '../../../lib/use-active-wallet';
import { PublicKey } from '@solana/web3.js';
import CurveChart from '../../../components/CurveChart';
import {
  FIRST_WINDOW_MAX_BUY, GRADUATION_LAMPORTS, LAMPORTS, LaunchView, MIN_DEPOSIT, STATE,
  TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, buyQuote, fetchLaunches, fmtSol, fmtTok, marketCapSol,
  sellQuote, short, solscanAccount, solscanTx,
} from '../../../lib/magicpad';
import { HistRow, fetchHistory } from '../../../lib/history';
import { buildCandles, replayMcap } from '../../../lib/replay';
import { getSolUsd } from '../../../lib/usd';
import {
  PositionView, buyLive, ensureTradeSession, readLaunchLive, readPosition, sellLive,
  topUpSession,
} from '../../../lib/trade-live';
import { walletBalance } from '../../../lib/wallet-tx';

interface Live {
  name: string; symbol: string; state: number; dark: boolean; createdTs: number;
  virtualSol: bigint; virtualTok: bigint; realSolRaised: number; tokensSold: number;
  sessionsOpened: number; mint: string;
}
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
  const wallet = useActiveWallet();
  const { publicKey } = wallet;

  const [live, setLive] = useState<Live | null>(null);
  const [gone, setGone] = useState(false);
  const [pos, setPos] = useState<PositionView | null>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [hist, setHist] = useState<HistRow[] | null>(null);
  const [holders, setHolders] = useState<{ trader: string; pos: PositionView }[] | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [others, setOthers] = useState<LaunchView[] | null>(null);

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
  // rare owner-flip check — public devnet 429s anything chattier. History
  // shares the tick: its ER sweep is cheap and its L1 sweep self-throttles.
  // last good holder rows — a read hiccup must not blank someone's row
  const holdersRef = useRef<Map<string, PositionView>>(new Map());

  const refresh = useCallback(async () => {
    if (!Number.isInteger(id)) return;
    const [r, p, h] = await Promise.all([
      readLaunchLive(id).catch(() => null),
      // undefined = the read FAILED this tick (ER hiccup); null = the chain
      // positively says no session. Only the latter may clear the panel.
      publicKey ? readPosition(publicKey, id).catch(() => undefined) : Promise.resolve(null),
      fetchHistory(id).catch(() => null),
    ]);
    if (r) setLive(toLive(r.l, r.dark));
    else if (r === null && live === null) setGone(true);
    if (p !== undefined) setPos(p);
    if (h) {
      setHist(h);
      // holders = every wallet that ever opened a session, read live from the ER
      const traders = [...new Set(h.filter((e) => e.kind === 'DEPOSIT').map((e) => e.actor))].slice(0, 20);
      const rows = (await Promise.all(traders.map(async (t) => {
        const tp = await readPosition(new PublicKey(t), id)
          .catch(() => holdersRef.current.get(t) ?? null); // hold last known through hiccups
        return tp ? { trader: t, pos: tp } : null;
      }))).filter(Boolean) as { trader: string; pos: PositionView }[];
      rows.sort((x, y) => (y.pos.tokensHeld > x.pos.tokensHeld ? 1 : y.pos.tokensHeld < x.pos.tokensHeld ? -1 : 0));
      holdersRef.current = new Map(rows.map((row) => [row.trader, row.pos]));
      setHolders(rows);
    }
  }, [id, live, publicKey]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let on = true;
    const f = () => { getSolUsd().then((v) => { if (on) setSolUsd(v); }).catch(() => { /* garnish only */ }); };
    f();
    const t = setInterval(f, 60_000);
    return () => { on = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    fetchLaunches().then((ls) => setOthers(ls.filter((x) => x.id !== id))).catch(() => { /* panel hides */ });
  }, [id]);

  const mcNow = live ? Number(live.virtualSol) * TOKEN_TOTAL_SUPPLY / Number(live.virtualTok) / LAMPORTS : 0;
  const rep = useMemo(() => (hist ? replayMcap(hist) : null), [hist]);
  const candles = useMemo(() => {
    if (!rep || !live) return [];
    const m = solUsd ?? 1;
    return buildCandles(rep.pts, mcNow).map((k) => ({
      time: k.time, open: k.open * m, high: k.high * m, low: k.low * m, close: k.close * m,
    }));
  }, [rep, live, solUsd, mcNow]);
  const stats = useMemo(() => {
    const s = { buys: 0, sells: 0, buyVol: 0, sellVol: 0, buyers: 0, sellers: 0, deposited: 0 };
    if (!hist || !rep) return s;
    const b = new Set<string>(); const sl = new Set<string>();
    for (const e of hist) {
      if (e.kind === 'BUY') { s.buys += 1; s.buyVol += e.sol ?? 0; b.add(e.actor); }
      else if (e.kind === 'SELL') { s.sells += 1; s.sellVol += rep.solOfSig[e.sig] ?? 0; sl.add(e.actor); }
      else if (e.kind === 'DEPOSIT' || e.kind === 'TOPUP') s.deposited += e.sol ?? 0;
    }
    s.buyers = b.size; s.sellers = sl.size;
    return s;
  }, [hist, rep]);
  const usd = (lamports: number) => (solUsd ? ` ($${(lamports / LAMPORTS * solUsd).toFixed(2)})` : '');

  if (!Number.isInteger(id)) return <main className="wrap"><p className="empty">bad launch id</p></main>;
  if (gone && !live) return <main className="wrap"><p className="empty">no such market</p></main>;
  if (!live) return <main className="wrap"><p className="empty">loading market…</p></main>;

  const l = live;
  const pct = Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const mc = mcNow;
  const spotPerTok = Number(l.virtualSol) / Number(l.virtualTok) * 10 ** TOKEN_DECIMALS; // lamports per display token
  const now = Math.floor(Date.now() / 1000);
  const inFirstWindow = l.state === 0 && now - l.createdTs < 60;
  const tradable = l.state === 0 && l.dark;

  // escrow available for buys = deposit + proceeds − spent
  const avail = pos ? pos.deposit + pos.solProceeds - pos.solSpent : 0;
  const net = pos ? pos.solProceeds - pos.solSpent : 0;

  const buyLamports = Math.round((Number.parseFloat(buyIn) || 0) * LAMPORTS);
  const buyOut = buyLamports > 0 ? buyQuote(l.virtualSol, l.virtualTok, BigInt(buyLamports)) : 0n;
  // a buy past the free escrow tops the escrow up from the wallet first —
  // the program floor for a top-up is MIN_DEPOSIT
  const shortfall = pos && buyLamports > avail ? Math.max(buyLamports - avail, MIN_DEPOSIT) : 0;
  const walletCovers = bal !== null && bal >= shortfall + 5e6; // margin for fees + note rent
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
              <a
                className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }} title={l.mint}
                href={`https://solscan.io/token/${l.mint}?cluster=devnet`} target="_blank" rel="noreferrer"
              >
                mint {short(l.mint)} ↗
              </a>
            </div>
            <div className="kv" style={{ marginTop: 10 }}>
              <span className="k">market cap</span>
              <span className="mono">
                {mc.toFixed(2)}◎{solUsd ? ` ($${Math.round(mc * solUsd).toLocaleString('en-US')})` : ''}
              </span>
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
              <span className="k">bonding progress</span>
              <span className={`mono${pct >= 60 ? ' green' : ''}`}>{pct.toFixed(1)}%</span>
            </div>
            <div className="kv">
              <span className="k">to graduate</span>
              <span className="mono">
                {l.realSolRaised >= GRADUATION_LAMPORTS
                  ? 'ready'
                  : `${fmtSol(GRADUATION_LAMPORTS - l.realSolRaised)}◎ more${usd(GRADUATION_LAMPORTS - l.realSolRaised)}`}
              </span>
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
            <h3>
              market cap chart{' '}
              <span className="faint">{solUsd ? `(USD, SOL at $${solUsd.toFixed(0)})` : '(SOL)'}</span>
            </h3>
            <CurveChart candles={candles} />
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h3>bonding totals</h3>
            <div className="kv"><span className="k">buys / sells</span>
              <span className="mono"><span className="green">{stats.buys}</span> / <span className="red">{stats.sells}</span></span></div>
            <div className="kv"><span className="k">buy volume</span>
              <span className="mono green">{fmtSol(stats.buyVol)}◎{usd(stats.buyVol)}</span></div>
            <div className="kv"><span className="k">sell volume</span>
              <span className="mono red">{fmtSol(stats.sellVol)}◎{usd(stats.sellVol)}</span></div>
            <div className="kv"><span className="k">buyers / sellers</span>
              <span className="mono">{stats.buyers} / {stats.sellers}</span></div>
            <div className="kv"><span className="k">escrow deposited</span>
              <span className="mono">{fmtSol(stats.deposited)}◎{usd(stats.deposited)}</span></div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h3>history <span className="faint">(deposits on L1, dark trades read from the rollup ledger)</span></h3>
            <div className="feed">
              {(!hist || hist.length === 0) && (
                <div className="empty" style={{ padding: 18 }}>
                  {!hist ? 'reading the ledgers…'
                    : l.tokensSold > 0
                      ? `the curve moved before history reached back: ${fmtTok(l.tokensSold)} ${l.symbol} sold, ${fmtSol(l.realSolRaised)}◎ in`
                      : 'no activity yet'}
                </div>
              )}
              {hist?.map((e) => (
                <div className="t mono" key={e.sig}>
                  <span className={e.kind === 'BUY' ? 'green' : e.kind === 'SELL' ? 'red' : e.kind === 'DEPOSIT' || e.kind === 'TOPUP' ? 'magic' : 'faint'}>
                    {e.kind === 'TOPUP' ? 'TOP-UP' : e.kind}
                  </span>
                  <span>
                    {e.sol !== undefined ? `${fmtSol(e.sol, 4)}◎`
                      : e.tok !== undefined ? `${fmtTok(e.tok)} ${l.symbol}` : ''}
                  </span>
                  <a className="dim" title={e.actor} href={solscanAccount(e.actor)} target="_blank" rel="noreferrer">
                    {short(e.actor)}
                  </a>
                  {e.er ? (
                    <span className="faint" style={{ marginLeft: 'auto' }}
                      title="dark trade: it lives on the rollup ledger, Solscan never sees it">
                      {new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                  ) : (
                    <a className="faint" style={{ marginLeft: 'auto' }} title="view tx on Solscan"
                      href={solscanTx(e.sig)} target="_blank" rel="noreferrer">
                      {new Date(e.at).toLocaleTimeString('en-US', { hour12: false })} ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h3>holders <span className="faint">(live session ledgers)</span></h3>
            <div className="feed">
              {(!holders || holders.length === 0) && (
                <div className="empty" style={{ padding: 12 }}>no open sessions yet</div>
              )}
              {holders?.map((row) => {
                const hn = row.pos.solProceeds - row.pos.solSpent;
                const supPct = Number(row.pos.tokensHeld) / TOKEN_TOTAL_SUPPLY * 100;
                const you = publicKey?.toBase58() === row.trader;
                return (
                  <div className="t mono" key={row.trader}>
                    <a className={you ? 'magic' : ''} title={row.trader}
                      href={solscanAccount(row.trader)} target="_blank" rel="noreferrer">
                      {short(row.trader)}{you ? ' (you)' : ''}
                    </a>
                    <span>{fmtTok(row.pos.tokensHeld)} {l.symbol}</span>
                    <span className="faint">{supPct.toFixed(2)}% supply</span>
                    <span className={hn > 0 ? 'green' : hn < 0 ? 'red' : 'dim'} style={{ marginLeft: 'auto' }}>
                      {hn >= 0 ? '+' : '−'}{fmtSol(Math.abs(hn), 4)}◎
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section>
          {!pos && !publicKey && (
            <div className="panel">
              <h3>trade this market</h3>
              <p className="note" style={{ marginTop: 0 }}>
                {privyEnabled ? 'Log in or connect a wallet' : 'Connect a wallet'} (top right)
                to open a session. One approval escrows your stake; every trade after that is
                gasless — no popups, no fees.
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
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {['0.1', '0.5', '1'].map((v) => (
                    <button key={v} className="btn ghost" style={{ flex: 1, padding: '4px 0', fontSize: 11 }}
                      onClick={() => setBuyIn(v)}>{v}◎</button>
                  ))}
                </div>
                <div className="kv"><span className="k">you get</span>
                  <span className="mono green">{fmtTok(buyOut)} {l.symbol}</span></div>
                <button
                  className="btn buy" style={{ width: '100%', marginTop: 6 }}
                  disabled={!!busy || !publicKey || buyLamports <= 0 || (shortfall > 0 && !walletCovers)}
                  onClick={run('buy', async () => {
                    if (shortfall > 0) {
                      setBusy('top-up');
                      await topUpSession(wallet, id, shortfall);
                      setBusy('buy');
                    }
                    await buyLive(publicKey!, id, buyLamports);
                  })}
                >
                  {busy === 'top-up' ? 'raising escrow…' : busy === 'buy' ? 'buying…' : `Buy ${l.symbol}`}
                </button>
                {shortfall > 0 && walletCovers && (
                  <p className="note">
                    bigger than your free escrow ({fmtSol(avail)}◎) — this buy moves{' '}
                    {fmtSol(shortfall)}◎ from your wallet into the escrow first, then runs
                    gasless as usual.
                  </p>
                )}
                {shortfall > 0 && !walletCovers && (
                  <p className="err">
                    {bal === null ? 'connect a wallet' : `your wallet holds ${fmtSol(bal)}◎`} — this
                    buy needs {fmtSol(shortfall)}◎ on top of your free {fmtSol(avail)}◎ escrow.
                  </p>
                )}
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
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {[25, 50, 100].map((f) => (
                    <button key={f} className="btn ghost" style={{ flex: 1, padding: '4px 0', fontSize: 11 }}
                      onClick={() => setSellIn((Number(pos.tokensHeld) * f / 100 / 10 ** TOKEN_DECIMALS).toFixed(6))}>
                      {f}%
                    </button>
                  ))}
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

          {others && others.length > 0 && (
            <div className="panel" style={{ marginTop: 12 }}>
              <h3>more markets</h3>
              {others.slice(0, 5).map((o) => (
                <Link key={o.id} href={`/launch/${o.id}`} className="kv">
                  <span className="k">{o.name} <span className="mono faint">${o.symbol}</span></span>
                  <span className="mono">{marketCapSol(o).toFixed(1)}◎</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

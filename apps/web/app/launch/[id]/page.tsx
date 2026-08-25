'use client';

/* The terminal for one market. Left: live curve + activity implied from
 * curve deltas (the whole point of dark bonding is that there is no public
 * trade log to scrape — the curve moving IS the only tell). Right: the
 * same one-click buy as the board — first click opens the escrow if it
 * has to, then every fill is a gasless session-key tx painted immediately. */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveWallet } from '../../../lib/use-active-wallet';
import { PublicKey } from '@solana/web3.js';
import CurveChart from '../../../components/CurveChart';
import Glyph from '../../../components/Glyph';
import TokenArt from '../../../components/TokenArt';
import { copyText } from '../../../lib/clip';
import { SHOW_DARK_CHIP } from '../../../lib/flags';
import {
  LaunchMeta, attachMetaTx, clearMeta, pinAssets, resolveMeta, squashImage,
} from '../../../lib/metadata';
import { BUY_PRESETS, DEFAULT_BUY, readBuyPreset, writeBuyPreset } from '../../../lib/buy-size';
import {
  GRADUATION_LAMPORTS, LAMPORTS, LaunchView, MIN_DEPOSIT, STATE,
  TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, buyQuote, fetchLaunches, fmtAge, fmtSol, fmtTok,
  launchIdFromPath, marketCapSol, sellQuote, short, solscanAccount, solscanTx,
} from '../../../lib/magicpad';
import { HistRow, fetchHistory } from '../../../lib/history';
import {
  bumpBuy, bumpSell, mergeHist, PaintPending, posCaughtUp, pushPending, unmatchedLocals,
  escrowDepositAdd,
} from '../../../lib/paint-trade';
import { replayMcap } from '../../../lib/replay';
import { getSolUsd } from '../../../lib/usd';
import {
  PositionView, claimTokens, quickBuy, readLaunchLive, readPosition, sellLive,
} from '../../../lib/trade-live';
import { sendWithWallet, splBalance, walletBalance } from '../../../lib/wallet-tx';
import {
  meteoraQuote, meteoraSpot, meteoraSwapTx, splHolders,
  type SplHolder, type Spot, type SwapQuote,
} from '../../../lib/public-swap';
import { meteoraPoolUrl } from '../../../lib/pool';

interface Live {
  creator: string; name: string; symbol: string; state: number; dark: boolean; createdTs: number;
  virtualSol: bigint; virtualTok: bigint; realSolRaised: number; tokensSold: number;
  sessionsOpened: number; mint: string;
}
const toLive = (l: any, dark: boolean): Live => ({
  creator: l.creator.toBase58(), name: l.name, symbol: l.symbol, state: l.state, dark,
  createdTs: l.createdTs.toNumber(),
  virtualSol: BigInt(l.virtualSol.toString()),
  virtualTok: BigInt(l.virtualTok.toString()),
  realSolRaised: l.realSolRaised.toNumber(),
  tokensSold: l.tokensSold.toNumber(),
  sessionsOpened: l.sessionsOpened.toNumber(),
  mint: l.mint.toBase58(),
});

export default function LaunchPage() {
  const param = useParams<{ id: string }>().id ?? '';
  const router = useRouter();
  const [id, setId] = useState<number | null>(null);
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
  const [poolQuote, setPoolQuote] = useState<SwapQuote | null>(null);
  const [poolErr, setPoolErr] = useState('');
  const [spl, setSpl] = useState<bigint>(0n);
  const [poolSpot, setPoolSpot] = useState<Spot | null>(null);
  const [splHolds, setSplHolds] = useState<SplHolder[] | null>(null);

  const [buyIn, setBuyIn] = useState(String(DEFAULT_BUY));
  const [sellIn, setSellIn] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const pendingRef = useRef<PaintPending | null>(null);
  const posRef = useRef<PositionView | null>(null);

  // undefined = still resolving; null = this market has no face yet
  const [meta, setMeta] = useState<LaunchMeta | null | undefined>(undefined);
  const [attachImage, setAttachImage] = useState<File | null>(null);
  const attachPreview = useMemo(
    () => (attachImage ? URL.createObjectURL(attachImage) : ''), [attachImage],
  );
  const attachRef = useRef<HTMLInputElement>(null);
  const creator = live?.creator ?? null;
  useEffect(() => { setBuyIn(String(readBuyPreset())); }, []);
  posRef.current = pos;
  useEffect(() => {
    let alive = true;
    setId(null);
    setGone(false);
    setLive(null);
    launchIdFromPath(param).then((n) => {
      if (!alive) return;
      if (n === null) setGone(true);
      else setId(n);
    });
    return () => { alive = false; };
  }, [param]);
  useEffect(() => {
    if (!live) return;
    if (param !== live.mint) router.replace(`/launch/${live.mint}`);
  }, [live, param, router]);
  useEffect(() => {
    if (id === null || !creator) return;
    let alive = true;
    resolveMeta(id, creator).then((m) => { if (alive) setMeta(m); });
    return () => { alive = false; };
  }, [id, creator]);

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
    if (id === null) return;
    const [r, p, h] = await Promise.all([
      readLaunchLive(id).catch(() => null),
      // undefined = the read FAILED this tick (ER hiccup); null = the chain
      // positively says no session. Only the latter may clear the panel.
      publicKey ? readPosition(publicKey, id).catch(() => undefined) : Promise.resolve(null),
      fetchHistory(id).catch(() => null),
    ]);
    const hold = pendingRef.current;
    const caught = !hold || posCaughtUp(p, hold.pos);
    // a fill we just painted must not lose to a stale ER read — hold the
    // curve and the position until this trader's session has moved, not
    // until a clock runs out
    if (r && caught) setLive(toLive(r.l, r.dark));
    else if (r === null && live === null) setGone(true);
    if (p !== undefined && caught) setPos(p);
    if (h) {
      const rows = hold ? mergeHist(h, hold.rows) : h;
      setHist(rows);
      if (hold) {
        const extra = unmatchedLocals(h, hold.rows);
        pendingRef.current = caught && extra.length === 0 ? null : { ...hold, rows: extra };
      }
      // holders = every wallet that ever opened a session, read live from the ER
      const traders = [...new Set(h.filter((e) => e.kind === 'DEPOSIT').map((e) => e.actor))].slice(0, 20);
      if (publicKey && hold && !traders.includes(publicKey.toBase58())) {
        traders.unshift(publicKey.toBase58());
      }
      const next = (await Promise.all(traders.map(async (t) => {
        const you = publicKey?.toBase58() === t;
        const tp = you && hold && !caught && posRef.current
          ? posRef.current
          : await readPosition(new PublicKey(t), id)
            .catch(() => holdersRef.current.get(t) ?? null); // hold last known through hiccups
        return tp ? { trader: t, pos: tp } : null;
      }))).filter(Boolean) as { trader: string; pos: PositionView }[];
      next.sort((x, y) => (y.pos.tokensHeld > x.pos.tokensHeld ? 1 : y.pos.tokensHeld < x.pos.tokensHeld ? -1 : 0));
      holdersRef.current = new Map(next.map((row) => [row.trader, row.pos]));
      setHolders(next);
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

  const publicMint = live?.state === 3 ? live.mint : null;
  useEffect(() => {
    if (!publicMint || !publicKey) { setSpl(0n); return; }
    let on = true;
    splBalance(publicKey, new PublicKey(publicMint)).then((n) => { if (on) setSpl(n); }).catch(() => { if (on) setSpl(0n); });
    return () => { on = false; };
  }, [publicMint, publicKey, ok]);

  useEffect(() => {
    if (!publicMint) { setPoolSpot(null); setSplHolds(null); return; }
    let on = true;
    const tick = () => {
      meteoraSpot(publicMint).then((s) => { if (on) setPoolSpot(s); }).catch(() => { /* quote err is separate */ });
      splHolders(publicMint).then((h) => { if (on) setSplHolds(h); }).catch(() => { /* keep last */ });
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { on = false; clearInterval(t); };
  }, [publicMint, ok]);

  useEffect(() => {
    if (!publicMint) { setPoolQuote(null); setPoolErr(''); return; }
    const amount = side === 'buy'
      ? String(Math.round((Number.parseFloat(buyIn) || 0) * LAMPORTS))
      : String(Math.round((Number.parseFloat(sellIn) || 0) * 10 ** TOKEN_DECIMALS));
    if (!/^[1-9]\d*$/.test(amount)) { setPoolQuote(null); setPoolErr(''); return; }
    let on = true;
    const t = setTimeout(() => {
      meteoraQuote(publicMint, side, amount)
        .then((q) => { if (on) { setPoolQuote(q); setPoolErr(''); } })
        .catch((e: any) => { if (on) { setPoolQuote(null); setPoolErr(String(e?.message ?? e)); } });
    }, 180);
    return () => { on = false; clearTimeout(t); };
  }, [publicMint, side, buyIn, sellIn]);

  const mcNow = live ? Number(live.virtualSol) * TOKEN_TOTAL_SUPPLY / Number(live.virtualTok) / LAMPORTS : 0;
  const livePrice = live
    ? Number(live.virtualSol) / Number(live.virtualTok) * 10 ** TOKEN_DECIMALS / LAMPORTS
    : 0;
  const rep = useMemo(() => (hist ? replayMcap(hist) : null), [hist]);
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

  if (gone && !live) return <main className="wrap"><p className="empty">no such market</p></main>;
  if (id === null || !live) return <main className="wrap"><p className="empty">loading market…</p></main>;

  const l = live;
  const onPool = l.state === 3;
  const pct = onPool ? 100 : Math.min(100, (l.realSolRaised / GRADUATION_LAMPORTS) * 100);
  const mc = onPool && poolSpot ? poolSpot.mcSol : mcNow;
  const spotPerTok = onPool && poolSpot
    ? poolSpot.solPerToken * LAMPORTS
    : Number(l.virtualSol) / Number(l.virtualTok) * 10 ** TOKEN_DECIMALS; // lamports per display token
  const tradable = (l.state === 0 && l.dark) || onPool;

  // escrow available for buys = deposit + proceeds − spent
  const avail = pos ? pos.deposit + pos.solProceeds - pos.solSpent : 0;
  const net = pos ? pos.solProceeds - pos.solSpent : 0;

  const buyLamports = Math.round((Number.parseFloat(buyIn) || 0) * LAMPORTS);
  const buyOut = onPool
    ? (side === 'buy' && poolQuote ? BigInt(poolQuote.amountOut) : 0n)
    : (buyLamports > 0 ? buyQuote(l.virtualSol, l.virtualTok, BigInt(buyLamports)) : 0n);
  // a buy past the free escrow tops the escrow up from the wallet first —
  // the program floor for a top-up is MIN_DEPOSIT. matches quickBuy.
  const shortfall = pos && buyLamports > avail ? Math.max(buyLamports - avail, MIN_DEPOSIT) : 0;
  const walletCovers = bal !== null && bal >= shortfall + 5e6; // margin for fees + note rent
  const sellRawWanted = BigInt(Math.round((Number.parseFloat(sellIn) || 0) * 10 ** TOKEN_DECIMALS));
  const sellHeld = onPool ? spl : (pos?.tokensHeld ?? 0n);
  const sellRaw = sellRawWanted > sellHeld ? sellHeld : sellRawWanted;
  const sellOut = onPool
    ? (side === 'sell' && poolQuote ? BigInt(poolQuote.amountOut) : 0n)
    : (sellRaw > 0n ? sellQuote(l.virtualSol, l.virtualTok, sellRaw) : 0n);

  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(''); setOk(''); setBusy(label);
    try { await fn(); setOk(`${label} confirmed`); await refresh(); refreshBal(); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy('');
  };

  const pickBuy = (v: number) => {
    setBuyIn(String(v));
    writeBuyPreset(v);
  };

  const paintYou = (nextPos: PositionView) => {
    if (!publicKey) return;
    const me = publicKey.toBase58();
    setHolders((prev) => {
      const rest = (prev ?? []).filter((row) => row.trader !== me);
      const rows = [{ trader: me, pos: nextPos }, ...rest];
      rows.sort((x, y) => (y.pos.tokensHeld > x.pos.tokensHeld ? 1 : y.pos.tokensHeld < x.pos.tokensHeld ? -1 : 0));
      holdersRef.current = new Map(rows.map((row) => [row.trader, row.pos]));
      return rows;
    });
  };

  const isCreator = publicKey !== null && publicKey.toBase58() === l.creator;
  const doAttach = run('attach', async () => {
    if (!publicKey || !attachImage) return;
    const squashed = await squashImage(attachImage);
    const cid = await pinAssets({
      image: squashed, name: l.name, symbol: l.symbol,
      description: '', twitter: '', telegram: '', website: '',
    });
    await sendWithWallet(wallet, attachMetaTx(id, publicKey, cid));
    setAttachImage(null);
    // the sig listing can lag the confirm by a beat — poll it in briefly
    for (let i = 0; i < 5; i++) {
      clearMeta(id);
      const m = await resolveMeta(id, l.creator);
      if (m) { setMeta(m); return; }
      await new Promise((r) => setTimeout(r, 1200));
    }
    setMeta(null); // landed but not indexed yet; the next visit picks it up
  });

  const chip = l.state === 0
    ? (SHOW_DARK_CHIP
      ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : l.state === 3 ? <span className="chip grad">GRADUATED</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;

  const mcUsd = solUsd ? mc * solUsd : null;
  const mcLabel = mcUsd != null
    ? (mcUsd >= 1000 ? `$${Math.round(mcUsd).toLocaleString('en-US')}` : `$${mcUsd.toFixed(0)}`)
    : `${mc.toFixed(1)}◎`;
  const chg = rep && rep.pts.length >= 2 && rep.pts[0].mcapSol
    ? (rep.pts[rep.pts.length - 1].mcapSol - rep.pts[0].mcapSol) / rep.pts[0].mcapSol
    : 0;
  const volAll = stats.buyVol + stats.sellVol;
  const buyShare = volAll > 0 ? stats.buyVol / volAll : 0.5;
  const heldUi = Number(sellHeld) / 10 ** TOKEN_DECIMALS;
  const buyBlocked = onPool
    ? (!!busy || buyLamports <= 0 || !poolQuote || (bal !== null && bal < buyLamports + 5e6))
    : (!!busy || buyLamports <= 0
      || (shortfall > 0 && !walletCovers)
      || (!pos && bal !== null && bal < Math.max(buyLamports, MIN_DEPOSIT) + 5e6));
  const sellBlocked = onPool
    ? (!!busy || sellRaw <= 0n || spl === 0n || !poolQuote)
    : (!!busy || !pos || sellRaw <= 0n || pos.tokensHeld === 0n || pos.reconciled);

  const copyMint = async () => {
    if (!await copyText(l.mint)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const doBuy = run('buy', async () => {
    if (!publicKey) throw new Error('connect a wallet');
    if (onPool) {
      const tx = await meteoraSwapTx(l.mint, 'buy', String(buyLamports), publicKey.toBase58());
      await sendWithWallet(wallet, tx);
      return;
    }
    const you = publicKey.toBase58();
    const depositAdd = escrowDepositAdd(pos, buyLamports, avail);
    const baselineVs = l.virtualSol;
    await quickBuy(wallet, id, buyLamports, (phase) => {
      setBusy(phase === 'session' ? 'session open' : phase === 'top-up' ? 'top-up' : 'buy');
    });
    const next = bumpBuy(l, pos, buyLamports, buyOut, depositAdd);
    const row: HistRow = {
      sig: `local:${Date.now()}`, at: Date.now(), er: true,
      kind: 'BUY', signer: you, actor: you, sol: buyLamports,
    };
    pendingRef.current = pushPending(pendingRef.current, baselineVs, next.pos, row);
    setLive(next.live);
    setPos(next.pos);
    posRef.current = next.pos;
    setHist((prev) => mergeHist(prev ?? [], [row]));
    paintYou(next.pos);
  });

  const doSell = run('sell', async () => {
    if (!publicKey) throw new Error('connect a wallet');
    if (onPool) {
      if (sellRaw <= 0n) throw new Error('nothing to sell');
      const tx = await meteoraSwapTx(l.mint, 'sell', sellRaw.toString(), publicKey.toBase58());
      await sendWithWallet(wallet, tx);
      return;
    }
    const you = publicKey.toBase58();
    const out = Number(sellOut);
    const baselineVs = l.virtualSol;
    await sellLive(wallet, id, sellRaw.toString());
    const next = bumpSell(l, pos!, sellRaw, out);
    const row: HistRow = {
      sig: `local:${Date.now()}`, at: Date.now(), er: true,
      kind: 'SELL', signer: you, actor: you, tok: Number(sellRaw),
    };
    pendingRef.current = pushPending(pendingRef.current, baselineVs, next.pos, row);
    setLive(next.live);
    setPos(next.pos);
    posRef.current = next.pos;
    setHist((prev) => mergeHist(prev ?? [], [row]));
    paintYou(next.pos);
  });

  return (
    <main className="term">
      <div className="term-grid">
          <header className="term-head">
            <TokenArt id={id} creator={l.creator} symbol={l.symbol} size={56} />
            <div className="term-id">
              <div className="term-name">
                ${l.symbol}
                {chip}
              </div>
              <div className="term-sub">
                <span>{l.name}</span>
                <span>{fmtAge(l.createdTs)} ago</span>
                <span>{l.sessionsOpened} traders</span>
              </div>
            </div>
            <div className="term-mc">
              <span className="k">Market cap</span>
              <b>{mcLabel}</b>
              <em>
                {l.state === 3
                  ? `${mc.toFixed(2)}◎ · graduated`
                  : `${mc.toFixed(2)}◎ · ${pct.toFixed(1)}% to graduate`}
              </em>
            </div>
            <div className="term-links">
              {meta?.twitter && (
                <a href={meta.twitter} target="_blank" rel="noreferrer" aria-label="x"><Glyph n="x" size={12} /></a>
              )}
              {meta?.telegram && (
                <a href={meta.telegram} target="_blank" rel="noreferrer" aria-label="tg"><Glyph n="tg" size={12} /></a>
              )}
              {meta?.website && (
                <a href={meta.website} target="_blank" rel="noreferrer" aria-label="web"><Glyph n="web" size={12} /></a>
              )}
              <button onClick={copyMint} aria-label="copy mint" title={l.mint}>
                <Glyph n="copy" size={12} />
              </button>
              <a href={`https://solscan.io/token/${l.mint}?cluster=devnet`} target="_blank" rel="noreferrer"
                aria-label="mint on solscan" title={l.mint}>
                <Glyph n="out" size={12} />
              </a>
              {onPool && poolSpot?.pool && (
                <a href={meteoraPoolUrl(poolSpot.pool)} target="_blank" rel="noreferrer"
                  aria-label="meteora pool" title={poolSpot.pool} className="faint">
                  pool
                </a>
              )}
            </div>
          </header>
        <section className="term-main">
          {copied && <p className="ok" style={{ margin: '0 0 8px' }}>mint copied</p>}
          <div className="chart-pane">
            <CurveChart
              pts={rep?.pts ?? []}
              liveMcap={mcNow}
              livePrice={livePrice}
              solUsd={solUsd}
            />
            <div className={`bar${pct >= 60 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
          </div>

          <div className="term-under">
            <div className="panel">
              <h3>holders <span className="faint">{onPool ? (splHolds?.length ?? 0) : (holders?.length ?? 0)}</span></h3>
              {onPool ? (
                <>
                  {(!splHolds || splHolds.length === 0) && (
                    <div className="empty" style={{ padding: 12 }}>no token accounts yet</div>
                  )}
                  {splHolds && splHolds.length > 0 && (
                    <table className="holdtbl">
                      <thead>
                        <tr>
                          <th>Holder</th>
                          <th>Amount</th>
                          <th>% supply</th>
                        </tr>
                      </thead>
                      <tbody>
                        {splHolds.map((row) => {
                          const sup = Number(poolSpot?.supply ?? TOKEN_TOTAL_SUPPLY);
                          const you = publicKey?.toBase58() === row.owner;
                          return (
                            <tr key={row.owner}>
                              <td>
                                <a className={`mono${you ? ' you' : ''}`} title={row.owner}
                                  href={solscanAccount(row.owner)} target="_blank" rel="noreferrer">
                                  {short(row.owner)}{you ? ' (you)' : ''}
                                </a>
                              </td>
                              <td className="mono">{fmtTok(row.amount)}</td>
                              <td className="mono faint">{sup > 0 ? (Number(row.amount) / sup * 100).toFixed(2) : '—' }%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <>
              {(!holders || holders.length === 0) && (
                <div className="empty" style={{ padding: 12 }}>no open sessions yet</div>
              )}
              {holders && holders.length > 0 && (
                <table className="holdtbl">
                  <thead>
                    <tr>
                      <th>Holder</th>
                      <th>Position</th>
                      <th>PnL</th>
                      <th>% supply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders.map((row) => {
                      const hn = row.pos.solProceeds - row.pos.solSpent;
                      const supPct = Number(row.pos.tokensHeld) / TOKEN_TOTAL_SUPPLY * 100;
                      const you = publicKey?.toBase58() === row.trader;
                      return (
                        <tr key={row.trader}>
                          <td>
                            <a className={`mono${you ? ' you' : ''}`} title={row.trader}
                              href={solscanAccount(row.trader)} target="_blank" rel="noreferrer">
                              {short(row.trader)}{you ? ' (you)' : ''}
                            </a>
                          </td>
                          <td className="mono">{fmtTok(row.pos.tokensHeld)}</td>
                          <td className={`mono ${hn > 0 ? 'green' : hn < 0 ? 'red' : 'dim'}`}>
                            {hn >= 0 ? '+' : '−'}{fmtSol(Math.abs(hn), 4)}◎
                          </td>
                          <td className="mono faint">{supPct.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
                </>
              )}
            </div>
            <div className="panel">
              <h3>trades</h3>
              <div className="feed">
                {(!hist || hist.length === 0) && (
                  <div className="empty" style={{ padding: 12 }}>
                    {!hist ? 'reading the ledgers…'
                      : l.tokensSold > 0
                        ? `the curve moved before history reached back: ${fmtTok(l.tokensSold)} ${l.symbol} sold`
                        : 'no activity yet'}
                  </div>
                )}
                {hist?.map((e) => (
                  <div className="t mono" key={`${e.sig}:${e.kind}`}>
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
          </div>
        </section>

        <aside className="term-side">
          <div className="trade-card">
            {onPool && (
              <p className="note" style={{ marginTop: 0 }}>
                Live on Meteora — same buy/sell, wallet signs the swap.
              </p>
            )}
            <div className="sides">
              <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>Buy</button>
              <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>Sell</button>
            </div>

            {side === 'buy' ? (
              <>
                <div className="quote-out">
                  <b className="green">{buyLamports > 0 ? fmtTok(buyOut) : '0'}</b>
                  {l.symbol}
                </div>
                {!publicKey ? (
                  <button className="btn fire" onClick={wallet.connect}>
                    Connect wallet to trade
                  </button>
                ) : (
                  <button
                    className="btn fire"
                    disabled={!tradable || pos?.reconciled || buyBlocked}
                    onClick={doBuy}
                  >
                    {busy === 'session open' || busy === 'top-up'
                      ? 'raising escrow…'
                      : busy === 'buy' ? 'buying…'
                        : !tradable ? (onPool && poolErr ? poolErr.slice(0, 40) : 'not tradable')
                          : `Buy ${l.symbol}`}
                  </button>
                )}
                <div className="presets">
                  {BUY_PRESETS.map((v) => (
                    <button
                      key={v}
                      className={`preset mono${Number(buyIn) === v ? ' on' : ''}`}
                      onClick={() => pickBuy(v)}
                    >
                      {v}◎
                    </button>
                  ))}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>spend (SOL){bal !== null ? ` · wallet ${fmtSol(bal)}◎` : ''}</label>
                  <input value={buyIn} onChange={(e) => setBuyIn(e.target.value)} inputMode="decimal" />
                </div>
                {!onPool && !pos && publicKey && tradable && (
                  <p className="note">first click opens the escrow for this size, then fills are gasless.</p>
                )}
                {onPool && poolErr && side === 'buy' && (
                  <p className="err">{poolErr}</p>
                )}
                {shortfall > 0 && walletCovers && (
                  <p className="note">
                    over free escrow ({fmtSol(avail)}◎) — moves {fmtSol(shortfall)}◎ from wallet first.
                  </p>
                )}
                {shortfall > 0 && !walletCovers && (
                  <p className="err">
                    {bal === null ? 'connect a wallet' : `wallet holds ${fmtSol(bal)}◎`} — need {fmtSol(shortfall)}◎ more.
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="quote-out">
                  <b className="red">{sellRaw > 0n ? `${fmtSol(Number(sellOut), 4)}◎` : '0◎'}</b>
                  you get
                </div>
                {!publicKey ? (
                  <button className="btn fire sell" onClick={wallet.connect}>
                    Connect wallet to trade
                  </button>
                ) : (
                  <button className="btn fire sell" disabled={!tradable || sellBlocked} onClick={doSell}>
                    {busy === 'sell' ? 'selling…' : sellHeld === 0n ? `no ${l.symbol}` : `Sell ${l.symbol}`}
                  </button>
                )}
                <div className="pcts">
                  {[25, 50, 100].map((f) => (
                    <button
                      key={f}
                      className="btn ghost"
                      disabled={sellHeld === 0n}
                      onClick={() => setSellIn(((Number(sellHeld) * f / 100) / 10 ** TOKEN_DECIMALS).toFixed(6))}
                    >
                      {f}%
                    </button>
                  ))}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>
                    amount ({l.symbol})
                    {sellHeld > 0n && (
                      <>
                        {' · '}
                        <a className="magic" style={{ cursor: 'pointer' }}
                          onClick={() => setSellIn(heldUi.toFixed(6))}>
                          max {fmtTok(sellHeld)}
                        </a>
                      </>
                    )}
                  </label>
                  <input value={sellIn} onChange={(e) => setSellIn(e.target.value)} inputMode="decimal" />
                </div>
                {onPool && poolErr && side === 'sell' && (
                  <p className="err">{poolErr}</p>
                )}
              </>
            )}

            {(err || ok) && (
              <>
                {ok && <p className="ok">{ok}</p>}
                {err && <p className="err">{err}</p>}
              </>
            )}

            {pos && pos.reconciled && !pos.tokensClaimed && pos.tokensHeld > 0n && (
              <button
                className="btn"
                style={{ width: '100%', marginBottom: 10 }}
                disabled={!!busy}
                onClick={run('claim', async () => {
                  if (!publicKey) throw new Error('connect a wallet');
                  await claimTokens(wallet, id, publicKey);
                })}
              >
                {busy === 'claim' ? 'claiming…' : `Claim ${fmtTok(pos.tokensHeld)} ${l.symbol} into wallet`}
              </button>
            )}
            {onPool && spl > 0n && (
              <div className="sess-strip">
                <span>wallet <b>{fmtTok(spl)}</b> {l.symbol}</span>
              </div>
            )}
            {!onPool && pos && (
              <div className="sess-strip">
                <span>holding <b>{fmtTok(pos.tokensHeld)}</b></span>
                <span>avail <b>{fmtSol(avail)}◎</b></span>
                <span>
                  net{' '}
                  <b className={net > 0 ? 'green' : net < 0 ? 'red' : ''}>
                    {net >= 0 ? '+' : '−'}{fmtSol(Math.abs(net), 4)}◎
                  </b>
                </span>
                {pos.reconciled && <span className="ok" style={{ margin: 0 }}>settled</span>}
              </div>
            )}
          </div>

          <div className="stats-card">
            <h3>stats</h3>
            <div className="volrow">
              <span className={chg >= 0 ? 'green' : 'red'}>
                {chg >= 0 ? '+' : ''}{(chg * 100).toFixed(1)}%
              </span>
              <span className="faint">vol {fmtSol(volAll)}◎{usd(volAll)}</span>
            </div>
            <div className="volrow">
              <span className="green">{stats.buys} buys</span>
              <span className="red">{stats.sells} sells</span>
            </div>
            <div className="volbar">
              <i className="buy" style={{ width: `${Math.max(2, buyShare * 100)}%` }} />
              <i className="sell" style={{ width: `${Math.max(2, (1 - buyShare) * 100)}%` }} />
            </div>
            <div className="volrow">
              <span className="green">{fmtSol(stats.buyVol)}◎</span>
              <span className="red">{fmtSol(stats.sellVol)}◎</span>
            </div>
            <div className="volrow">
              <span>{stats.buyers} buyers</span>
              <span>{stats.sellers} sellers</span>
            </div>
            <div className="athrow">
              <span>MC {mc.toFixed(1)}◎</span>
              <span>{l.state === 3 ? 'graduated' : `grad ${fmtSol(GRADUATION_LAMPORTS, 0)}◎`}</span>
            </div>
            <div className={`bar${pct >= 60 ? ' hot' : ''}`} style={{ marginTop: 6 }}>
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>

          {isCreator && meta === null && (
            <div className="panel gap">
              <h3>give this market a face</h3>
              <div className="imgpick">
                <div className="drop" onClick={() => attachRef.current?.click()} title="pick an image">
                  {attachPreview ? <img src={attachPreview} alt="token" /> : '+'}
                </div>
                <div className="hint">
                  you launched this market before images existed —
                  <br />pin one now and every board shows it
                </div>
                <input
                  ref={attachRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => setAttachImage(e.target.files?.[0] ?? null)}
                />
              </div>
              <button className="btn" disabled={!attachImage || busy !== ''} onClick={doAttach}>
                {busy === 'attach' ? 'attaching…' : 'Attach image'}
              </button>
            </div>
          )}

          {others && others.length > 0 && (
            <div className="panel gap">
              <h3>more markets</h3>
              {others.slice(0, 5).map((o) => (
                <Link key={o.id} href={`/launch/${o.mint}`} className="kv">
                  <span className="k" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <TokenArt id={o.id} creator={o.creator} symbol={o.symbol} size={22} />
                    {o.name} <span className="mono faint">${o.symbol}</span>
                  </span>
                  <span className="mono">{marketCapSol(o).toFixed(1)}◎</span>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

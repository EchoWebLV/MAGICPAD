'use client';

/* Terminal chart. Replay math is exact; this pane is the Axiom-style
 * controls over it — interval, candles/line/area, USD/SOL, mcap/price,
 * SMA, volume, OHLC readout. Drawing tools need a licensed TV library;
 * we do not fake them. */

import {
  AreaSeries, CandlestickSeries, ColorType, HistogramSeries, IChartApi,
  ISeriesApi, LineSeries, UTCTimestamp, createChart,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Candle, PricePoint, buildCandles, sma } from '../lib/replay';

const INTERVALS = [
  { id: '1s', sec: 1 },
  { id: '5s', sec: 5 },
  { id: '15s', sec: 15 },
  { id: '1m', sec: 60 },
  { id: '5m', sec: 300 },
  { id: '15m', sec: 900 },
  { id: '1h', sec: 3600 },
  { id: '4h', sec: 14400 },
] as const;

type IntervalId = typeof INTERVALS[number]['id'];
type Kind = 'candle' | 'line' | 'area';
type Quote = 'usd' | 'sol';
type Axis = 'mcap' | 'price';

interface Prefs {
  interval: IntervalId;
  kind: Kind;
  quote: Quote;
  axis: Axis;
  smaOn: boolean;
  volOn: boolean;
}

const PREF_KEY = 'magicpad_chart';
const DEFAULTS: Prefs = {
  interval: '1m', kind: 'candle', quote: 'usd', axis: 'mcap', smaOn: true, volOn: true,
};

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null');
    if (raw && INTERVALS.some((i) => i.id === raw.interval)) return { ...DEFAULTS, ...raw };
  } catch { /* first visit */ }
  return DEFAULTS;
}

function fmtAxis(v: number, quote: Quote, axis: Axis): string {
  if (!Number.isFinite(v)) return '—';
  if (axis === 'price') {
    const digits = v >= 1 ? 4 : v >= 0.0001 ? 6 : 10;
    const body = v.toFixed(digits);
    return quote === 'usd' ? `$${body}` : `${body}◎`;
  }
  const n = Math.abs(v);
  const body = n >= 1e6 ? `${(v / 1e6).toFixed(2)}M`
    : n >= 1000 ? `${(v / 1000).toFixed(2)}K`
      : v.toFixed(2);
  return quote === 'usd' ? `$${body}` : `${body}◎`;
}

export default function CurveChart({
  pts, liveMcap, livePrice, solUsd, height,
}: {
  pts: PricePoint[];
  liveMcap: number;
  livePrice: number;
  solUsd: number | null;
  height?: number;
}) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [hover, setHover] = useState<Candle | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => { setPrefs(loadPrefs()); }, []);
  useEffect(() => { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }, [prefs]);

  const interval = INTERVALS.find((i) => i.id === prefs.interval) ?? INTERVALS[3];
  const fx = prefs.quote === 'usd' ? (solUsd ?? 1) : 1;
  const candles = useMemo(
    () => buildCandles(
      pts, prefs.axis === 'mcap' ? liveMcap : livePrice, interval.sec,
      prefs.axis === 'mcap' ? (p) => p.mcapSol : (p) => p.priceSol,
    ).map((k) => ({
      ...k,
      open: k.open * fx, high: k.high * fx, low: k.low * fx, close: k.close * fx,
    })),
    [pts, liveMcap, livePrice, interval.sec, prefs.axis, fx],
  );
  const shown = hover ?? candles[candles.length - 1] ?? null;
  const chg = shown && shown.open
    ? (shown.close - shown.open) / shown.open
    : 0;

  const box = useRef<HTMLDivElement>(null);
  const candleRef = useRef(candles);
  candleRef.current = candles;
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma = useRef<ISeriesApi<'Line'> | null>(null);
  const didFit = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6d6d6d',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#2a2a2a' }, horzLines: { color: '#2a2a2a' } },
      rightPriceScale: { borderColor: '#2c2c2c' },
      timeScale: {
        borderColor: '#2c2c2c',
        timeVisible: true,
        secondsVisible: interval.sec < 60,
        barSpacing: interval.sec <= 5 ? 5 : 8,
        rightOffset: 6,
      },
      crosshair: {
        horzLine: { color: '#7a9a18', labelBackgroundColor: '#c8f542' },
        vertLine: { color: '#7a9a18', labelBackgroundColor: '#c8f542' },
      },
      localization: {
        priceFormatter: (v: number) => fmtAxis(v, prefs.quote, prefs.axis),
      },
    });
    const fmt = {
      type: 'custom' as const,
      minMove: prefs.axis === 'price' ? 1e-12 : 0.01,
      formatter: (v: number) => fmtAxis(v, prefs.quote, prefs.axis),
    };
    let p: typeof price.current;
    if (prefs.kind === 'line') {
      p = c.addSeries(LineSeries, { color: '#c8f542', lineWidth: 2, priceFormat: fmt });
    } else if (prefs.kind === 'area') {
      p = c.addSeries(AreaSeries, {
        lineColor: '#c8f542', topColor: 'rgba(200,245,66,0.28)',
        bottomColor: 'rgba(200,245,66,0.02)', priceFormat: fmt,
      });
    } else {
      p = c.addSeries(CandlestickSeries, {
        upColor: '#5fbf85', wickUpColor: '#5fbf85',
        downColor: '#e75f47', wickDownColor: '#e75f47',
        borderVisible: false, priceFormat: fmt,
      });
    }
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    c.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
      borderVisible: false,
    });
    const m = c.addSeries(LineSeries, {
      color: '#7aa2ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    const onMove = (pos: { time?: unknown }) => {
      const t = pos.time;
      if (t == null) { setHover(null); return; }
      const hit = candleRef.current.find((k) => k.time === t);
      setHover(hit ?? null);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c;
    price.current = p;
    vol.current = v;
    ma.current = m;
    didFit.current = false;
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.remove();
      chart.current = null;
      price.current = null;
      vol.current = null;
      ma.current = null;
    };
  }, [prefs.kind, prefs.quote, prefs.axis, interval.sec]);

  useEffect(() => {
    if (!price.current || candles.length === 0) return;
    const timed = candles.map((k) => ({ ...k, time: k.time as UTCTimestamp }));
    if (prefs.kind === 'candle') {
      (price.current as ISeriesApi<'Candlestick'>).setData(timed);
    } else {
      (price.current as ISeriesApi<'Line'>).setData(
        timed.map((k) => ({ time: k.time, value: k.close })),
      );
    }
    if (vol.current) {
      vol.current.setData(prefs.volOn
        ? timed.map((k) => ({
          time: k.time,
          value: k.volume,
          color: k.close >= k.open ? 'rgba(95,191,133,0.45)' : 'rgba(231,95,71,0.45)',
        }))
        : []);
    }
    if (ma.current) {
      ma.current.setData(prefs.smaOn
        ? sma(candles, 20).map((k) => ({ time: k.time as UTCTimestamp, value: k.value }))
        : []);
    }
    if (!didFit.current) {
      chart.current?.timeScale().fitContent();
      didFit.current = true;
    }
  }, [candles, prefs.kind, prefs.volOn, prefs.smaOn]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      chart.current?.timeScale().fitContent();
    });
    return () => cancelAnimationFrame(id);
  }, [full]);

  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));

  return (
    <div className={`chart-body${full ? ' chart-full' : ''}`}>
      <div className="chart-bar">
        <div className="chart-ivals">
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              className={prefs.interval === i.id ? 'on' : ''}
              onClick={() => { didFit.current = false; set({ interval: i.id }); }}
            >
              {i.id}
            </button>
          ))}
        </div>
        <div className="chart-ivals">
          {(['candle', 'line', 'area'] as const).map((k) => (
            <button key={k} className={prefs.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>
              {k}
            </button>
          ))}
        </div>
        <button className="on" onClick={() => set({ quote: prefs.quote === 'usd' ? 'sol' : 'usd' })}>
          {prefs.quote === 'usd' ? 'USD' : 'SOL'}
        </button>
        <button className="on" onClick={() => set({ axis: prefs.axis === 'mcap' ? 'price' : 'mcap' })}>
          {prefs.axis === 'mcap' ? 'MCap' : 'Price'}
        </button>
        <button className={prefs.smaOn ? 'on' : ''} onClick={() => set({ smaOn: !prefs.smaOn })}>SMA20</button>
        <button className={prefs.volOn ? 'on' : ''} onClick={() => set({ volOn: !prefs.volOn })}>Vol</button>
        <button onClick={() => setFull((v) => !v)}>{full ? 'exit' : 'full'}</button>
        <span className="mono" style={{ marginLeft: 'auto' }}>
          {solUsd ? `SOL $${solUsd.toFixed(0)}` : 'SOL'}
        </span>
      </div>
      {shown && (
        <div className="chart-ohlc mono">
          <b>{prefs.interval}</b>
          <span>O {fmtAxis(shown.open, prefs.quote, prefs.axis)}</span>
          <span>H {fmtAxis(shown.high, prefs.quote, prefs.axis)}</span>
          <span>L {fmtAxis(shown.low, prefs.quote, prefs.axis)}</span>
          <span>C {fmtAxis(shown.close, prefs.quote, prefs.axis)}</span>
          <span className={chg >= 0 ? 'green' : 'red'}>
            {chg >= 0 ? '+' : ''}{(chg * 100).toFixed(2)}%
          </span>
          {shown.volume > 0 && <span className="faint">{shown.volume.toFixed(3)}◎ vol</span>}
        </div>
      )}
      <div
        ref={box}
        className="curve"
        style={{ width: '100%', height: height ?? (full ? 'min(80dvh, 820px)' : undefined) }}
      />
    </div>
  );
}

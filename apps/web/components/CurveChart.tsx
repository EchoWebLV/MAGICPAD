'use client';

/* TradingView lightweight-charts wrapper, themed to the terminal. Data
 * arrives as OHLC candles from the curve replay — exact program math,
 * not an indexer's guess. */

import {
  CandlestickSeries, ColorType, IChartApi, ISeriesApi, UTCTimestamp, createChart,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { Candle } from '../lib/replay';

export default function CurveChart({ candles }: { candles: Candle[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const didFit = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b93a3',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#1d212b' }, horzLines: { color: '#1d212b' } },
      rightPriceScale: { borderColor: '#1d212b' },
      timeScale: { borderColor: '#1d212b', timeVisible: true, secondsVisible: false },
      crosshair: {
        horzLine: { labelBackgroundColor: '#5b4fd4' },
        vertLine: { labelBackgroundColor: '#5b4fd4' },
      },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: '#2fd67b', wickUpColor: '#2fd67b',
      downColor: '#ff5c66', wickDownColor: '#ff5c66',
      borderVisible: false,
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(2)),
      },
    });
    chart.current = c;
    series.current = s;
    didFit.current = false;
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, []);

  useEffect(() => {
    if (!series.current || candles.length === 0) return;
    series.current.setData(candles.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
    if (!didFit.current) { chart.current?.timeScale().fitContent(); didFit.current = true; }
  }, [candles]);

  return <div ref={box} style={{ width: '100%', height: 260 }} />;
}

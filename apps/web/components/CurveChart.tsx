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
        textColor: '#5d5b55',
        fontSize: 10,
      },
      grid: { vertLines: { color: '#1a1a19' }, horzLines: { color: '#1a1a19' } },
      rightPriceScale: { borderColor: '#222221' },
      timeScale: {
        borderColor: '#222221', timeVisible: true, secondsVisible: false,
        barSpacing: 9, rightOffset: 6,
      },
      crosshair: {
        horzLine: { color: '#7a5d00', labelBackgroundColor: '#ffc700' },
        vertLine: { color: '#7a5d00', labelBackgroundColor: '#ffc700' },
      },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: '#5fbf85', wickUpColor: '#5fbf85',
      downColor: '#e75f47', wickDownColor: '#e75f47',
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
    // fitContent on a young market stretches two candles across the whole
    // pane — a wall of colour. Below a screenful, keep the fixed bar spacing
    // and just ride the right edge.
    if (!didFit.current && candles.length > 40) {
      chart.current?.timeScale().fitContent();
      didFit.current = true;
    } else if (!didFit.current) {
      chart.current?.timeScale().scrollToRealTime();
    }
  }, [candles]);

  return <div ref={box} style={{ width: '100%', height: 260 }} />;
}

/* Quote assets a launch can graduate against. Pump's list is the official
 * Supported Pair Assets page (pump.fun/docs/custom-pairs, 2026-09-09).
 * Raydium's live set comes from LaunchLab (StonkFun /pairs). Meteora DAMM
 * accepts any SPL quote; we surface SOL/stables plus the same stock tape. */

export type Venue = 'pump' | 'meteora' | 'raydium';

export type QuotePair = {
  mint: string;
  symbol: string;
  name: string;
  category: string;
  logo?: string;
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const SOL: QuotePair = { mint: SOL_MINT, symbol: 'SOL', name: 'Solana', category: 'core' };
const USDC: QuotePair = { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', category: 'core' };
const USDT: QuotePair = { mint: USDT_MINT, symbol: 'USDT', name: 'Tether', category: 'core' };

/** pump.fun Supported Pair Assets — xStocks first, then majors. */
export const PUMP_PAIRS: QuotePair[] = [
  SOL, USDC,
  { mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'APPLX', name: 'Apple', category: 'xstock' },
  { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', symbol: 'NVDAX', name: 'NVIDIA', category: 'xstock' },
  { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', symbol: 'TSLAX', name: 'Tesla', category: 'xstock' },
  { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', symbol: 'SPYX', name: 'SPDR S&P 500', category: 'xstock' },
  { mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', symbol: 'GOOGLX', name: 'Alphabet', category: 'xstock' },
  { mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', symbol: 'AMZNX', name: 'Amazon', category: 'xstock' },
  { mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', symbol: 'MSFTX', name: 'Microsoft', category: 'xstock' },
  { mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', symbol: 'METAX', name: 'Meta', category: 'xstock' },
  { mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', symbol: 'QQQX', name: 'Invesco QQQ', category: 'xstock' },
  { mint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', symbol: 'GLDX', name: 'Gold (GLD)', category: 'xstock' },
  { mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', symbol: 'HOODX', name: 'Robinhood', category: 'xstock' },
  { mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', symbol: 'CRCLX', name: 'Circle', category: 'xstock' },
  { mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', symbol: 'COINX', name: 'Coinbase', category: 'xstock' },
  { mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', symbol: 'MSTRX', name: 'Strategy', category: 'xstock' },
  { mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', symbol: 'PLTRX', name: 'Palantir', category: 'xstock' },
  { mint: 'Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x', symbol: 'BRKX', name: 'Berkshire Hathaway B', category: 'xstock' },
  { mint: 'XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo', symbol: 'AVGOX', name: 'Broadcom', category: 'xstock' },
  { mint: 'XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2', symbol: 'MCDX', name: "McDonald's", category: 'xstock' },
  { mint: 'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ', symbol: 'KOX', name: 'Coca-Cola', category: 'xstock' },
  { mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', symbol: 'GMEX', name: 'GameStop', category: 'xstock' },
  { mint: 'XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM', symbol: 'INTCX', name: 'Intel', category: 'xstock' },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'WBTC', name: 'Wrapped BTC', category: 'crypto' },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH', name: 'Ether', category: 'crypto' },
  { mint: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW', symbol: 'PAXG', name: 'PAX Gold', category: 'commodity' },
];

export const METEORA_CORE: QuotePair[] = [SOL, USDC, USDT];
export const RAYDIUM_CORE: QuotePair[] = [
  SOL, USDC, USDT,
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', name: 'Raydium', category: 'core' },
];

const byMint = (rows: QuotePair[]) => {
  const m = new Map<string, QuotePair>();
  for (const r of rows) if (!m.has(r.mint)) m.set(r.mint, r);
  return [...m.values()];
};

const STOCK_RE = /xstock|stock|equity|prestock|backpack/i;
const CORE_SYMS = new Set(['SOL', 'USDC', 'USDT', 'RAY']);

export function isStockPair(p: QuotePair) {
  return STOCK_RE.test(p.category) || /X$/.test(p.symbol);
}

export function isCorePair(p: QuotePair) {
  return p.category === 'core' || p.category === 'solana' || p.category === 'currency'
    || CORE_SYMS.has(p.symbol);
}

export function fallbackPairs(venue: Venue): QuotePair[] {
  if (venue === 'pump') return PUMP_PAIRS;
  if (venue === 'meteora') return byMint([...METEORA_CORE, ...PUMP_PAIRS.filter(isStockPair)]);
  return byMint([...RAYDIUM_CORE, ...PUMP_PAIRS.filter(isStockPair)]);
}

type StonkPair = {
  mint?: string; symbol?: string; name?: string; category?: string;
  launchable?: boolean; logoUrl?: string;
};

const GH = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';
const CORE_LOGO: Record<string, string> = {
  [SOL_MINT]: `${GH}/${SOL_MINT}/logo.png`,
  [USDC_MINT]: `${GH}/${USDC_MINT}/logo.png`,
  [USDT_MINT]: `${GH}/${USDT_MINT}/logo.png`,
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': `${GH}/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png`,
};

export function pairLogo(p: QuotePair): string {
  if (p.logo) return p.logo;
  if (CORE_LOGO[p.mint]) return CORE_LOGO[p.mint];
  if (/X$/i.test(p.symbol) && p.symbol.length > 2) {
    return `https://xstocks-metadata.backed.fi/logos/tokens/${p.symbol.slice(0, -1)}x.png`;
  }
  return `https://www.stonkfun.xyz/api/asset/quote-logo/${p.mint}`;
}

export async function fetchRaydiumPairs(): Promise<QuotePair[]> {
  const r = await fetch('https://www.stonkfun.xyz/api/public/v1/pairs?launchable=true', {
    next: { revalidate: 300 },
  });
  if (!r.ok) throw new Error(`pairs ${r.status}`);
  const j = await r.json();
  const raw: StonkPair[] = j?.data?.pairs ?? j?.pairs ?? [];
  const mapped = raw
    .filter((p) => p.launchable !== false && p.mint && p.symbol)
    .map((p) => ({
      mint: p.mint!,
      symbol: p.symbol!,
      name: p.name || p.symbol!,
      category: p.category || 'custom',
      logo: p.logoUrl
        ? (p.logoUrl.startsWith('http') ? p.logoUrl : `https://www.stonkfun.xyz${p.logoUrl}`)
        : undefined,
    }));
  return mapped.length ? byMint([...RAYDIUM_CORE, ...mapped]) : fallbackPairs('raydium');
}

export async function pairsFor(venue: Venue): Promise<QuotePair[]> {
  if (venue === 'raydium') {
    try { return await fetchRaydiumPairs(); } catch { return fallbackPairs('raydium'); }
  }
  return fallbackPairs(venue);
}

export function findPair(pairs: QuotePair[], mint: string) {
  return pairs.find((p) => p.mint === mint) ?? pairs[0] ?? SOL;
}

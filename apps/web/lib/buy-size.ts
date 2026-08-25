/* Shared board + market-page buy sizes. Same chips, same localStorage
 * key — picking 0.1◎ on the board means the market page opens on 0.1◎. */

export const BUY_PRESETS = [0.05, 0.1, 0.5, 1] as const;
export const BUY_PRESET_KEY = 'magicpad_quickbuy';
export const DEFAULT_BUY = 0.1;

export function readBuyPreset(): number {
  try {
    const v = Number(localStorage.getItem(BUY_PRESET_KEY));
    if ((BUY_PRESETS as readonly number[]).includes(v)) return v;
  } catch { /* private mode */ }
  return DEFAULT_BUY;
}

export function writeBuyPreset(v: number) {
  try { localStorage.setItem(BUY_PRESET_KEY, String(v)); } catch { /* private mode */ }
}

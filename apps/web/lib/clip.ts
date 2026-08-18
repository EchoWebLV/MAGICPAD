'use client';

/** Copy text, with the legacy path for contexts that deny the async
 *  clipboard API (embedded webviews, insecure origins, older browsers).
 *  Returns whether the text actually landed, so callers can say so. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { /* denied — the legacy path still rides the click's user gesture */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* stays false */ }
  ta.remove();
  return ok;
}

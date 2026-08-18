/* The page's whole icon set. Line-drawn on a 24 grid at the same hairline
 * weight as the rules, so an icon reads as another stroke rather than a
 * pasted-in logo. The one exception is X's mark, which only reads as X in
 * its own shape. */

const P: Record<string, React.ReactNode> = {
  x: <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.96 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z" fill="currentColor" stroke="none" />,
  tg: <path d="M22 3L2 10.2l6.4 2.4L20.6 5 10.9 14.6l-.3 5.4 3.3-3.9 5.2 3.8z" />,
  web: (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M2.8 12h18.4M12 2.8c2.6 2.6 3.9 5.7 3.9 9.2s-1.3 6.6-3.9 9.2c-2.6-2.6-3.9-5.7-3.9-9.2S9.4 5.4 12 2.8z" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" />
      <path d="M15.5 4.5h-11v11" />
    </>
  ),
  wallet: (
    <>
      <rect x="2.5" y="5" width="19" height="15" />
      <path d="M2.5 9.5h19" />
      <rect x="15" y="13" width="4" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  bolt: <path d="M13.5 2L4 13.6h6.4L10 22l9.5-11.6h-6.4z" fill="currentColor" stroke="none" />,
  out: (
    <>
      <path d="M15 4.5H4.5v15H15" />
      <path d="M12 12h9.5M18 8.5l3.5 3.5L18 15.5" />
    </>
  ),
};

export default function Glyph({ n, size = 13 }: { n: keyof typeof P | string; size?: number }) {
  return (
    <svg
      className="glyph" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="square" strokeLinejoin="miter"
    >
      {P[n]}
    </svg>
  );
}

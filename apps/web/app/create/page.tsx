'use client';

/* Launch form, pump-style buy-and-deploy. Image + metadata pin to IPFS
 * first (through our API route — the Pinata key stays server-side), then
 * ONE wallet approval does everything, atomically:
 *
 *   create_launch (fee from config, 0 = free) → open_trade_session (escrow the first buy)
 *   → buy (L1, while the launch is still program-owned for two more
 *   instructions) → delegate_launch → delegate_trade_session → CID memo.
 *
 * The market goes dark WITH the creator's position already on the curve —
 * nothing tradeable ever exists on L1, and the creator's fill is exact
 * because they are the first buy by construction. Skipping the buy sends
 * the classic three-instruction launch instead. */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BN } from '@coral-xyz/anchor';
import { useActiveWallet } from '../../lib/use-active-wallet';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  CLUSTER, CONFIG, DLP, GRADUATION_LAMPORTS, LAMPORTS, MIN_DEPOSIT, PLATFORM, PUMP_GRADUATION_LAMPORTS,
  PROGRAM_ID, TOKEN_PROGRAM, VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT,
  buyQuote, fetchFees, fmtSol, fmtTok, launchPda, mintPda, program, pumpPda, sessionPda,
} from '../../lib/magicpad';
import { metaMemoIx, pinAssets, squashImage } from '../../lib/metadata';
import { fallbackPairs, findPair, isCorePair, isStockPair, SOL_MINT, type QuotePair, type Venue } from '../../lib/pairings';
import { gateEntry, launchSessionKey } from '../../lib/trade-live';
import { requestAirdrop, sendWithWallet, walletBalance } from '../../lib/wallet-tx';

const VENUES: Venue[] = ['pump', 'meteora', 'raydium'];
const VENUE_LABEL: Record<Venue, string> = { pump: 'Pump', meteora: 'Meteora', raydium: 'Raydium' };

const DEV_BUY_MIN = MIN_DEPOSIT / LAMPORTS;
// the first buy must stay under the venue's line: crossing it freezes the curve in the creation tx and delegate_launch refuses
const DEV_BUY_PRESETS = [0.1, 0.5, 1, 2, 3] as const;

const delegationMetas = (target: PublicKey, suffix: string) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    [`buffer${suffix}`]: buf,
    [`delegationRecord${suffix}`]: rec,
    [`delegationMetadata${suffix}`]: meta,
    ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
  };
};

export default function Create() {
  const router = useRouter();
  const wallet = useActiveWallet();
  const { publicKey } = wallet;
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [devBuy, setDevBuy] = useState('1');
  const fileRef = useRef<HTMLInputElement>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [fee, setFee] = useState(0);
  const [taxBps, setTaxBps] = useState(0);
  const [fairest, setFairest] = useState(false);
  const [fairInfo, setFairInfo] = useState(false);
  const [venue, setVenue] = useState<Venue>('meteora');
  const [dark, setDark] = useState(true);
  const [pairMint, setPairMint] = useState(SOL_MINT);
  const [pairs, setPairs] = useState<QuotePair[]>(() => fallbackPairs('meteora'));
  const [pairOpen, setPairOpen] = useState(false);
  const [pairQ, setPairQ] = useState('');
  const pairBoxRef = useRef<HTMLDivElement>(null);

  const refreshBal = useCallback(() => {
    if (!publicKey) { setBal(null); return; }
    walletBalance(publicKey).then(setBal).catch(() => { /* next call */ });
  }, [publicKey]);
  useEffect(() => { refreshBal(); }, [refreshBal]);
  useEffect(() => {
    fetchFees().then((f) => { setFee(f.launchFeeLamports); setTaxBps(f.launchTaxBps); }).catch(() => {});
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    let on = true;
    setPairs(fallbackPairs(venue));
    fetch(`/api/pairs?venue=${venue}`)
      .then((r) => r.json())
      .then((j) => {
        if (!on || !Array.isArray(j.pairs)) return;
        setPairs(j.pairs);
        if (!j.pairs.some((p: QuotePair) => p.mint === pairMint)) setPairMint(j.pairs[0]?.mint ?? SOL_MINT);
      })
      .catch(() => {});
    return () => { on = false; };
  }, [venue]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pairOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!pairBoxRef.current?.contains(e.target as Node)) {
        setPairOpen(false); setPairQ('');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPairOpen(false); setPairQ(''); }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pairOpen]);

  const pump = venue === 'pump';
  const pair = findPair(pairs, pairMint);
  const corePairs = pairs.filter(isCorePair);
  const stockPairs = pairs.filter(isStockPair);
  const pairQLower = pairQ.trim().toLowerCase();
  const stockHits = (pairQLower
    ? stockPairs.filter((p) =>
      p.symbol.toLowerCase().includes(pairQLower)
      || p.name.toLowerCase().includes(pairQLower))
    : stockPairs)
    .filter((p, i, all) => all.findIndex((x) => x.mint === p.mint) === i);
  const stockSelected = isStockPair(pair);

  const dv = devBuy.trim() === '' ? 0 : Number(devBuy);
  const devBuyMax = ((pump ? PUMP_GRADUATION_LAMPORTS : GRADUATION_LAMPORTS) - 1) / LAMPORTS;
  const overCurve = Number.isFinite(dv) && dv > 0 && dv > devBuyMax;
  const devOk = dv === 0 || (Number.isFinite(dv) && dv >= DEV_BUY_MIN && dv <= devBuyMax);
  const noFirstBuy = fairest;
  const devLamports = !noFirstBuy && devOk && dv > 0 ? Math.round(dv * 1e9) : 0;
  // the creator is the first buy by construction — this quote IS the fill
  const alloc = devLamports > 0
    ? buyQuote(VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT, BigInt(devLamports)) : 0n;
  const allocPct = Number(alloc) / 1e13; // of 1e15 raw total supply, in %

  const canAfford = bal !== null && bal >= fee + devLamports + 0.02 * 1e9;
  const valid = name.length > 0 && name.length <= 32
    && symbol.length > 0 && symbol.length <= 10 && image !== null && devOk;

  function pickImage(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setErr('that file is not an image'); return; }
    setErr('');
    setImage(f);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
  }

  async function submit() {
    if (!publicKey || !image) return;
    setErr(''); setBusy(true);
    try {
      setMsg('pinning image + metadata to IPFS…');
      const squashed = await squashImage(image);
      const cid = await pinAssets({
        image: squashed, name: name.trim(), symbol: symbol.trim().toUpperCase(),
        description: description.trim(), twitter: twitter.trim(),
        telegram: telegram.trim(), website: website.trim(),
        venue, pairMint: pair.mint, pairSymbol: pair.symbol, dark,
      });
      const platform = await (program.account as any).platform.fetch(PLATFORM);
      const id = platform.launchSeq.toNumber();
      const launch = launchPda(id);
      // v3 (mainnet) takes the fairest flag on-chain; the devnet demo
      // program still speaks the 2-arg shape
      const createArgs: unknown[] = CLUSTER === 'mainnet'
        ? [name.trim(), symbol.trim().toUpperCase(), fairest]
        : [name.trim(), symbol.trim().toUpperCase()];
      const tx = new Transaction().add(
        await (program.methods as any).createLaunch(...createArgs).accountsPartial({
          creator: publicKey, platform: PLATFORM, config: CONFIG, launch, mint: mintPda(id),
          tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
        }).instruction(),
      );
      // the marker must exist before the first trade (enable_pump → PumpTooLate
      // afterwards), so it rides in the creation tx
      if (pump && CLUSTER === 'mainnet') {
        tx.add(await program.methods.enablePump(new BN(id)).accountsPartial({
          creator: publicKey, launch, pump: pumpPda(id), systemProgram: SystemProgram.programId,
        }).instruction());
      }
      const signers: Keypair[] = [];
      let cosign: ((t: Transaction) => Promise<void>) | undefined;
      if (devLamports > 0) {
        // buy-and-deploy: escrow + first buy land BEFORE delegation flips
        // the accounts dark — the ER clones a curve that already moved
        setMsg('deriving your trade key…');
        const sk = await launchSessionKey(wallet, id);
        signers.push(sk);
        const session = sessionPda(id, publicKey);
        const gate = await gateEntry(publicKey);
        cosign = gate.cosign;
        tx.add(
          await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(devLamports)).accountsPartial({
            trader: publicKey, session, launch, systemProgram: SystemProgram.programId,
            gateSigner: gate.gateSigner,
          }).instruction(),
          await program.methods.buy(new BN(devLamports)).accountsPartial({
            sessionSigner: sk.publicKey, session, launch,
            pump: pump && CLUSTER === 'mainnet' ? pumpPda(id) : (null as any),
          }).instruction(),
        );
        if (dark) {
          tx.add(
            await program.methods.delegateLaunch(new BN(id)).accountsPartial({
              payer: publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
            }).instruction(),
            await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
              payer: publicKey, session, ...delegationMetas(session, 'Session'),
            }).instruction(),
          );
        }
      } else if (dark) {
        tx.add(
          await program.methods.delegateLaunch(new BN(id)).accountsPartial({
            payer: publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
          }).instruction(),
        );
      }
      // the CID rides the creation tx — resolvable forever from the PDA's history
      tx.add(metaMemoIx(cid));
      setMsg('waiting for your wallet…');
      await sendWithWallet(wallet, tx, signers, cosign);
      router.push(`/launch/${mintPda(id).toBase58()}`);
    } catch (e: any) {
      setMsg('');
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  }

  async function airdrop() {
    if (!publicKey) return;
    setErr(''); setMsg('requesting devnet airdrop…'); setBusy(true);
    try { await requestAirdrop(publicKey); setMsg('airdrop landed'); refreshBal(); }
    catch (e: any) { setErr(`airdrop failed (devnet faucet limits): ${String(e?.message ?? e)}`); }
    setBusy(false);
  }

  const ticker = symbol.trim().toUpperCase();
  const curvePct = 79.31;
  const seedPct = 20.69;
  const dest = VENUE_LABEL[venue];
  const darkSol = fmtSol(pump ? PUMP_GRADUATION_LAMPORTS : GRADUATION_LAMPORTS);
  const launchCost = fee + devLamports;
  const launchLabel = busy
    ? (msg || 'Launching…')
    : devLamports > 0
      ? `Launch · ${fmtSol(launchCost)}◎`
      : fee === 0 ? 'Launch' : `Launch · ${fmtSol(fee)}◎`;

  return (
    <main className="launch">
      <section className="launch-card">
        <h2>Launch a coin</h2>

        <div className="launch-seg" role="tablist" aria-label="Graduation destination">
          {VENUES.map((v) => (
            <button
              key={v} type="button" role="tab" aria-selected={venue === v}
              className={venue === v ? 'on' : ''}
              onClick={() => setVenue(v)}
            >
              {VENUE_LABEL[v]}
            </button>
          ))}
        </div>

        <div className="launch-top">
          <button
            type="button"
            className={`launch-img${preview ? ' has' : ''}`}
            onClick={() => fileRef.current?.click()}
            title="pick an image"
          >
            {preview ? <img src={preview} alt="" /> : (
              <>
                <span className="launch-img-ico" aria-hidden>+</span>
                <span>Add image</span>
              </>
            )}
          </button>
          <input
            ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => pickImage(e.target.files?.[0])}
          />
          <div className="launch-meta">
            <div className="launch-pair">
              <label className="launch-lab">
                <span>Name</span>
                <em>{name.length}/32</em>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name" maxLength={32} />
              </label>
              <label className="launch-lab">
                <span>Ticker</span>
                <em>{symbol.length}/10</em>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="SYMBOL" maxLength={10} />
              </label>
            </div>
            <label className="launch-lab">
              <span>Description</span>
              <em>{description.length}/500</em>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                placeholder="What the coin is, in a line or two." rows={3} maxLength={500}
              />
            </label>
          </div>
        </div>

        <label className="launch-lab">
          <span>X</span>
          <em>{twitter.length}/120</em>
          <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="x.com/you, or a link to the tweet" maxLength={120} />
        </label>

        <div className="launch-buy">
          <div className="launch-buy-copy">
            <h3>Your first buy</h3>
            <p>
              First fill is in SOL on the Mooner curve. After graduation the pool is priced
              against {pair.symbol}.
            </p>
          </div>
          <div className="launch-buy-row">
            <div className="launch-pills">
              <button type="button" disabled={noFirstBuy} className={dv === 0 ? 'on' : ''} onClick={() => setDevBuy('')}>None</button>
              {DEV_BUY_PRESETS.map((n) => (
                <button
                  key={n} type="button" disabled={noFirstBuy || n > devBuyMax}
                  className={dv === n ? 'on' : ''} onClick={() => setDevBuy(String(n))}
                >{n} SOL</button>
              ))}
            </div>
            <input
              className="launch-amt"
              value={devBuy} onChange={(e) => setDevBuy(e.target.value)}
              placeholder="0" inputMode="decimal" disabled={noFirstBuy}
            />
          </div>
          {devLamports > 0 && (
            <p className="launch-hint">
              Exact fill: <b>{fmtTok(alloc)} {ticker || 'tokens'}</b> ({allocPct.toFixed(2)}% of supply)
            </p>
          )}
          {!devOk && dv !== 0 && !overCurve && (
            <p className="launch-hint">First buy has to be at least {DEV_BUY_MIN}◎.</p>
          )}
          {overCurve && (
            <p className="launch-hint">Keep it under {fmtSol(pump ? PUMP_GRADUATION_LAMPORTS : GRADUATION_LAMPORTS)}◎ or the curve freezes in the same tx.</p>
          )}
        </div>

        <div className="launch-opts">
          <label className="check">
            <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
            <i aria-hidden />
            <span>Dark for first {darkSol}◎</span>
          </label>
          {dark && (
            <p className="launch-hint">
              The first {darkSol}◎ of the curve trades in the rollup. Then it goes public on {dest}
              {pair.symbol !== 'SOL' ? ` / ${pair.symbol}` : ''}.
            </p>
          )}
          {!dark && (
            <p className="launch-hint">
              No rollup. The market stays visible on L1 and graduates to {dest}.
            </p>
          )}

          <div className="checkrow">
            <label className="check">
              <input
                type="checkbox" checked={fairest}
                onChange={(e) => { setFairest(e.target.checked); if (e.target.checked) setDevBuy(''); }}
              />
              <i aria-hidden />
              <span>Fairest launch</span>
            </label>
            <button type="button" className="infoi" aria-label="what is fairest launch" onClick={() => setFairInfo((v) => !v)}>i</button>
          </div>
          {fairest && <p className="launch-hint">Your first buy is off. You enter through the same gate as everyone else.</p>}
          {fairInfo && (
            <div className="fairbox">
              <p><span className="fb-k">every market here</span> already launches dark: entry is
                gated, so bots and bundlers never get in. all trading happens inside the ephemeral
                rollup, where there is nothing on L1 to snipe. the graduation pool opens at a 2%
                fee that fades to 0.25%, so flipping the fresh pool costs real money. LP locked,
                mint revoked, metadata frozen.</p>
              <p><span className="fb-k">fairest adds</span>: you give up the creator first-buy. no
                pre-allocation, no head start. the curve is born untouched, and anyone can verify
                on-chain that you started with zero.</p>
              <p className="fb-soon">it also carries an early-flip tax: 25% at first, fading to
                zero over 30 minutes, and every taxed lamport goes into the graduation pool.
                scalpers fund the liquidity they tried to drain.</p>
            </div>
          )}

          {pump && (
            <p className="launch-hint">
              Pump mode still freezes the dark curve at {fmtSol(PUMP_GRADUATION_LAMPORTS)}◎. Holders are bought onto pump.fun
              against {pair.symbol} — no pool, no claim.
            </p>
          )}
        </div>

        <div className="launch-pairwith" ref={pairBoxRef}>
          <div className="launch-pairwith-head">
            <span>Paired with</span>
            <em>{dest}</em>
          </div>
          <div className="launch-pills">
            {corePairs.map((p) => (
              <button
                key={p.mint} type="button"
                className={!stockSelected && p.mint === pair.mint ? 'on' : ''}
                onClick={() => { setPairMint(p.mint); setPairOpen(false); setPairQ(''); }}
              >
                {p.symbol}
              </button>
            ))}
          </div>
          <label className="launch-lab">
            <span>Stock</span>
            <em>{stockPairs.length} listed</em>
            <div className={`launch-dd${pairOpen ? ' open' : ''}${stockSelected ? ' picked' : ''}`}>
              <input
                className="launch-dd-search"
                value={pairOpen ? pairQ : (stockSelected ? `${pair.symbol} — ${pair.name}` : '')}
                onChange={(e) => { setPairQ(e.target.value); setPairOpen(true); }}
                onFocus={() => { setPairOpen(true); setPairQ(''); }}
                placeholder="Search NVDA, AAPL, TSLA…"
                autoComplete="off"
              />
              <i aria-hidden>{pairOpen ? '▴' : '▾'}</i>
              {pairOpen && (
                <div className="launch-dd-list" role="listbox">
                  {stockHits.length === 0 && <p className="launch-hint">No stock matches “{pairQ}”.</p>}
                  {stockHits.map((p) => (
                    <button
                      key={p.mint} type="button" role="option"
                      className={p.mint === pair.mint ? 'on' : ''}
                      onClick={() => { setPairMint(p.mint); setPairOpen(false); setPairQ(''); }}
                    >
                      <b>{p.symbol}</b>
                      <i>{p.name}</i>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </label>
          <p className="launch-hint">
            Priced and traded against {pair.symbol} on {dest}
            {stockSelected ? ' — tokenized stock quote' : ''}.
          </p>
        </div>

        <div className="launch-links">
          <label className="launch-lab">
            <span>Telegram</span>
            <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/…" maxLength={120} />
          </label>
          <label className="launch-lab">
            <span>Website</span>
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="yoursite.com" maxLength={120} />
          </label>
        </div>
      </section>

      <aside className="launch-sum">
        <h2>Launch summary</h2>
        <div className="launch-kv"><span>Graduates to</span><b>{dest}</b></div>
        <div className="launch-kv"><span>Paired with</span><b>{pair.symbol}</b></div>
        <div className="launch-kv"><span>Dark window</span><b>{dark ? `First ${darkSol}◎` : 'Off'}</b></div>
        <div className="launch-kv"><span>Your share</span><b>{devLamports > 0 ? `${allocPct.toFixed(2)}%` : 'None'}</b></div>
        <div className="launch-kv"><span>First buy</span><b>{devLamports > 0 ? `${fmtSol(devLamports)}◎` : '—'}</b></div>
        <div className="launch-kv"><span>Launch fee</span><b>{fee === 0 ? 'Free' : `${fmtSol(fee)}◎`}</b></div>
        {taxBps > 0 && (
          <div className="launch-kv"><span>Graduation tax</span><b>{(taxBps / 100).toFixed(2)}%</b></div>
        )}
        <div className="launch-kv"><span>Wallet</span>
          <b>{!publicKey ? 'Not connected' : bal === null ? '…' : `${fmtSol(bal)}◎`}</b>
        </div>

        <div className="launch-fees">
          <span>Where the supply goes</span>
          <div className="launch-bar" aria-hidden>
            <i style={{ width: `${curvePct}%` }} />
          </div>
          <ul>
            <li><i className="dot y" /> Curve / holders <em>{curvePct}%</em></li>
            <li><i className="dot dim" /> {pump ? `Bought onto pump.fun / ${pair.symbol}` : `Graduation seed (${pair.symbol})`} <em>{seedPct}%</em></li>
          </ul>
        </div>

        <button className="btn launch-go" disabled={busy || !publicKey || !valid || !canAfford} onClick={submit}>
          {launchLabel}
        </button>
        {publicKey && !canAfford && CLUSTER !== 'mainnet' && (
          <button className="btn ghost launch-go" disabled={busy} onClick={airdrop}>Airdrop 1◎</button>
        )}

        {!publicKey && <p className="launch-hint">Connect your wallet (top right) to launch.</p>}
        {publicKey && valid === false && image === null && name && symbol && (
          <p className="launch-hint">Pick an image. Markets without a face don&apos;t get traded.</p>
        )}
        {publicKey && !canAfford && bal !== null && (
          <p className="launch-hint">
            You need {fmtSol(launchCost)}◎ plus a little dust.
            {CLUSTER === 'mainnet' ? ' Top the wallet up and this unlocks.' : ' Airdrop or top the wallet up.'}
          </p>
        )}
        {msg && <p className="ok">{msg}</p>}
        {err && <p className="err">{err}</p>}
      </aside>
    </main>
  );
}

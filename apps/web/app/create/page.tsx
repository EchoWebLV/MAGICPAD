'use client';

/* Launch form, pump-style buy-and-deploy. Image + metadata pin to IPFS
 * first (through our API route — the Pinata key stays server-side), then
 * ONE wallet approval does everything, atomically:
 *
 *   create_launch (1 SOL fee) → open_trade_session (escrow the first buy)
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
  DLP, PLATFORM, PROGRAM_ID, TOKEN_PROGRAM, VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT,
  buyQuote, fmtSol, fmtTok, launchPda, mintPda, program, sessionPda,
} from '../../lib/magicpad';
import { metaMemoIx, pinAssets, squashImage } from '../../lib/metadata';
import { launchSessionKey } from '../../lib/trade-live';
import { requestAirdrop, sendWithWallet, walletBalance } from '../../lib/wallet-tx';

const FEE = 1_000_000_000;
const DEV_BUY_MAX = 0.5;   // FIRST_WINDOW_MAX_BUY — the anti-snipe cap binds the creator too
const DEV_BUY_MIN = 0.01;  // MIN_DEPOSIT — the escrow floor

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
  const [devBuy, setDevBuy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const refreshBal = useCallback(() => {
    if (!publicKey) { setBal(null); return; }
    walletBalance(publicKey).then(setBal).catch(() => { /* next call */ });
  }, [publicKey]);
  useEffect(() => { refreshBal(); }, [refreshBal]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const dv = devBuy.trim() === '' ? 0 : Number(devBuy);
  const devOk = dv === 0 || (Number.isFinite(dv) && dv >= DEV_BUY_MIN && dv <= DEV_BUY_MAX);
  const devLamports = devOk && dv > 0 ? Math.round(dv * 1e9) : 0;
  // the creator is the first buy by construction — this quote IS the fill
  const alloc = devLamports > 0
    ? buyQuote(VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT, BigInt(devLamports)) : 0n;
  const allocPct = Number(alloc) / 1e13; // of 1e15 raw total supply, in %

  const canAfford = bal !== null && bal >= FEE + devLamports + 0.02 * 1e9;
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
      });
      const platform = await (program.account as any).platform.fetch(PLATFORM);
      const id = platform.launchSeq.toNumber();
      const launch = launchPda(id);
      const tx = new Transaction().add(
        await program.methods.createLaunch(name.trim(), symbol.trim().toUpperCase()).accountsPartial({
          creator: publicKey, platform: PLATFORM, launch, mint: mintPda(id),
          tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
        }).instruction(),
      );
      const signers: Keypair[] = [];
      if (devLamports > 0) {
        // buy-and-deploy: escrow + first buy land BEFORE delegation flips
        // the accounts dark — the ER clones a curve that already moved
        setMsg('deriving your trade key…');
        const sk = await launchSessionKey(wallet, id);
        signers.push(sk);
        const session = sessionPda(id, publicKey);
        tx.add(
          await program.methods.openTradeSession(new BN(id), sk.publicKey, new BN(devLamports)).accountsPartial({
            trader: publicKey, session, launch, systemProgram: SystemProgram.programId,
          }).instruction(),
          await program.methods.buy(new BN(devLamports)).accountsPartial({
            sessionSigner: sk.publicKey, session, launch,
          }).instruction(),
        );
        tx.add(
          await program.methods.delegateLaunch(new BN(id)).accountsPartial({
            payer: publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
          }).instruction(),
          await program.methods.delegateTradeSession(new BN(id)).accountsPartial({
            payer: publicKey, session, ...delegationMetas(session, 'Session'),
          }).instruction(),
        );
      } else {
        tx.add(
          await program.methods.delegateLaunch(new BN(id)).accountsPartial({
            payer: publicKey, platform: PLATFORM, launch, ...delegationMetas(launch, 'Launch'),
          }).instruction(),
        );
      }
      // the CID rides the creation tx — resolvable forever from the PDA's history
      tx.add(metaMemoIx(cid));
      setMsg('waiting for your wallet…');
      await sendWithWallet(wallet, tx, signers);
      router.push(`/launch/${id}`);
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

  return (
    <main className="wrap" style={{ maxWidth: 480, paddingTop: 28 }}>
      <div className="panel">
        <h3>Launch a market</h3>
        <div className="imgpick">
          <div className="drop" onClick={() => fileRef.current?.click()} title="pick an image">
            {preview ? <img src={preview} alt="token" /> : '+'}
          </div>
          <div>
            <div className="hint">token image — square looks best,
              <br />resized to 512px before upload</div>
            <input
              ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
          </div>
        </div>
        <div className="field">
          <label>name (≤ 32 chars)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="MIDNIGHT RUNNER" maxLength={32} />
        </div>
        <div className="field">
          <label>ticker (≤ 10 chars)</label>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MIDNIGHT" maxLength={10} />
        </div>
        <div className="field">
          <label>your first buy (optional, ◎)</label>
          <input
            value={devBuy} onChange={(e) => setDevBuy(e.target.value)}
            placeholder="0.0" inputMode="decimal"
          />
          {devLamports > 0 && (
            <p className="note" style={{ marginTop: 6 }}>
              you are the first buy, so this fill is exact:{' '}
              <span className="mono green">{fmtTok(alloc)} {symbol.trim().toUpperCase() || 'tokens'}</span>
              {' '}({allocPct.toFixed(2)}% of supply) — held in your session, tradeable instantly
            </p>
          )}
          {!devOk && (
            <p className="note" style={{ marginTop: 6 }}>
              between {DEV_BUY_MIN}◎ and {DEV_BUY_MAX}◎ — the first-minute anti-snipe
              cap is 0.5◎ per wallet and it applies to you too
            </p>
          )}
        </div>
        <div className="field">
          <label>description (optional)</label>
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="what is this market about" rows={3} maxLength={600}
          />
        </div>
        <div className="field">
          <label>links (optional)</label>
          <div className="fieldrow">
            <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="x.com/…" maxLength={120} />
            <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/…" maxLength={120} />
          </div>
          <input
            style={{ marginTop: 8 }}
            value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="website" maxLength={120}
          />
        </div>
        <div className="kv"><span className="k">launch fee</span><span className="mono">1.000◎</span></div>
        {devLamports > 0 && (
          <div className="kv"><span className="k">your first buy</span><span className="mono">{fmtSol(devLamports)}◎</span></div>
        )}
        <div className="kv"><span className="k">trading fees</span><span className="mono green">zero</span></div>
        <div className="kv"><span className="k">loss rakeback</span><span className="mono green">10%</span></div>
        <div className="kv"><span className="k">wallet balance</span>
          <span className="mono">{!publicKey ? 'not connected' : bal === null ? '…' : `${fmtSol(bal)}◎`}</span></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn" disabled={busy || !publicKey || !valid || !canAfford} onClick={submit}>
            {devLamports > 0 ? `Launch + buy · ${fmtSol(FEE + devLamports)}◎` : 'Launch dark · 1◎'}
          </button>
          {publicKey && !canAfford && (
            <button className="btn ghost" disabled={busy} onClick={airdrop}>Airdrop 1◎</button>
          )}
        </div>
        {!publicKey && (
          <p className="note">connect your wallet (top right) to launch — this is devnet, any wallet works</p>
        )}
        {publicKey && valid === false && image === null && name && symbol && (
          <p className="note">pick an image — markets without a face don&apos;t get traded</p>
        )}
        {publicKey && !canAfford && bal !== null && (
          <p className="note">
            you need {fmtSol(FEE + devLamports)}◎ + dust — airdrop devnet SOL or top the wallet up
          </p>
        )}
        <p className="note">
          One transaction does all of it: the market is born, your buy lands on the
          curve, and everything goes dark in the Ephemeral Rollup — your position
          exists before anyone can even see the token.
        </p>
        {msg && <p className="ok">{msg}</p>}
        {err && <p className="err">{err}</p>}
      </div>
    </main>
  );
}

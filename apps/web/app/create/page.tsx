'use client';

/* Launch form. One wallet approval does both: create_launch (1 SOL fee,
 * PDA mint born at supply zero) and delegate_launch (the market goes dark
 * in the ER before the first trade exists). */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BN } from '@coral-xyz/anchor';
import { useActiveWallet } from '../../lib/use-active-wallet';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  DLP, PLATFORM, PROGRAM_ID, TOKEN_PROGRAM, fmtSol, launchPda, mintPda, program,
} from '../../lib/magicpad';
import { requestAirdrop, sendWithWallet, walletBalance } from '../../lib/wallet-tx';

const FEE = 1_000_000_000;

const delegationMetas = (target: PublicKey) => {
  const [buf] = PublicKey.findProgramAddressSync([Buffer.from('buffer'), target.toBuffer()], PROGRAM_ID);
  const [rec] = PublicKey.findProgramAddressSync([Buffer.from('delegation'), target.toBuffer()], DLP);
  const [meta] = PublicKey.findProgramAddressSync([Buffer.from('delegation-metadata'), target.toBuffer()], DLP);
  return {
    bufferLaunch: buf, delegationRecordLaunch: rec, delegationMetadataLaunch: meta,
    ownerProgram: PROGRAM_ID, delegationProgram: DLP, systemProgram: SystemProgram.programId,
  };
};

export default function Create() {
  const router = useRouter();
  const wallet = useActiveWallet();
  const { publicKey } = wallet;
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const refreshBal = useCallback(() => {
    if (!publicKey) { setBal(null); return; }
    walletBalance(publicKey).then(setBal).catch(() => { /* next call */ });
  }, [publicKey]);
  useEffect(() => { refreshBal(); }, [refreshBal]);

  const canAfford = bal !== null && bal >= FEE + 0.01 * 1e9;
  const valid = name.length > 0 && name.length <= 32 && symbol.length > 0 && symbol.length <= 10;

  async function submit() {
    if (!publicKey) return;
    setErr(''); setMsg(''); setBusy(true);
    try {
      const platform = await (program.account as any).platform.fetch(PLATFORM);
      const id = platform.launchSeq.toNumber();
      const launch = launchPda(id);
      const tx = new Transaction().add(
        await program.methods.createLaunch(name.trim(), symbol.trim().toUpperCase()).accountsPartial({
          creator: publicKey, platform: PLATFORM, launch, mint: mintPda(id),
          tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId,
        }).instruction(),
        await program.methods.delegateLaunch(new BN(id)).accountsPartial({
          payer: publicKey, platform: PLATFORM, launch, ...delegationMetas(launch),
        }).instruction(),
      );
      setMsg('waiting for your wallet…');
      await sendWithWallet(wallet, tx);
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
        <div className="field">
          <label>name (≤ 32 chars)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="MIDNIGHT RUNNER" maxLength={32} />
        </div>
        <div className="field">
          <label>ticker (≤ 10 chars)</label>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MIDNIGHT" maxLength={10} />
        </div>
        <div className="kv"><span className="k">launch fee</span><span className="mono">1.000◎</span></div>
        <div className="kv"><span className="k">trading fees</span><span className="mono green">zero</span></div>
        <div className="kv"><span className="k">loss rakeback</span><span className="mono green">10%</span></div>
        <div className="kv"><span className="k">wallet balance</span>
          <span className="mono">{!publicKey ? 'not connected' : bal === null ? '…' : `${fmtSol(bal)}◎`}</span></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn" disabled={busy || !publicKey || !valid || !canAfford} onClick={submit}>
            Launch dark · 1◎
          </button>
          {publicKey && !canAfford && (
            <button className="btn ghost" disabled={busy} onClick={airdrop}>Airdrop 1◎</button>
          )}
        </div>
        {!publicKey && (
          <p className="note">connect your wallet (top right) to launch — this is devnet, any wallet works</p>
        )}
        {publicKey && !canAfford && bal !== null && (
          <p className="note">the fee is 1◎ + dust — airdrop devnet SOL or top the wallet up</p>
        )}
        <p className="note">
          The token mint exists from second zero with zero supply. All bonding happens dark
          inside the Ephemeral Rollup — no L1 trail to snipe, no gas to pay.
        </p>
        {msg && <p className="ok">{msg}</p>}
        {err && <p className="err">{err}</p>}
      </div>
    </main>
  );
}

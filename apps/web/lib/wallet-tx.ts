'use client';

/* L1 signing through the connected wallet. Only two moments in the whole
 * product ever pop the wallet: create_launch and the session deposit.
 * Everything after rides the local session key, gasless, no popups. */

import { Connection, Keypair, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { connection } from './magicpad';

export interface WalletLike {
  publicKey: PublicKey | null;
  sendTransaction: (
    tx: Transaction, connection: Connection, options?: { maxRetries?: number },
  ) => Promise<TransactionSignature>;
  /** plain ed25519 message signature — deterministic, so it derives the
   *  SAME trade keys in every browser the wallet logs into */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** Anything money-moving pings this; the nav (and anyone else) listens and
 *  refreshes its numbers immediately instead of waiting out a poll tick. */
export function notifyActivity(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('magicpad:activity'));
}

export async function sendWithWallet(
  wallet: WalletLike, tx: Transaction, extraSigners: Keypair[] = [],
  cosign?: (tx: Transaction) => Promise<void>,
): Promise<string> {
  if (!wallet.publicKey) throw new Error('connect a wallet first');
  // pin the blockhash ourselves so the confirm window is the one the tx
  // actually carries, not whatever the adapter happened to fetch
  const bh = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = bh.blockhash;
  // partial signatures go on AFTER the message is pinned (they sign it);
  // both wallet rails preserve them — Privy serializes and signs on top,
  // adapters partial-sign the same tx object
  if (extraSigners.length) tx.partialSign(...extraSigners);
  // remote co-signatures (the entry gate) ride the same rule: message
  // pinned first, then the signature lands via tx.addSignature
  if (cosign) await cosign(tx);
  const sig = await wallet.sendTransaction(tx, connection, { maxRetries: 3 });
  try {
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
    notifyActivity();
    return sig;
  } catch (e: any) {
    if (!/expired|block height/i.test(String(e?.message ?? e))) throw e;
    // "expired" can lie — ask the chain once more before declaring death
    const st = (await connection.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (st && !st.err && st.confirmationStatus) { notifyActivity(); return sig; }
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    // signed, broadcast, and devnet never saw it — the wallet almost
    // certainly sent it to a different network
    throw new Error(
      'the transaction never reached devnet — your SOL was not spent. '
      + 'If your wallet is on Mainnet, switch it to Devnet '
      + '(Phantom: Settings → Developer settings → Testnet mode → Solana Devnet) and retry.',
    );
  }
}

export async function walletBalance(owner: PublicKey): Promise<number> {
  return connection.getBalance(owner);
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export async function splBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const ata = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
  )[0];
  const acc = await connection.getTokenAccountBalance(ata).catch(() => null);
  return acc ? BigInt(acc.value.amount) : 0n;
}

export async function requestAirdrop(owner: PublicKey, lamports = 1_000_000_000): Promise<string> {
  const sig = await connection.requestAirdrop(owner, lamports);
  const bh = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  return sig;
}

'use client';

/* L1 signing through the connected wallet. Only two moments in the whole
 * product ever pop the wallet: create_launch and the session deposit.
 * Everything after rides the local session key, gasless, no popups. */

import { Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { connection } from './magicpad';

export interface WalletLike {
  publicKey: PublicKey | null;
  sendTransaction: (
    tx: Transaction, connection: Connection, options?: { maxRetries?: number },
  ) => Promise<TransactionSignature>;
}

export async function sendWithWallet(wallet: WalletLike, tx: Transaction): Promise<string> {
  if (!wallet.publicKey) throw new Error('connect a wallet first');
  const sig = await wallet.sendTransaction(tx, connection, { maxRetries: 3 });
  const bh = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  return sig;
}

export async function walletBalance(owner: PublicKey): Promise<number> {
  return connection.getBalance(owner);
}

export async function requestAirdrop(owner: PublicKey, lamports = 1_000_000_000): Promise<string> {
  const sig = await connection.requestAirdrop(owner, lamports);
  const bh = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  return sig;
}

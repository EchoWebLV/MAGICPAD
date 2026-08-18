'use client';

/* The burner: a localStorage keypair that IS the devnet demo wallet. It
 * signs the two L1 moments (create a launch, open a session) and funds
 * them; everything between happens gasless in the ER on a session key. */

import { Keypair, Transaction } from '@solana/web3.js';
import { connection } from './magicpad';

const KEY = 'magicpad_burner';

export function getBurner(): Keypair {
  let secret: number[] | null = null;
  try { secret = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* fresh */ }
  if (!Array.isArray(secret)) {
    const k = Keypair.generate();
    localStorage.setItem(KEY, JSON.stringify([...k.secretKey])); // persist BEFORE funds move
    return k;
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export async function burnerBalance(): Promise<number> {
  return connection.getBalance(getBurner().publicKey);
}

export async function requestAirdrop(lamports = 1_000_000_000): Promise<string> {
  const sig = await connection.requestAirdrop(getBurner().publicKey, lamports);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/** Sign with the burner and broadcast on L1. Extra signers ride along. */
export async function sendWithBurner(tx: Transaction, extra: Keypair[] = []): Promise<string> {
  const burner = getBurner();
  tx.feePayer = burner.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(burner, ...extra);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

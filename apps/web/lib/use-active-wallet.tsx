'use client';

/* One wallet surface for the whole app, fed by two rails:
 *
 *  - Privy embedded wallet (email/social login): the key lives with the
 *    user's Privy account, signing is headless (showWalletUIs false), so
 *    L1 legs — session open, escrow top-up, launch — run popup-free.
 *  - wallet-standard adapters (Phantom & co): the classic path, untouched.
 *
 * Privy wins when the user is logged in and has an embedded wallet.
 * When NEXT_PUBLIC_PRIVY_APP_ID is unset the Privy branch is never
 * mounted and the app behaves exactly as before. The export picks its
 * implementation at module load — the env var is a build-time constant,
 * so hook order is stable by construction. */

import { useMemo } from 'react';
import { Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { usePrivy } from '@privy-io/react-auth';
import {
  useSignTransaction, useWallets as usePrivySolanaWallets,
} from '@privy-io/react-auth/solana';
import type { WalletLike } from './wallet-tx';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';
export const privyEnabled = PRIVY_APP_ID.length > 0;

// the app is devnet-pinned (MagicBlock devnet router + devnet RPC)
const CHAIN = 'solana:devnet' as const;

export interface ActiveWallet extends WalletLike {
  source: 'privy' | 'adapter' | null;
  /** login identity for the nav — email, social handle, or null */
  who: string | null;
  privyReady: boolean;
  privyAuthed: boolean;
  login: (() => void) | null;
  logout: (() => Promise<void>) | null;
}

const dead: Pick<ActiveWallet, 'source' | 'who' | 'login' | 'logout' | 'privyReady' | 'privyAuthed'> = {
  source: null, who: null, login: null, logout: null,
  privyReady: false, privyAuthed: false,
};

function useAdapterOnly(): ActiveWallet {
  const adapter = useWallet();
  return useMemo(() => ({
    ...dead,
    publicKey: adapter.publicKey,
    sendTransaction: adapter.sendTransaction,
    source: adapter.publicKey ? ('adapter' as const) : null,
  }), [adapter.publicKey, adapter.sendTransaction]);
}

function useWithPrivy(): ActiveWallet {
  const adapter = useWallet();
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const { wallets } = usePrivySolanaWallets();

  return useMemo(() => {
    // the embedded wallet is the one carrying Privy's own feature
    // namespace; external wallets surfaced through Privy don't have it
    const embedded = wallets.find(
      (w) => 'privy:' in (w.standardWallet.features as Record<string, unknown>),
    );
    const who = user?.email?.address
      ?? user?.google?.email
      ?? user?.twitter?.username
      ?? user?.discord?.username
      ?? null;

    if (authenticated && embedded) {
      const publicKey = new PublicKey(embedded.address);
      const sendTransaction = async (
        tx: Transaction, conn: Connection, options?: { maxRetries?: number },
      ): Promise<TransactionSignature> => {
        // sendWithWallet pinned feePayer + blockhash already — serialize
        // unsigned wire bytes, let Privy add the one signature, broadcast
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const { signedTransaction } = await signTransaction({
          transaction: new Uint8Array(bytes), wallet: embedded, chain: CHAIN,
        });
        return conn.sendRawTransaction(signedTransaction, {
          maxRetries: options?.maxRetries, skipPreflight: false,
        });
      };
      return {
        publicKey, sendTransaction, source: 'privy' as const, who,
        privyReady: ready, privyAuthed: true, login, logout,
      };
    }
    return {
      ...dead,
      publicKey: adapter.publicKey,
      sendTransaction: adapter.sendTransaction,
      source: adapter.publicKey ? ('adapter' as const) : null,
      privyReady: ready, privyAuthed: authenticated, login, logout,
    };
  }, [adapter.publicKey, adapter.sendTransaction, ready, authenticated, user,
    wallets, signTransaction, login, logout]);
}

export const useActiveWallet: () => ActiveWallet = privyEnabled ? useWithPrivy : useAdapterOnly;

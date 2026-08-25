'use client';

/* One wallet surface for the whole app, fed by two rails:
 *
 *  - Privy (the product door): email/social → embedded Solana wallet,
 *    headless signing. Detected extensions (Phantom & co) land in the
 *    same Privy modal. connect() always opens that modal.
 *  - wallet-adapter: only when NEXT_PUBLIC_PRIVY_APP_ID is unset.
 *
 * Privy wins once the user is authenticated and has a Solana wallet.
 * The export picks its implementation at module load — the env var is
 * a build-time constant, so hook order is stable by construction.
 *
 * Identity discipline: Privy's hooks hand back fresh array/function
 * identities every render. Anything they touch lives in a ref; everything
 * returned here is keyed on primitives (the address string, booleans), so
 * publicKey and the wallet object hold ONE identity per login state.
 * Downstream effects depend on these — churning identities re-fired every
 * wallet effect in the app on every render (balance flicker, RPC spam). */

import { useCallback, useMemo, useRef } from 'react';
import { Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePrivy } from '@privy-io/react-auth';
import {
  useSignMessage, useSignTransaction, useWallets as usePrivySolanaWallets,
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
  /** Open the one connect door — Privy modal, or the adapter modal if Privy is off. */
  connect: () => void;
  logout: (() => Promise<void>) | null;
}

const dead: Pick<ActiveWallet, 'source' | 'who' | 'login' | 'connect' | 'logout' | 'privyReady' | 'privyAuthed'> = {
  source: null, who: null, login: null, connect: () => {}, logout: null,
  privyReady: false, privyAuthed: false,
};

function useAdapterOnly(): ActiveWallet {
  const adapter = useWallet();
  const { setVisible } = useWalletModal();
  const connect = useCallback(() => setVisible(true), [setVisible]);
  return useMemo(() => ({
    ...dead,
    publicKey: adapter.publicKey,
    sendTransaction: adapter.sendTransaction,
    signMessage: adapter.signMessage,
    source: adapter.publicKey ? ('adapter' as const) : null,
    connect,
  }), [adapter.publicKey, adapter.sendTransaction, adapter.signMessage, connect]);
}

function useWithPrivy(): ActiveWallet {
  const adapter = useWallet();
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { wallets } = usePrivySolanaWallets();

  // embedded first (headless); otherwise the first extension Privy attached
  const chosen = wallets.find(
    (w) => 'privy:' in (w.standardWallet.features as Record<string, unknown>),
  ) ?? wallets[0] ?? null;
  const chosenAddress = chosen?.address ?? null;

  const volatile = useRef({ chosen, signTransaction, signMessage, login, logout });
  volatile.current = { chosen, signTransaction, signMessage, login, logout };

  const stableLogin = useCallback(() => { volatile.current.login(); }, []);
  const stableLogout = useCallback(async () => { await volatile.current.logout(); }, []);

  const privyPk = useMemo(
    () => (chosenAddress ? new PublicKey(chosenAddress) : null),
    [chosenAddress],
  );

  const privySend = useCallback(async (
    tx: Transaction, conn: Connection, options?: { maxRetries?: number },
  ): Promise<TransactionSignature> => {
    const { chosen: w, signTransaction: sign } = volatile.current;
    if (!w) throw new Error('Privy wallet not ready');
    // sendWithWallet pinned feePayer + blockhash already — serialize
    // unsigned wire bytes, let Privy add the one signature, broadcast
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const { signedTransaction } = await sign({
      transaction: new Uint8Array(bytes), wallet: w, chain: CHAIN,
    });
    return conn.sendRawTransaction(signedTransaction, {
      maxRetries: options?.maxRetries, skipPreflight: false,
    });
  }, []);

  // deterministic per (message, key) — every browser derives the same
  // trade keys from it, headless because showWalletUIs is off
  const privySignMessage = useCallback(async (message: Uint8Array): Promise<Uint8Array> => {
    const { chosen: w, signMessage: sign } = volatile.current;
    if (!w) throw new Error('Privy wallet not ready');
    const { signature } = await sign({ message, wallet: w });
    return signature;
  }, []);

  const who = user?.email?.address
    ?? user?.google?.email
    ?? user?.twitter?.username
    ?? user?.discord?.username
    ?? null;

  return useMemo(() => {
    if (authenticated && privyPk) {
      return {
        publicKey: privyPk, sendTransaction: privySend, signMessage: privySignMessage,
        source: 'privy' as const, who,
        privyReady: ready, privyAuthed: true, login: stableLogin, connect: stableLogin,
        logout: stableLogout,
      };
    }
    return {
      ...dead,
      publicKey: adapter.publicKey,
      sendTransaction: adapter.sendTransaction,
      signMessage: adapter.signMessage,
      source: adapter.publicKey ? ('adapter' as const) : null,
      privyReady: ready, privyAuthed: authenticated, login: stableLogin,
      connect: stableLogin, logout: stableLogout,
    };
  }, [authenticated, privyPk, privySend, privySignMessage, who, ready, stableLogin, stableLogout,
    adapter.publicKey, adapter.sendTransaction, adapter.signMessage]);
}

export const useActiveWallet: () => ActiveWallet = privyEnabled ? useWithPrivy : useAdapterOnly;

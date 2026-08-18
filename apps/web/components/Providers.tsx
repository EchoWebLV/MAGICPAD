'use client';

/* Wallet rail. No adapter list needed — wallet-standard wallets (Phantom,
 * Solflare, Backpack) register themselves and show up automatically. */

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { RPC_URL } from '../lib/magicpad';
import '@solana/wallet-adapter-react-ui/styles.css';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

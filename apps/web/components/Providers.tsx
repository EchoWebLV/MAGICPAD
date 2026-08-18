'use client';

/* Wallet rail, two providers deep. wallet-standard wallets (Phantom,
 * Solflare, Backpack) register themselves and show up automatically.
 * PrivyProvider mounts only when NEXT_PUBLIC_PRIVY_APP_ID is set — it
 * adds email/social login with an embedded Solana wallet whose signing
 * is headless (showWalletUIs false): deposits and top-ups without a
 * single popup. */

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PrivyProvider } from '@privy-io/react-auth';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { RPC_URL } from '../lib/magicpad';
import { PRIVY_APP_ID, privyEnabled } from '../lib/use-active-wallet';
import '@solana/wallet-adapter-react-ui/styles.css';

// built once — Privy's standard-wallet hooks read the cluster through these
const solanaRpcs = privyEnabled ? {
  'solana:devnet': {
    rpc: createSolanaRpc(RPC_URL),
    rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws')),
    blockExplorerUrl: 'https://explorer.solana.com',
  },
} : undefined;

function Adapters({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  if (!privyEnabled) return <Adapters>{children}</Adapters>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: 'dark', accentColor: '#ffc700' },
        embeddedWallets: {
          solana: { createOnLogin: 'users-without-wallets' },
          showWalletUIs: false,
        },
        solana: { rpcs: solanaRpcs },
      }}
    >
      <Adapters>{children}</Adapters>
    </PrivyProvider>
  );
}

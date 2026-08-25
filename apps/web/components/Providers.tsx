'use client';

/* Wallet rail. Privy is the door when NEXT_PUBLIC_PRIVY_APP_ID is set:
 * email / social get an embedded Solana wallet (headless signing), and
 * detected extensions (Phantom, Solflare, Backpack) show in the same
 * modal. wallet-adapter stays underneath so the app still runs if Privy
 * is unset — injected wallets only, no WalletConnect. */

import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { RPC_URL } from '../lib/magicpad';
import { PRIVY_APP_ID, privyEnabled } from '../lib/use-active-wallet';
import '@solana/wallet-adapter-react-ui/styles.css';

const solanaRpcs = privyEnabled ? {
  'solana:devnet': {
    rpc: createSolanaRpc(RPC_URL),
    rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, 'ws')),
    blockExplorerUrl: 'https://explorer.solana.com',
  },
} : undefined;

const solanaConnectors = privyEnabled
  ? toSolanaWalletConnectors({ shouldAutoConnect: false })
  : undefined;

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
        appearance: {
          theme: 'dark',
          accentColor: '#d4ff4a',
          walletChainType: 'solana-only',
          showWalletLoginFirst: true,
          walletList: [
            'phantom',
            'solflare',
            'backpack',
            'detected_solana_wallets',
          ],
        },
        embeddedWallets: {
          solana: { createOnLogin: 'users-without-wallets' },
          showWalletUIs: false,
        },
        externalWallets: { solana: { connectors: solanaConnectors } },
        solana: { rpcs: solanaRpcs },
      }}
    >
      <Adapters>{children}</Adapters>
    </PrivyProvider>
  );
}

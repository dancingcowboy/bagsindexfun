'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import { AuthBridge } from './auth-bridge'

export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  // Skip Privy if no app ID configured (local dev without Privy)
  if (!appId) {
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#00D62B',
          walletChainType: 'solana-only',
        },
        loginMethods: ['wallet'],
        embeddedWallets: {
          createOnLogin: 'off',
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },
        solanaClusters: [
          { name: 'mainnet-beta', rpcUrl: 'https://api.mainnet-beta.solana.com' },
        ],
        defaultChain: undefined,
      }}
    >
      <AuthBridge />
      {children}
    </PrivyProvider>
  )
}

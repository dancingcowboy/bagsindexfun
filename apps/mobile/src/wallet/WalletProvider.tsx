import React, { createContext, useContext, useState, useCallback } from 'react'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { PublicKey, Transaction, Connection } from '@solana/web3.js'

const RPC_URL = 'https://api.mainnet-beta.solana.com'

interface WalletContextValue {
  publicKey: PublicKey | null
  connected: boolean
  connection: Connection
  connect: () => Promise<PublicKey>
  disconnect: () => void
  signAndSendTransaction: (tx: Transaction) => Promise<string>
}

const connection = new Connection(RPC_URL, 'confirmed')

const WalletContext = createContext<WalletContextValue>({
  publicKey: null,
  connected: false,
  connection,
  connect: async () => {
    throw new Error('Not initialized')
  },
  disconnect: () => {},
  signAndSendTransaction: async () => {
    throw new Error('Not initialized')
  },
})

export function useWallet() {
  return useContext(WalletContext)
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)

  const connect = useCallback(async (): Promise<PublicKey> => {
    const result = await transact(async (wallet) => {
      const auth = await wallet.authorize({
        identity: {
          name: 'BagsIndex',
          uri: 'https://bagsindex.fun',
          icon: 'favicon.ico',
        },
        cluster: 'mainnet-beta',
      })
      return auth
    })
    const pk = new PublicKey(result.accounts[0].address)
    setPublicKey(pk)
    setAuthToken(result.auth_token)
    return pk
  }, [])

  const disconnect = useCallback(() => {
    setPublicKey(null)
    setAuthToken(null)
  }, [])

  const signAndSendTransaction = useCallback(
    async (tx: Transaction): Promise<string> => {
      if (!publicKey) throw new Error('Wallet not connected')

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash()
      tx.recentBlockhash = blockhash
      tx.feePayer = publicKey

      const sig = await transact(async (wallet) => {
        if (authToken) {
          await wallet.reauthorize({ auth_token: authToken })
        }
        const signed = await wallet.signAndSendTransactions({
          transactions: [tx],
        })
        return signed[0]
      })

      // Wait for confirmation
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      )

      return sig
    },
    [publicKey, authToken],
  )

  return (
    <WalletContext.Provider
      value={{
        publicKey,
        connected: !!publicKey,
        connection,
        connect,
        disconnect,
        signAndSendTransaction,
      }}>
      {children}
    </WalletContext.Provider>
  )
}

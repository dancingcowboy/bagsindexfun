import React from 'react'
import { StatusBar } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NavigationContainer } from '@react-navigation/native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './auth/AuthProvider'
import { WalletProvider } from './wallet/WalletProvider'
import { RootNavigator } from './navigation/RootNavigator'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <WalletProvider>
            <NavigationContainer
              theme={{
                dark: true,
                colors: {
                  primary: '#00D62B',
                  background: '#0a0a0a',
                  card: '#141414',
                  text: '#e0e0e0',
                  border: '#2a2a2a',
                  notification: '#00D62B',
                },
                fonts: {
                  regular: { fontFamily: 'System', fontWeight: '400' },
                  medium: { fontFamily: 'System', fontWeight: '500' },
                  bold: { fontFamily: 'System', fontWeight: '700' },
                  heavy: { fontFamily: 'System', fontWeight: '800' },
                },
              }}>
              <RootNavigator />
            </NavigationContainer>
          </WalletProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

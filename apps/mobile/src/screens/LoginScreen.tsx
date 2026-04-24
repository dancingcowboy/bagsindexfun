import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { useAuth } from '../auth/AuthProvider'
import { useWallet } from '../wallet/WalletProvider'
import { colors } from '../theme/colors'

export function LoginScreen() {
  const { login } = useAuth()
  const { connect } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConnect = async () => {
    setLoading(true)
    setError(null)
    try {
      // Step 1: Connect wallet via Mobile Wallet Adapter
      await connect()

      // Step 2: Get Privy token (will be wired when Privy SDK is integrated)
      // For now, the wallet connection is the first step.
      // Full flow: connect wallet → Privy auth → POST /auth/mobile-login → store JWT
      // TODO: integrate @privy-io/expo for token generation
      setError('Wallet connected. Privy integration pending.')
    } catch (err: any) {
      setError(err.message || 'Connection failed')
    }
    setLoading(false)
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Logo */}
        <View style={styles.logoRow}>
          <Text style={styles.logoBags}>bags</Text>
          <Text style={styles.logoIndex}>index</Text>
        </View>

        <View style={styles.divider} />

        <Text style={styles.tagline}>
          The index fund for Bags.{'\n'}Deposit SOL, let the agent work.
        </Text>

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={loading}
          activeOpacity={0.8}>
          {loading ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.buttonText}>Connect Wallet</Text>
          )}
        </TouchableOpacity>

        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  logoRow: {
    flexDirection: 'row',
    marginBottom: 24,
  },
  logoBags: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.green,
    letterSpacing: -1,
  },
  logoIndex: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -1,
  },
  divider: {
    width: 60,
    height: 2,
    backgroundColor: colors.green,
    marginBottom: 24,
    opacity: 0.5,
  },
  tagline: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 48,
  },
  button: {
    backgroundColor: colors.green,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 12,
    minWidth: 220,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: '600',
  },
  error: {
    color: colors.red,
    marginTop: 16,
    fontSize: 14,
    textAlign: 'center',
  },
})

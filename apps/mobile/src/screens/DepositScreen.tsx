import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useCreateDeposit, useConfirmDeposit } from '../api/hooks'
import { useWallet } from '../wallet/WalletProvider'
import { buildDepositTransaction } from '../wallet/deposit-tx'
import { colors } from '../theme/colors'
import type { PortfolioStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<PortfolioStackParamList, 'Deposit'>

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

export function DepositScreen() {
  const nav = useNavigation<Nav>()
  const { publicKey, signAndSendTransaction, connection } = useWallet()
  const createDeposit = useCreateDeposit()
  const confirmDeposit = useConfirmDeposit()

  const [selectedTier, setSelectedTier] = useState<RiskTier>('BALANCED')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)

  const solBalance = 0 // TODO: fetch via connection.getBalance

  const handleDeposit = async () => {
    const amountSol = parseFloat(amount)
    if (!amountSol || amountSol < 0.05) {
      Alert.alert('Invalid amount', 'Minimum deposit is 0.05 SOL')
      return
    }
    if (!publicKey) {
      Alert.alert('Wallet not connected')
      return
    }

    setLoading(true)
    try {
      // 1. Create deposit intent
      const { data } = createDeposit.mutateAsync
        ? await createDeposit.mutateAsync({ amountSol, riskTier: selectedTier })
        : { data: null }
      const depositId = data?.data?.id ?? data?.id
      const subWalletAddress = data?.data?.subWalletAddress ?? data?.subWalletAddress
      if (!depositId || !subWalletAddress) throw new Error('Failed to create deposit')

      // 2. Build and sign transaction
      const tx = buildDepositTransaction(publicKey, subWalletAddress, amountSol)
      const txSignature = await signAndSendTransaction(tx)

      // 3. Confirm on backend
      await confirmDeposit.mutateAsync({ id: depositId, txSignature })

      // 4. Navigate to progress
      nav.replace('Progress', { type: 'deposit', id: depositId })
    } catch (err: any) {
      Alert.alert('Deposit failed', err.message || 'Something went wrong')
    }
    setLoading(false)
  }

  return (
    <View style={styles.container}>
      {/* Tier selector */}
      <Text style={styles.label}>Select Tier</Text>
      <View style={styles.tierRow}>
        {RISK_TIERS.map((tier) => (
          <TouchableOpacity
            key={tier}
            style={[styles.tierBtn, selectedTier === tier && styles.tierBtnActive]}
            onPress={() => setSelectedTier(tier)}
            activeOpacity={0.7}>
            <Text style={[styles.tierBtnText, selectedTier === tier && styles.tierBtnTextActive]}>
              {TIER_LABELS[tier]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Amount input */}
      <Text style={styles.label}>Amount (SOL)</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={colors.textMuted}
          keyboardType="decimal-pad"
          returnKeyType="done"
        />
        <Text style={styles.inputSuffix}>SOL</Text>
      </View>

      {/* Deposit button */}
      <TouchableOpacity
        style={[styles.depositBtn, loading && styles.depositBtnDisabled]}
        onPress={handleDeposit}
        disabled={loading}
        activeOpacity={0.8}>
        {loading ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={styles.depositBtnText}>Deposit</Text>
        )}
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 8,
    marginTop: 20,
  },
  tierRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tierBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tierBtnActive: {
    borderColor: colors.green,
    backgroundColor: colors.greenDim,
  },
  tierBtnText: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '500',
  },
  tierBtnTextActive: {
    color: colors.green,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
  },
  input: {
    flex: 1,
    fontSize: 24,
    color: colors.textPrimary,
    paddingVertical: 16,
    fontWeight: '600',
  },
  inputSuffix: {
    fontSize: 16,
    color: colors.textMuted,
    fontWeight: '500',
  },
  depositBtn: {
    backgroundColor: colors.green,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 32,
  },
  depositBtnDisabled: {
    opacity: 0.6,
  },
  depositBtnText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.bg,
  },
})

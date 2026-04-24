import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native'
import { useNavigation, useRoute } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RouteProp } from '@react-navigation/native'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useCreateWithdrawal } from '../api/hooks'
import { colors } from '../theme/colors'
import type { PortfolioStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<PortfolioStackParamList, 'Withdraw'>
type Route = RouteProp<PortfolioStackParamList, 'Withdraw'>

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

const PCT_OPTIONS = [25, 50, 75, 100]

export function WithdrawScreen() {
  const nav = useNavigation<Nav>()
  const route = useRoute<Route>()
  const createWithdrawal = useCreateWithdrawal()

  const [selectedTier, setSelectedTier] = useState<RiskTier>(
    route.params?.riskTier ?? 'BALANCED',
  )
  const [selectedPct, setSelectedPct] = useState(100)
  const [loading, setLoading] = useState(false)

  const handleWithdraw = async () => {
    Alert.alert(
      'Confirm Withdrawal',
      `Withdraw ${selectedPct}% of ${TIER_LABELS[selectedTier]}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: async () => {
            setLoading(true)
            try {
              const result = await createWithdrawal.mutateAsync({
                riskTier: selectedTier,
                pct: selectedPct,
              })
              const withdrawalId = result?.data?.data?.id ?? result?.data?.id
              if (withdrawalId) {
                nav.replace('Progress', { type: 'withdrawal', id: withdrawalId })
              }
            } catch (err: any) {
              Alert.alert('Withdrawal failed', err.message || 'Something went wrong')
            }
            setLoading(false)
          },
        },
      ],
    )
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

      {/* Percentage selector */}
      <Text style={styles.label}>Amount</Text>
      <View style={styles.pctRow}>
        {PCT_OPTIONS.map((pct) => (
          <TouchableOpacity
            key={pct}
            style={[styles.pctBtn, selectedPct === pct && styles.pctBtnActive]}
            onPress={() => setSelectedPct(pct)}
            activeOpacity={0.7}>
            <Text style={[styles.pctBtnText, selectedPct === pct && styles.pctBtnTextActive]}>
              {pct}%
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Withdraw button */}
      <TouchableOpacity
        style={[styles.withdrawBtn, loading && styles.withdrawBtnDisabled]}
        onPress={handleWithdraw}
        disabled={loading}
        activeOpacity={0.8}>
        {loading ? (
          <ActivityIndicator color={colors.textPrimary} />
        ) : (
          <Text style={styles.withdrawBtnText}>Withdraw</Text>
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
  pctRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pctBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  pctBtnActive: {
    borderColor: colors.red,
    backgroundColor: colors.redDim,
  },
  pctBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textMuted,
  },
  pctBtnTextActive: {
    color: colors.red,
  },
  withdrawBtn: {
    backgroundColor: colors.red,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 32,
  },
  withdrawBtnDisabled: {
    opacity: 0.6,
  },
  withdrawBtnText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
  },
})

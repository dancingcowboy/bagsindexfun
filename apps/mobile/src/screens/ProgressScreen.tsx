import React from 'react'
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native'
import { useNavigation, useRoute } from '@react-navigation/native'
import type { RouteProp } from '@react-navigation/native'
import { useDepositProgress, useWithdrawalProgress } from '../api/hooks'
import { colors } from '../theme/colors'
import type { PortfolioStackParamList } from '../navigation/types'

type Route = RouteProp<PortfolioStackParamList, 'Progress'>

export function ProgressScreen() {
  const nav = useNavigation()
  const route = useRoute<Route>()
  const { type, id } = route.params

  const depositProgress = useDepositProgress(type === 'deposit' ? id : null)
  const withdrawalProgress = useWithdrawalProgress(type === 'withdrawal' ? id : null)

  const progress = type === 'deposit' ? depositProgress : withdrawalProgress
  const data = progress.data?.data
  const status = data?.status ?? 'PENDING'
  const swaps = data?.swaps ?? []

  const isComplete = status === 'COMPLETED' || status === 'CONFIRMED'
  const isFailed = status === 'FAILED'

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {type === 'deposit' ? 'Allocating Deposit' : 'Processing Withdrawal'}
        </Text>
        <View style={[styles.statusBadge, isComplete && styles.statusComplete, isFailed && styles.statusFailed]}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </View>

      {!isComplete && !isFailed && (
        <ActivityIndicator size="large" color={colors.green} style={styles.spinner} />
      )}

      {/* Swap progress list */}
      <View style={styles.swapList}>
        {swaps.map((swap: any, i: number) => (
          <View key={i} style={styles.swapRow}>
            <View style={[styles.swapDot, {
              backgroundColor: swap.status === 'CONFIRMED' ? colors.green
                : swap.status === 'FAILED' ? colors.red
                : colors.textMuted,
            }]} />
            <Text style={styles.swapToken}>
              {swap.tokenSymbol ?? swap.outputMint?.slice(0, 6) ?? '???'}
            </Text>
            <Text style={styles.swapStatus}>{swap.status}</Text>
          </View>
        ))}
      </View>

      {isComplete && (
        <TouchableOpacity
          style={styles.doneBtn}
          onPress={() => nav.goBack()}
          activeOpacity={0.8}>
          <Text style={styles.doneBtnText}>Done</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 20,
  },
  header: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.bgCard,
  },
  statusComplete: {
    backgroundColor: colors.greenDim,
  },
  statusFailed: {
    backgroundColor: colors.redDim,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  spinner: {
    marginVertical: 24,
  },
  swapList: {
    gap: 8,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.bgCard,
    borderRadius: 8,
  },
  swapDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  swapToken: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  swapStatus: {
    fontSize: 12,
    color: colors.textMuted,
  },
  doneBtn: {
    backgroundColor: colors.green,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 32,
  },
  doneBtnText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.bg,
  },
})

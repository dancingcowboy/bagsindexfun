import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useIndexCurrent, useIndexSchedule } from '../api/hooks'
import { colors } from '../theme/colors'
import type { MarketStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<MarketStackParamList, 'Index'>

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

export function IndexScreen() {
  const nav = useNavigation<Nav>()
  const [selectedTier, setSelectedTier] = useState<RiskTier>('DEGEN')
  const { data } = useIndexCurrent(selectedTier)
  const { data: scheduleData } = useIndexSchedule()

  const tokens = data?.data ?? []
  const schedule = scheduleData?.data

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Quick nav buttons */}
      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navBtn} onPress={() => nav.navigate('Chart')} activeOpacity={0.7}>
          <Text style={styles.navBtnText}>Performance</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={() => nav.navigate('Hotlist')} activeOpacity={0.7}>
          <Text style={styles.navBtnText}>Hotlist</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navBtn} onPress={() => nav.navigate('Analysis')} activeOpacity={0.7}>
          <Text style={styles.navBtnText}>AI Picks</Text>
        </TouchableOpacity>
      </View>

      {/* Tier tabs */}
      <View style={styles.tabs}>
        {RISK_TIERS.map((tier) => (
          <TouchableOpacity
            key={tier}
            style={[styles.tab, selectedTier === tier && styles.tabActive]}
            onPress={() => setSelectedTier(tier)}
            activeOpacity={0.7}>
            <Text style={[styles.tabText, selectedTier === tier && styles.tabTextActive]}>
              {TIER_LABELS[tier]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Schedule info */}
      {schedule && (
        <View style={styles.scheduleCard}>
          <Text style={styles.scheduleLabel}>Next rebalance</Text>
          <Text style={styles.scheduleValue}>
            {schedule[selectedTier]?.nextAt
              ? new Date(schedule[selectedTier].nextAt).toLocaleTimeString()
              : '—'}
          </Text>
        </View>
      )}

      {/* Token list */}
      <View style={styles.tokenHeader}>
        <Text style={[styles.tokenHeaderText, { flex: 1 }]}>Token</Text>
        <Text style={[styles.tokenHeaderText, { width: 70, textAlign: 'right' }]}>Weight</Text>
        <Text style={[styles.tokenHeaderText, { width: 70, textAlign: 'right' }]}>Score</Text>
      </View>

      {tokens.map((token: any, i: number) => (
        <View key={token.tokenMint ?? i} style={styles.tokenRow}>
          <View style={styles.tokenInfo}>
            <Text style={styles.tokenRank}>{i + 1}</Text>
            <Text style={styles.tokenSymbol}>{token.tokenSymbol}</Text>
          </View>
          <Text style={styles.tokenWeight}>
            {((token.weight ?? token.compositeScore ?? 0) * 100).toFixed(1)}%
          </Text>
          <Text style={styles.tokenScore}>
            {(token.compositeScore ?? 0).toFixed(3)}
          </Text>
        </View>
      ))}

      {tokens.length === 0 && (
        <Text style={styles.empty}>No index data available</Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabActive: {
    borderColor: colors.green,
    backgroundColor: colors.greenDim,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted,
  },
  tabTextActive: {
    color: colors.green,
  },
  scheduleCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  scheduleLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  scheduleValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  tokenHeader: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tokenHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tokenInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tokenRank: {
    fontSize: 12,
    color: colors.textMuted,
    width: 20,
  },
  tokenSymbol: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  tokenWeight: {
    width: 70,
    textAlign: 'right',
    fontSize: 14,
    color: colors.green,
    fontWeight: '500',
  },
  tokenScore: {
    width: 70,
    textAlign: 'right',
    fontSize: 13,
    color: colors.textSecondary,
  },
  navRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  navBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
  },
  navBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.green,
  },
  empty: {
    textAlign: 'center',
    color: colors.textMuted,
    paddingVertical: 32,
    fontSize: 14,
  },
})

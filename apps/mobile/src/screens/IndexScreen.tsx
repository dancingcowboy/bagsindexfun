import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useHotlist, useIndexCurrent, useIndexSchedule } from '../api/hooks'
import { colors } from '../theme/colors'
import type { MarketStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<MarketStackParamList, 'Index'>

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

interface ScoredToken {
  tokenMint: string
  tokenSymbol: string | null
  tokenName: string | null
  rank: number
  compositeScore: number
  volume24h: number
  holderCount: number | null
  holderGrowthPct: number
  priceUsd: number
  liquidityUsd: number
  marketCapUsd: number
  safetyVerdict: string | null
  isBlacklisted: boolean
}

function compactUsd(n: number): string {
  if (!n || !isFinite(n)) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function compactNum(n: number | null): string {
  if (n == null || !isFinite(n)) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toString()
}

function priceFmt(n: number): string {
  if (!n || !isFinite(n)) return '—'
  if (n >= 1) return `$${n.toFixed(3)}`
  if (n >= 0.001) return `$${n.toFixed(5)}`
  return `$${n.toExponential(2)}`
}

export function IndexScreen() {
  const nav = useNavigation<Nav>()
  const [selectedTier, setSelectedTier] = useState<RiskTier>('DEGEN')
  const { data: hotlistData, isLoading } = useHotlist(selectedTier)
  const { data: indexData } = useIndexCurrent(selectedTier)
  const { data: scheduleData } = useIndexSchedule()

  // Hotlist returns array of { tier, tokens } — pick the entry for our tier.
  const tierEntry = (hotlistData?.data ?? []).find((e: any) => e.tier === selectedTier)
  const tokens: ScoredToken[] = tierEntry?.tokens ?? []

  // Build a weight lookup from /index/current (top 10 with √-weight basket
  // membership). Tokens past rank 10 won't have an entry — those are
  // "watchlist" rows that scored but didn't make the basket.
  const weightByMint = new Map<string, string>()
  for (const t of indexData?.data?.tokens ?? []) {
    if (t.tokenMint && t.weightPct) weightByMint.set(t.tokenMint, t.weightPct)
  }

  const schedule = scheduleData?.data
  const inIndexCount = tokens.filter((t) => t.rank <= 10).length

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Quick nav */}
      <View style={styles.navRow}>
        <TouchableOpacity style={styles.navBtn} onPress={() => nav.navigate('Chart')} activeOpacity={0.7}>
          <Text style={styles.navBtnText}>Performance</Text>
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

      {/* Schedule */}
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

      {/* Section header */}
      {tokens.length > 0 && (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{tokens.length} scored tokens</Text>
          <Text style={styles.sectionSubtitle}>
            top {inIndexCount} are in the index basket
          </Text>
        </View>
      )}

      {/* Token cards */}
      {tokens.map((t) => {
        const inBasket = t.rank <= 10
        const weight = weightByMint.get(t.tokenMint)
        const holderUp = t.holderGrowthPct > 0
        return (
          <View key={t.tokenMint} style={[styles.card, inBasket && styles.cardInBasket]}>
            {/* Top row: rank + symbol + weight */}
            <View style={styles.cardTop}>
              <View style={styles.rankCol}>
                <Text style={[styles.rank, inBasket && styles.rankActive]}>#{t.rank}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.symbol}>{t.tokenSymbol ?? '???'}</Text>
                {t.tokenName && (
                  <Text style={styles.name} numberOfLines={1}>
                    {t.tokenName}
                  </Text>
                )}
              </View>
              {inBasket && weight && (
                <View style={styles.weightBadge}>
                  <Text style={styles.weightText}>{weight}%</Text>
                </View>
              )}
            </View>

            {/* Stats grid */}
            <View style={styles.statsGrid}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Price</Text>
                <Text style={styles.statValue}>{priceFmt(t.priceUsd)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Mkt Cap</Text>
                <Text style={styles.statValue}>{compactUsd(t.marketCapUsd)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Liquidity</Text>
                <Text style={styles.statValue}>{compactUsd(t.liquidityUsd)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>24h Vol</Text>
                <Text style={styles.statValue}>{compactUsd(t.volume24h)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Holders</Text>
                <Text style={styles.statValue}>{compactNum(t.holderCount)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Holder Δ</Text>
                <Text
                  style={[
                    styles.statValue,
                    holderUp && { color: colors.green },
                    t.holderGrowthPct < 0 && { color: colors.red },
                  ]}>
                  {holderUp ? '+' : ''}
                  {t.holderGrowthPct.toFixed(1)}%
                </Text>
              </View>
            </View>

            {/* Footer: score + safety */}
            <View style={styles.cardFooter}>
              <Text style={styles.footerLabel}>
                Score <Text style={styles.footerValue}>{t.compositeScore.toFixed(3)}</Text>
              </Text>
              {t.safetyVerdict && (
                <Text style={[styles.footerLabel, styles.safetyText]}>
                  Safety <Text style={styles.footerValue}>{t.safetyVerdict}</Text>
                </Text>
              )}
            </View>
          </View>
        )
      })}

      {!isLoading && tokens.length === 0 && (
        <Text style={styles.empty}>No scored tokens for this tier yet</Text>
      )}
      {isLoading && tokens.length === 0 && (
        <Text style={styles.empty}>Loading…</Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16 },

  navRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  navBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
  },
  navBtnText: { fontSize: 12, fontWeight: '600', color: colors.green },

  tabs: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabActive: { borderColor: colors.green, backgroundColor: colors.greenDim },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.textMuted },
  tabTextActive: { color: colors.green },

  scheduleCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  scheduleLabel: { fontSize: 14, color: colors.textSecondary },
  scheduleValue: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },

  sectionHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  sectionSubtitle: { color: colors.textMuted, fontSize: 11 },

  card: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardInBasket: { borderColor: colors.greenDim },

  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  rankCol: { width: 38 },
  rank: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  rankActive: { color: colors.green },
  symbol: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  name: { color: colors.textMuted, fontSize: 11, marginTop: 1 },

  weightBadge: {
    backgroundColor: colors.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  weightText: { color: colors.green, fontSize: 12, fontWeight: '800' },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 0,
  },
  stat: { width: '33.33%', paddingVertical: 6 },
  statLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  statValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', marginTop: 2 },

  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footerLabel: { color: colors.textMuted, fontSize: 11 },
  footerValue: { color: colors.textSecondary, fontWeight: '700' },
  safetyText: {},

  empty: { textAlign: 'center', color: colors.textMuted, paddingVertical: 32, fontSize: 14 },
})

import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking } from 'react-native'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useHotlist } from '../api/hooks'
import { colors } from '../theme/colors'

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

export function HotlistScreen() {
  const [selectedTier, setSelectedTier] = useState<RiskTier>('DEGEN')
  const { data } = useHotlist(selectedTier)

  const tokens = data?.data ?? []

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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

      <Text style={styles.sectionTitle}>
        Top scored tokens from latest cycle
      </Text>

      {tokens.map((token: any, i: number) => (
        <TouchableOpacity
          key={token.mint ?? i}
          style={styles.card}
          onPress={() => {
            if (token.mint) {
              Linking.openURL(`https://bags.fm/token/${token.mint}`)
            }
          }}
          activeOpacity={0.8}>
          <View style={styles.cardHeader}>
            <View style={styles.rankBadge}>
              <Text style={styles.rankText}>{i + 1}</Text>
            </View>
            <Text style={styles.symbol}>{token.symbol ?? '???'}</Text>
            <View style={styles.scoreBadge}>
              <Text style={styles.scoreText}>{(token.compositeScore ?? 0).toFixed(3)}</Text>
            </View>
          </View>

          {token.name && (
            <Text style={styles.tokenName} numberOfLines={1}>{token.name}</Text>
          )}

          <View style={styles.statsRow}>
            {token.price != null && (
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Price</Text>
                <Text style={styles.statValue}>
                  {Number(token.price) < 0.01
                    ? `$${Number(token.price).toExponential(2)}`
                    : `$${Number(token.price).toFixed(4)}`}
                </Text>
              </View>
            )}
            {token.marketCap != null && (
              <View style={styles.stat}>
                <Text style={styles.statLabel}>MCap</Text>
                <Text style={styles.statValue}>
                  ${(Number(token.marketCap) / 1e6).toFixed(1)}M
                </Text>
              </View>
            )}
            {token.volume24h != null && (
              <View style={styles.stat}>
                <Text style={styles.statLabel}>24h Vol</Text>
                <Text style={styles.statValue}>
                  ${(Number(token.volume24h) / 1e3).toFixed(0)}K
                </Text>
              </View>
            )}
            {token.holders != null && (
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Holders</Text>
                <Text style={styles.statValue}>
                  {Number(token.holders).toLocaleString()}
                </Text>
              </View>
            )}
          </View>

          {token.tiers && token.tiers.length > 1 && (
            <View style={styles.tierTags}>
              {token.tiers.map((t: string) => (
                <View key={t} style={styles.tierTag}>
                  <Text style={styles.tierTagText}>{TIER_LABELS[t] ?? t}</Text>
                </View>
              ))}
            </View>
          )}
        </TouchableOpacity>
      ))}

      {tokens.length === 0 && (
        <Text style={styles.empty}>No hotlist data available</Text>
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
    paddingBottom: 32,
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
  sectionTitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 12,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rankBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  symbol: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
  scoreBadge: {
    backgroundColor: colors.greenDim,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  scoreText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.green,
  },
  tokenName: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 34,
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 4,
  },
  stat: {
    minWidth: 70,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  tierTags: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 2,
  },
  tierTag: {
    backgroundColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tierTagText: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '500',
  },
  empty: {
    textAlign: 'center',
    color: colors.textMuted,
    paddingVertical: 32,
    fontSize: 14,
  },
})

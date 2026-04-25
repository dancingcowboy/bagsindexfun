import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking } from 'react-native'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useAnalysisLatest } from '../api/hooks'
import { colors } from '../theme/colors'

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

const TIER_COLORS: Record<string, string> = {
  CONSERVATIVE: '#00b8ff',
  BALANCED: '#00D62B',
  DEGEN: '#ff4444',
}

const CONFIDENCE_COLORS: Record<string, string> = {
  HIGH: colors.green,
  MEDIUM: '#ffaa00',
  LOW: colors.red,
}

export function AnalysisScreen() {
  const [selectedTier, setSelectedTier] = useState<RiskTier>('BALANCED')
  const { data } = useAnalysisLatest(selectedTier)

  const cycle = data?.data
  const tierData = cycle?.tiers?.[selectedTier]
  const allocations = Array.isArray(tierData) ? tierData : tierData?.allocations ?? []
  const summary = cycle?.summary ?? cycle?.reasoning
  const completedAt = cycle?.completedAt ?? cycle?.createdAt

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>AI Agent Analysis</Text>
        <Text style={styles.headerSub}>
          Full reasoning from the latest scoring cycle — why each token was picked, confidence levels, and key signals.
        </Text>
      </View>

      {/* Tier tabs */}
      <View style={styles.tabs}>
        {RISK_TIERS.map((tier) => (
          <TouchableOpacity
            key={tier}
            style={[styles.tab, selectedTier === tier && { borderColor: TIER_COLORS[tier], backgroundColor: TIER_COLORS[tier] + '18' }]}
            onPress={() => setSelectedTier(tier)}
            activeOpacity={0.7}>
            <Text style={[styles.tabText, selectedTier === tier && { color: TIER_COLORS[tier] }]}>
              {TIER_LABELS[tier]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Cycle timestamp */}
      {completedAt && (
        <Text style={styles.timestamp}>
          Last analysis: {new Date(completedAt).toLocaleString()}
        </Text>
      )}

      {/* Summary / reasoning */}
      {summary && (
        <View style={styles.reasoningCard}>
          <Text style={styles.reasoningLabel}>Agent Summary</Text>
          <Text style={styles.reasoningText}>{summary}</Text>
        </View>
      )}

      {/* Allocations */}
      {allocations.length > 0 && (
        <Text style={styles.sectionTitle}>Picks — {TIER_LABELS[selectedTier]}</Text>
      )}

      {allocations.map((alloc: any, i: number) => (
        <TouchableOpacity
          key={alloc.tokenMint ?? i}
          style={styles.allocCard}
          onPress={() => {
            if (alloc.tokenMint) {
              Linking.openURL(`https://bags.fm/token/${alloc.tokenMint}`)
            }
          }}
          activeOpacity={0.85}>
          {/* Top row: rank + symbol + weight */}
          <View style={styles.allocHeader}>
            <View style={[styles.rankCircle, { backgroundColor: TIER_COLORS[selectedTier] }]}>
              <Text style={styles.rankNum}>{i + 1}</Text>
            </View>
            <View style={styles.allocInfo}>
              <Text style={styles.allocSymbol}>{alloc.tokenSymbol}</Text>
              {alloc.tokenName && (
                <Text style={styles.allocName} numberOfLines={1}>{alloc.tokenName}</Text>
              )}
            </View>
            <View style={styles.weightBadge}>
              <Text style={styles.weightText}>{(alloc.weightPct ?? 0).toFixed(1)}%</Text>
            </View>
          </View>

          {/* Confidence */}
          {alloc.confidence && (
            <View style={styles.confidenceRow}>
              <Text style={styles.confidenceLabel}>Confidence:</Text>
              <Text style={[styles.confidenceValue, { color: CONFIDENCE_COLORS[alloc.confidence] ?? colors.textMuted }]}>
                {alloc.confidence}
              </Text>
            </View>
          )}

          {/* Reasoning */}
          {alloc.reasoning && (
            <Text style={styles.allocReasoning}>{alloc.reasoning}</Text>
          )}

          {/* Signals */}
          {alloc.signals && alloc.signals.length > 0 && (
            <View style={styles.signalRow}>
              {alloc.signals.map((sig: string, j: number) => (
                <View key={j} style={styles.signalTag}>
                  <Text style={styles.signalText}>{sig}</Text>
                </View>
              ))}
            </View>
          )}
        </TouchableOpacity>
      ))}

      {allocations.length === 0 && !summary && (
        <Text style={styles.empty}>No analysis data available</Text>
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
  header: {
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  headerSub: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted,
  },
  timestamp: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 12,
  },
  reasoningCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: colors.green,
  },
  reasoningLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.green,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  reasoningText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 10,
  },
  allocCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 8,
  },
  allocHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rankCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankNum: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.bg,
  },
  allocInfo: {
    flex: 1,
  },
  allocSymbol: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  allocName: {
    fontSize: 11,
    color: colors.textMuted,
  },
  weightBadge: {
    backgroundColor: colors.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  weightText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.green,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  confidenceLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  confidenceValue: {
    fontSize: 11,
    fontWeight: '600',
  },
  allocReasoning: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  signalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  signalTag: {
    backgroundColor: colors.border,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  signalText: {
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

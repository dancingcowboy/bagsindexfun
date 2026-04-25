import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions } from 'react-native'
import Svg, { Polyline, Line, Text as SvgText } from 'react-native-svg'
import { RISK_TIERS, type RiskTier } from '@bags-index/shared'
import { useAggregateHistory } from '../api/hooks'
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

const RANGE_OPTIONS = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
]

const CHART_WIDTH = Dimensions.get('window').width - 48
const CHART_HEIGHT = 200

export function ChartScreen() {
  const [selectedTier, setSelectedTier] = useState<RiskTier>('BALANCED')
  const [selectedRange, setSelectedRange] = useState(168)
  const { data, isLoading } = useAggregateHistory(selectedTier, selectedRange)

  const points: { t: number; value: number }[] = (data?.data ?? []).map((p: any) => ({
    t: new Date(p.t).getTime(),
    value: Number(p.indexed ?? p.value ?? 100),
  }))

  // Normalize to 100 at start
  const baseValue = points[0]?.value || 100
  const normalized = points.map((p) => ({
    t: p.t,
    value: (p.value / baseValue) * 100,
  }))

  const minVal = normalized.length > 0 ? Math.min(...normalized.map((p) => p.value)) : 90
  const maxVal = normalized.length > 0 ? Math.max(...normalized.map((p) => p.value)) : 110
  const range = maxVal - minVal || 1
  const padding = range * 0.1

  const toX = (i: number) => (i / Math.max(normalized.length - 1, 1)) * CHART_WIDTH
  const toY = (val: number) =>
    CHART_HEIGHT - ((val - (minVal - padding)) / (range + padding * 2)) * CHART_HEIGHT

  const polylinePoints = normalized.map((p, i) => `${toX(i)},${toY(p.value)}`).join(' ')

  const lastValue = normalized[normalized.length - 1]?.value ?? 100
  const change = lastValue - 100
  const changeColor = change >= 0 ? colors.green : colors.red

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Index Performance</Text>
      <Text style={styles.subtitle}>
        {'\u221A'}score-weighted index line — tracks the aggregate performance of the top 10 tokens in each tier
      </Text>

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

      {/* Range selector */}
      <View style={styles.rangeRow}>
        {RANGE_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.hours}
            style={[styles.rangeBtn, selectedRange === opt.hours && styles.rangeBtnActive]}
            onPress={() => setSelectedRange(opt.hours)}
            activeOpacity={0.7}>
            <Text style={[styles.rangeBtnText, selectedRange === opt.hours && styles.rangeBtnTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Performance stat */}
      <View style={styles.perfCard}>
        <View>
          <Text style={styles.perfLabel}>{TIER_LABELS[selectedTier]} Index</Text>
          <Text style={[styles.perfValue, { color: changeColor }]}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}%
          </Text>
        </View>
        <Text style={styles.perfPeriod}>
          {RANGE_OPTIONS.find((o) => o.hours === selectedRange)?.label ?? ''} change
        </Text>
      </View>

      {/* Chart */}
      <View style={styles.chartBox}>
        {normalized.length > 1 ? (
          <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
            {/* 100 baseline */}
            <Line
              x1={0}
              y1={toY(100)}
              x2={CHART_WIDTH}
              y2={toY(100)}
              stroke={colors.border}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            <SvgText
              x={CHART_WIDTH - 4}
              y={toY(100) - 4}
              fill={colors.textMuted}
              fontSize={9}
              textAnchor="end">
              100
            </SvgText>

            {/* Index line */}
            <Polyline
              points={polylinePoints}
              fill="none"
              stroke={TIER_COLORS[selectedTier]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Min/Max labels */}
            <SvgText
              x={4}
              y={toY(maxVal) - 4}
              fill={colors.textMuted}
              fontSize={9}>
              {maxVal.toFixed(1)}
            </SvgText>
            <SvgText
              x={4}
              y={toY(minVal) + 12}
              fill={colors.textMuted}
              fontSize={9}>
              {minVal.toFixed(1)}
            </SvgText>
          </Svg>
        ) : (
          <View style={styles.chartEmpty}>
            <Text style={styles.chartEmptyText}>
              {isLoading ? 'Loading chart data...' : 'No chart data available'}
            </Text>
          </View>
        )}
      </View>

      {/* Explainer */}
      <View style={styles.explainer}>
        <Text style={styles.explainerTitle}>How the index line works</Text>
        <Text style={styles.explainerText}>
          Each data point is a {'\u221A'}score-weighted average of the top 10 token prices in this tier, normalized to 100 at the start of the selected range. The line shows what a diversified basket of the AI's picks would have returned — no survivorship bias, tokens only contribute from the cycle they were first picked.
        </Text>
      </View>
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
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
    marginBottom: 16,
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
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  rangeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rangeBtnActive: {
    borderColor: colors.green,
    backgroundColor: colors.greenDim,
  },
  rangeBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
  },
  rangeBtnTextActive: {
    color: colors.green,
  },
  perfCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  perfLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  perfValue: {
    fontSize: 24,
    fontWeight: '700',
  },
  perfPeriod: {
    fontSize: 12,
    color: colors.textMuted,
  },
  chartBox: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 8,
    marginBottom: 16,
  },
  chartEmpty: {
    height: CHART_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chartEmptyText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  explainer: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
  },
  explainerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  explainerText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
})

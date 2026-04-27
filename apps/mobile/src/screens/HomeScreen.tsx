import React from 'react'
import {
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
} from 'react-native'
import Svg, { Polyline, Defs, LinearGradient, Stop, Path } from 'react-native-svg'
import { useNavigation } from '@react-navigation/native'
import type { NavigationProp } from '@react-navigation/native'
import { colors } from '../theme/colors'
import { useAggregateHistory, useIndexCurrent, useAnalysisLatest } from '../api/hooks'
import type { MainTabParamList } from '../navigation/types'

const TIERS = [
  { key: 'CONSERVATIVE', label: 'Conservative', accent: colors.tierConservative },
  { key: 'BALANCED', label: 'Balanced', accent: colors.tierBalanced },
  { key: 'DEGEN', label: 'Degen', accent: colors.tierDegen },
] as const

const SPARK_W = Dimensions.get('window').width - 32 - 24 - 100
const SPARK_H = 44

interface SparkPoint {
  t: string
  indexed: number
}

function Sparkline({ points, color }: { points: SparkPoint[]; color: string }) {
  if (points.length < 2) {
    return <View style={{ width: SPARK_W, height: SPARK_H }} />
  }
  const values = points.map((p) => p.indexed)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = SPARK_W / (points.length - 1)
  const coords = points
    .map((p, i) => {
      const x = i * stepX
      const y = SPARK_H - ((p.indexed - min) / range) * (SPARK_H - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  // Filled area under the line
  const areaPath =
    `M0,${SPARK_H} ` +
    points
      .map((p, i) => {
        const x = i * stepX
        const y = SPARK_H - ((p.indexed - min) / range) * (SPARK_H - 4) - 2
        return `L${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ') +
    ` L${SPARK_W},${SPARK_H} Z`
  const gradId = `g-${color.replace('#', '')}`
  return (
    <Svg width={SPARK_W} height={SPARK_H}>
      <Defs>
        <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <Stop offset="100%" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Path d={areaPath} fill={`url(#${gradId})`} />
      <Polyline points={coords} fill="none" stroke={color} strokeWidth={2} />
    </Svg>
  )
}

function TierCard({
  tierKey,
  label,
  accent,
  onPress,
}: {
  tierKey: string
  label: string
  accent: string
  onPress: () => void
}) {
  const { data, isLoading } = useAggregateHistory(tierKey, 168)
  const points: SparkPoint[] = data?.data?.points ?? []
  const ret = points.length >= 2 ? (points[points.length - 1].indexed / points[0].indexed - 1) * 100 : 0
  const positive = ret >= 0
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.tierCard} onPress={onPress}>
      <View style={{ width: 100 }}>
        <Text style={styles.tierLabel}>{label}</Text>
        <Text style={styles.tierWindow}>7-day</Text>
        {isLoading ? (
          <ActivityIndicator size="small" color={accent} style={{ marginTop: 6, alignSelf: 'flex-start' }} />
        ) : (
          <Text style={[styles.tierReturn, { color: positive ? colors.green : colors.red }]}>
            {positive ? '+' : ''}
            {ret.toFixed(1)}%
          </Text>
        )}
      </View>
      <Sparkline points={points} color={accent} />
    </TouchableOpacity>
  )
}

function HoldingsStrip({ tier = 'BALANCED' as const }) {
  const { data } = useIndexCurrent(tier)
  const tokens = (data?.data?.tokens ?? []).slice(0, 10)
  if (tokens.length === 0) {
    return null
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Now Holding</Text>
        <Text style={styles.sectionSubtitle}>{tier} tier · top 10</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripScroll}>
        {tokens.map((t: any, i: number) => (
          <View key={t.tokenMint ?? i} style={styles.tokenChip}>
            <Text style={styles.tokenChipRank}>#{i + 1}</Text>
            <Text style={styles.tokenChipSymbol}>{t.tokenSymbol ?? '—'}</Text>
            <Text style={styles.tokenChipWeight}>
              {((t.weight ?? t.compositeScore ?? 0) * 100).toFixed(1)}%
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

function AiTakeCard() {
  const { data, isLoading } = useAnalysisLatest('BALANCED')
  const summary: string | undefined = data?.data?.summary ?? data?.data?.reasoning
  if (isLoading) {
    return (
      <View style={styles.aiCard}>
        <ActivityIndicator size="small" color={colors.green} />
      </View>
    )
  }
  if (!summary) return null
  const trimmed = summary.length > 280 ? summary.slice(0, 277) + '…' : summary
  return (
    <View style={styles.aiCard}>
      <View style={styles.aiHeader}>
        <View style={styles.aiDot} />
        <Text style={styles.aiTitle}>Latest AI Take</Text>
      </View>
      <Text style={styles.aiBody}>{trimmed}</Text>
    </View>
  )
}

export function HomeScreen() {
  const nav = useNavigation<NavigationProp<MainTabParamList>>()

  const goChart = () =>
    (nav as any).navigate('MarketTab', { screen: 'Chart' })
  const goIndex = () =>
    (nav as any).navigate('MarketTab', { screen: 'Index' })
  const goAnalysis = () =>
    (nav as any).navigate('MarketTab', { screen: 'Analysis' })
  const goDeposit = () =>
    (nav as any).navigate('PortfolioTab', { screen: 'Deposit' })

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Hero */}
      <View style={styles.hero}>
        <Image source={require('../../assets/logo.png')} style={styles.logo} />
        <Text style={styles.brand}>BAGS INDEX</Text>
        <Text style={styles.tagline}>Diversified exposure to the top tokens on Bags — in one tap.</Text>
      </View>

      {/* Tier performance cards */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Tier Performance</Text>
          <TouchableOpacity onPress={goChart}>
            <Text style={styles.linkText}>See all →</Text>
          </TouchableOpacity>
        </View>
        {TIERS.map((t) => (
          <TierCard
            key={t.key}
            tierKey={t.key}
            label={t.label}
            accent={t.accent}
            onPress={goChart}
          />
        ))}
      </View>

      {/* Now Holding strip */}
      <TouchableOpacity activeOpacity={0.9} onPress={goIndex}>
        <HoldingsStrip />
      </TouchableOpacity>

      {/* Latest AI take */}
      <TouchableOpacity activeOpacity={0.9} onPress={goAnalysis} style={styles.section}>
        <AiTakeCard />
      </TouchableOpacity>

      {/* CTA */}
      <TouchableOpacity activeOpacity={0.85} style={styles.cta} onPress={goDeposit}>
        <Text style={styles.ctaText}>Deposit SOL</Text>
      </TouchableOpacity>

      <View style={{ height: 24 }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16 },

  hero: { alignItems: 'center', paddingTop: 12, paddingBottom: 24 },
  logo: { width: 84, height: 84, borderRadius: 42, marginBottom: 12 },
  brand: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 2,
  },
  tagline: {
    marginTop: 6,
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
  },

  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  sectionSubtitle: { color: colors.textMuted, fontSize: 11 },
  linkText: { color: colors.green, fontSize: 12, fontWeight: '600' },

  tierCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tierLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  tierWindow: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  tierReturn: { fontSize: 16, fontWeight: '800', marginTop: 4 },

  stripScroll: { gap: 8, paddingRight: 16 },
  tokenChip: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 80,
    alignItems: 'center',
  },
  tokenChipRank: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  tokenChipSymbol: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 2 },
  tokenChipWeight: { color: colors.green, fontSize: 11, fontWeight: '600', marginTop: 2 },

  aiCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  aiDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green, marginRight: 8 },
  aiTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  aiBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },

  cta: {
    marginTop: 20,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  ctaText: { color: colors.black, fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
})

import React from 'react'
import { View, Text, ScrollView, StyleSheet, Linking, TouchableOpacity } from 'react-native'
import { colors } from '../theme/colors'

const STEPS = [
  {
    num: '1',
    title: 'Pool Discovery',
    desc: 'Every cycle starts by scanning all pools on Bags.fun — a Solana launchpad. Only tokens with real trading activity and a minimum $20K market cap make it past the initial filter.',
  },
  {
    num: '2',
    title: 'Signal Collection',
    desc: 'For each qualifying token, we pull 5 core signals from DexScreener: 24h volume, unique holder count, liquidity depth, market cap, and token age. These represent genuine on-chain traction.',
  },
  {
    num: '3',
    title: 'Tier Filtering',
    desc: 'Tokens are sorted into 3 risk tiers based on market cap and age thresholds:\n\n• Conservative — established tokens, higher mcap\n• Balanced — mid-range, proven liquidity\n• Degen — newer tokens, higher risk/reward',
  },
  {
    num: '4',
    title: 'Composite Scoring',
    desc: 'Each tier applies its own weight mix to the 5 signals. Conservative favors liquidity & holders; Degen favors volume & growth. The result is a single composite score per token per tier.',
  },
  {
    num: '5',
    title: 'AI Safety Review',
    desc: 'Claude reviews the top candidates for red flags — rug patterns, suspicious holder distribution, social manipulation signals. Flagged tokens are excluded before allocation.',
  },
  {
    num: '6',
    title: 'Allocation',
    desc: 'Top 10 tokens per tier get allocated using √score weighting — this compresses outliers and gives the basket more balance. Each token is capped at 25% max weight. 10% always goes to $BAGSX.',
  },
  {
    num: '7',
    title: 'Auto-Rebalance',
    desc: 'Your vault rebalances on a schedule:\n\n• Conservative: every 24h\n• Balanced: every 12h\n• Degen: every 4h\n\nSwaps execute via Jupiter with priority fees and retries.',
  },
]

export function AboutScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Hero */}
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>
          <Text style={{ color: colors.green }}>bags</Text>
          <Text style={{ color: colors.textPrimary }}>index</Text>
        </Text>
        <Text style={styles.heroSub}>
          The index fund for Bags.{'\n'}
          Deposit SOL, let the agent work.
        </Text>
      </View>

      {/* What is it */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>What is BagsIndex?</Text>
        <Text style={styles.body}>
          BagsIndex is a non-custodial Solana index vault. You deposit SOL into a risk tier, and an AI-powered scoring engine automatically builds and rebalances a portfolio of the top 10 tokens from the Bags.fun ecosystem.
        </Text>
        <Text style={styles.body}>
          Your funds stay in a dedicated Privy server wallet that only you control — we never pool deposits. Every swap is logged, every rebalance is transparent, and you can withdraw to SOL at any time.
        </Text>
      </View>

      {/* Stats */}
      <View style={styles.statsGrid}>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>3</Text>
          <Text style={styles.statLabel}>Risk Tiers</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>10</Text>
          <Text style={styles.statLabel}>Tokens / Tier</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>4-24h</Text>
          <Text style={styles.statLabel}>Rebalance</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>0%</Text>
          <Text style={styles.statLabel}>Fees</Text>
        </View>
      </View>

      {/* How scoring works */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>How the Scoring Cycle Works</Text>
        <Text style={styles.body}>
          Every rebalance runs a full scoring pipeline — from raw pool data to weighted allocation. Here's the 7-step process:
        </Text>
      </View>

      {STEPS.map((step) => (
        <View key={step.num} style={styles.stepCard}>
          <View style={styles.stepNum}>
            <Text style={styles.stepNumText}>{step.num}</Text>
          </View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDesc}>{step.desc}</Text>
          </View>
        </View>
      ))}

      {/* CTA */}
      <TouchableOpacity
        style={styles.linkBtn}
        onPress={() => Linking.openURL('https://bagsindex.fun')}
        activeOpacity={0.7}>
        <Text style={styles.linkBtnText}>Visit bagsindex.fun</Text>
      </TouchableOpacity>
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
    paddingBottom: 48,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  heroTitle: {
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 8,
  },
  heroSub: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 21,
    marginBottom: 8,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  statNum: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.green,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  stepCard: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    padding: 14,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.green,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepNumText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.bg,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  stepDesc: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  linkBtn: {
    marginTop: 16,
    backgroundColor: colors.green,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  linkBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.bg,
  },
})

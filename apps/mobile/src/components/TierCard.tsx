import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { colors } from '../theme/colors'
import { HoldingRow } from './HoldingRow'
import { formatSol } from '../utils/format'

const TIER_COLORS: Record<string, string> = {
  CONSERVATIVE: colors.tierConservative,
  BALANCED: colors.tierBalanced,
  DEGEN: colors.tierDegen,
}

const TIER_LABELS: Record<string, string> = {
  CONSERVATIVE: 'Conservative',
  BALANCED: 'Balanced',
  DEGEN: 'Degen',
}

interface Holding {
  tokenMint: string
  tokenSymbol: string
  amount: number
  valueSol: number
  pnlPct?: number
}

interface TierCardProps {
  riskTier: string
  totalValueSol: number
  holdings: Holding[]
  onLiquidate?: (mint: string) => void
}

export function TierCard({ riskTier, totalValueSol, holdings, onLiquidate }: TierCardProps) {
  const [expanded, setExpanded] = useState(true)
  const tierColor = TIER_COLORS[riskTier] ?? colors.textMuted

  return (
    <View style={[styles.card, { borderLeftColor: tierColor }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}>
        <View style={styles.headerLeft}>
          <View style={[styles.dot, { backgroundColor: tierColor }]} />
          <Text style={styles.tierName}>{TIER_LABELS[riskTier] ?? riskTier}</Text>
          <Text style={styles.count}>{holdings.length}</Text>
        </View>
        <Text style={styles.value}>{formatSol(totalValueSol)} SOL</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.holdingsList}>
          {holdings.map((h) => (
            <HoldingRow
              key={h.tokenMint}
              tokenMint={h.tokenMint}
              tokenSymbol={h.tokenSymbol}
              valueSol={h.valueSol}
              pnlPct={h.pnlPct}
              onLiquidate={onLiquidate ? () => onLiquidate(h.tokenMint) : undefined}
            />
          ))}
          {holdings.length === 0 && (
            <Text style={styles.empty}>No holdings</Text>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    borderLeftWidth: 3,
    marginBottom: 12,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tierName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  count: {
    fontSize: 13,
    color: colors.textMuted,
    backgroundColor: colors.border,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  value: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.green,
  },
  holdingsList: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 8,
  },
})

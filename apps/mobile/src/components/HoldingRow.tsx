import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { colors } from '../theme/colors'
import { formatSol, formatPct } from '../utils/format'

interface HoldingRowProps {
  tokenMint: string
  tokenSymbol: string
  valueSol: number
  pnlPct?: number
  onLiquidate?: () => void
}

export function HoldingRow({ tokenSymbol, valueSol, pnlPct, onLiquidate }: HoldingRowProps) {
  const handleLongPress = () => {
    if (!onLiquidate) return
    Alert.alert(
      `Liquidate ${tokenSymbol}?`,
      'This will sell the full position to SOL.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Liquidate', style: 'destructive', onPress: onLiquidate },
      ],
    )
  }

  return (
    <TouchableOpacity
      style={styles.row}
      onLongPress={handleLongPress}
      delayLongPress={500}
      activeOpacity={0.7}>
      <View style={styles.left}>
        <Text style={styles.symbol}>{tokenSymbol}</Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.value}>{formatSol(valueSol)} SOL</Text>
        {pnlPct != null && (
          <Text style={[styles.pnl, { color: pnlPct >= 0 ? colors.green : colors.red }]}>
            {formatPct(pnlPct)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  symbol: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  right: {
    alignItems: 'flex-end',
  },
  value: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  pnl: {
    fontSize: 12,
    marginTop: 2,
  },
})

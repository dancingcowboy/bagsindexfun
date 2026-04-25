import React from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { CompositeNavigationProp } from '@react-navigation/native'
import { usePortfolio, useLiquidateHolding } from '../api/hooks'
import { useAuth } from '../auth/AuthProvider'
import { TierCard } from '../components/TierCard'
import { colors } from '../theme/colors'
import { formatSol, truncateAddress } from '../utils/format'
import type { PortfolioStackParamList, RootStackParamList } from '../navigation/types'

type Nav = CompositeNavigationProp<
  NativeStackNavigationProp<PortfolioStackParamList, 'Portfolio'>,
  NativeStackNavigationProp<RootStackParamList>
>

export function PortfolioScreen() {
  const nav = useNavigation<Nav>()
  const { user, isAuthenticated } = useAuth()
  const { data, isLoading, refetch } = usePortfolio(true)
  const liquidate = useLiquidateHolding()

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, styles.gateContainer]}>
        <Text style={styles.gateLogo}>
          <Text style={{ color: colors.green }}>bags</Text>
          <Text style={{ color: colors.textPrimary }}>index</Text>
        </Text>
        <Text style={styles.gateTitle}>Your Portfolio</Text>
        <Text style={styles.gateSubtext}>
          Connect your wallet to view your vault holdings, deposit SOL, and manage withdrawals.
        </Text>
        <TouchableOpacity
          style={styles.gateBtn}
          onPress={() => nav.navigate('Login')}
          activeOpacity={0.8}>
          <Text style={styles.gateBtnText}>Connect Wallet</Text>
        </TouchableOpacity>
      </View>
    )
  }

  const portfolio = data?.data
  const tiers = portfolio?.tiers ?? []
  const totalValue = tiers.reduce(
    (sum: number, t: any) => sum + (t.totalValueSol ?? 0),
    0,
  )

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isLoading}
          onRefresh={refetch}
          tintColor={colors.green}
        />
      }>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.walletLabel}>
          {user?.walletAddress ? truncateAddress(user.walletAddress, 6) : ''}
        </Text>
        <Text style={styles.totalValue}>{formatSol(totalValue)} SOL</Text>
        <Text style={styles.totalLabel}>Total Vault Value</Text>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => nav.navigate('Deposit')}
          activeOpacity={0.8}>
          <Text style={styles.actionBtnText}>Deposit</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnSecondary]}
          onPress={() => nav.navigate('Withdraw', {})}
          activeOpacity={0.8}>
          <Text style={[styles.actionBtnText, styles.actionBtnTextSecondary]}>Withdraw</Text>
        </TouchableOpacity>
      </View>

      {/* Tier cards */}
      {tiers.map((tier: any) => (
        <TierCard
          key={tier.riskTier}
          riskTier={tier.riskTier}
          totalValueSol={tier.totalValueSol ?? 0}
          holdings={(tier.holdings ?? []).map((h: any) => ({
            tokenMint: h.tokenMint,
            tokenSymbol: h.tokenSymbol ?? h.tokenMint.slice(0, 6),
            amount: h.amount,
            valueSol: h.valueSol ?? 0,
            pnlPct: h.pnlPct,
          }))}
          onLiquidate={(mint) => {
            liquidate.mutate({ mint, riskTier: tier.riskTier })
          }}
        />
      ))}

      {tiers.length === 0 && !isLoading && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No deposits yet</Text>
          <Text style={styles.emptySubtext}>
            Deposit SOL to start building your index portfolio
          </Text>
        </View>
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
    alignItems: 'center',
    paddingVertical: 24,
  },
  walletLabel: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 8,
  },
  totalValue: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  totalLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: colors.green,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.bg,
  },
  actionBtnTextSecondary: {
    color: colors.textPrimary,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 8,
    textAlign: 'center',
  },
  gateContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  gateLogo: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 24,
  },
  gateTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  gateSubtext: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
    paddingHorizontal: 16,
  },
  gateBtn: {
    backgroundColor: colors.green,
    paddingVertical: 14,
    paddingHorizontal: 48,
    borderRadius: 10,
  },
  gateBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.bg,
  },
})

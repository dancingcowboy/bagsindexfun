import type { RiskTier } from '@bags-index/shared'

export type RootStackParamList = {
  Login: undefined
  Main: undefined
}

export type MainTabParamList = {
  HomeTab: undefined
  MarketTab: undefined
  PortfolioTab: undefined
  AboutTab: undefined
  SettingsTab: undefined
}

export type PortfolioStackParamList = {
  Portfolio: undefined
  Deposit: undefined
  Withdraw: { riskTier?: RiskTier }
  Progress: { type: 'deposit' | 'withdrawal'; id: string }
}

export type MarketStackParamList = {
  Index: undefined
  Chart: undefined
  Analysis: undefined
}

export type SettingsStackParamList = {
  Settings: undefined
}

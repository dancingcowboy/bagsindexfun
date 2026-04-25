import type { RiskTier } from '@bags-index/shared'

export type RootStackParamList = {
  Login: undefined
  Main: undefined
}

export type MainTabParamList = {
  PortfolioTab: undefined
  MarketTab: undefined
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
  Hotlist: undefined
  Analysis: undefined
}

export type SettingsStackParamList = {
  Settings: undefined
}

import React from 'react'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { colors } from '../theme/colors'
import type { MainTabParamList, PortfolioStackParamList, MarketStackParamList, SettingsStackParamList } from './types'

import { PortfolioScreen } from '../screens/PortfolioScreen'
import { DepositScreen } from '../screens/DepositScreen'
import { WithdrawScreen } from '../screens/WithdrawScreen'
import { ProgressScreen } from '../screens/ProgressScreen'
import { IndexScreen } from '../screens/IndexScreen'
import { ChartScreen } from '../screens/ChartScreen'
import { HotlistScreen } from '../screens/HotlistScreen'
import { AnalysisScreen } from '../screens/AnalysisScreen'
import { AboutScreen } from '../screens/AboutScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { TabBarIcon } from '../components/TabBarIcon'

const Tab = createBottomTabNavigator<MainTabParamList>()
const PortfolioStack = createNativeStackNavigator<PortfolioStackParamList>()
const MarketStack = createNativeStackNavigator<MarketStackParamList>()
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>()

const screenOptions = {
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.textPrimary,
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.bg },
}

function PortfolioStackScreen() {
  return (
    <PortfolioStack.Navigator screenOptions={screenOptions}>
      <PortfolioStack.Screen name="Portfolio" component={PortfolioScreen} options={{ title: 'Portfolio' }} />
      <PortfolioStack.Screen name="Deposit" component={DepositScreen} options={{ title: 'Deposit', presentation: 'modal' }} />
      <PortfolioStack.Screen name="Withdraw" component={WithdrawScreen} options={{ title: 'Withdraw', presentation: 'modal' }} />
      <PortfolioStack.Screen name="Progress" component={ProgressScreen} options={{ title: 'Progress', presentation: 'modal' }} />
    </PortfolioStack.Navigator>
  )
}

function MarketStackScreen() {
  return (
    <MarketStack.Navigator screenOptions={screenOptions}>
      <MarketStack.Screen name="Index" component={IndexScreen} options={{ title: 'Index' }} />
      <MarketStack.Screen name="Chart" component={ChartScreen} options={{ title: 'Performance' }} />
      <MarketStack.Screen name="Hotlist" component={HotlistScreen} options={{ title: 'Hotlist' }} />
      <MarketStack.Screen name="Analysis" component={AnalysisScreen} options={{ title: 'AI Analysis' }} />
    </MarketStack.Navigator>
  )
}

function SettingsStackScreen() {
  return (
    <SettingsStack.Navigator screenOptions={screenOptions}>
      <SettingsStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </SettingsStack.Navigator>
  )
}

export function MainTabs() {
  return (
    <Tab.Navigator
      initialRouteName="MarketTab"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.textMuted,
      }}>
      <Tab.Screen
        name="MarketTab"
        component={MarketStackScreen}
        options={{
          title: 'Market',
          tabBarIcon: ({ color, size }) => <TabBarIcon name="market" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="PortfolioTab"
        component={PortfolioStackScreen}
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ color, size }) => <TabBarIcon name="portfolio" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="AboutTab"
        component={AboutScreen}
        options={{
          title: 'About',
          tabBarIcon: ({ color, size }) => <TabBarIcon name="about" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsStackScreen}
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <TabBarIcon name="settings" color={color} size={size} />,
        }}
      />
    </Tab.Navigator>
  )
}

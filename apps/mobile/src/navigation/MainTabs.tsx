import React from 'react'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { colors } from '../theme/colors'
import type { MainTabParamList, PortfolioStackParamList, IndexStackParamList, SettingsStackParamList } from './types'

import { PortfolioScreen } from '../screens/PortfolioScreen'
import { DepositScreen } from '../screens/DepositScreen'
import { WithdrawScreen } from '../screens/WithdrawScreen'
import { ProgressScreen } from '../screens/ProgressScreen'
import { IndexScreen } from '../screens/IndexScreen'
import { SettingsScreen } from '../screens/SettingsScreen'

const Tab = createBottomTabNavigator<MainTabParamList>()
const PortfolioStack = createNativeStackNavigator<PortfolioStackParamList>()
const IndexStack = createNativeStackNavigator<IndexStackParamList>()
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

function IndexStackScreen() {
  return (
    <IndexStack.Navigator screenOptions={screenOptions}>
      <IndexStack.Screen name="Index" component={IndexScreen} options={{ title: 'Index' }} />
    </IndexStack.Navigator>
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
        name="PortfolioTab"
        component={PortfolioStackScreen}
        options={{ title: 'Portfolio' }}
      />
      <Tab.Screen
        name="IndexTab"
        component={IndexStackScreen}
        options={{ title: 'Index' }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsStackScreen}
        options={{ title: 'Settings' }}
      />
    </Tab.Navigator>
  )
}

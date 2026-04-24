import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, Clipboard, Switch } from 'react-native'
import { useAuth } from '../auth/AuthProvider'
import { useTelegramStatus, useCreateTelegramLinkCode, useUnlinkTelegram, useSetTelegramEnabled } from '../api/hooks'
import { colors } from '../theme/colors'
import { truncateAddress } from '../utils/format'

export function SettingsScreen() {
  const { user, logout } = useAuth()
  const telegramStatus = useTelegramStatus()
  const createLinkCode = useCreateTelegramLinkCode()
  const unlinkTelegram = useUnlinkTelegram()
  const setTelegramEnabled = useSetTelegramEnabled()

  const [linkCode, setLinkCode] = useState<string | null>(null)

  const tgData = telegramStatus.data?.data
  const isLinked = tgData?.linked ?? false
  const isEnabled = tgData?.enabled ?? false

  const handleLinkTelegram = async () => {
    try {
      const result = await createLinkCode.mutateAsync()
      const code = result?.data?.data?.code ?? result?.data?.code
      setLinkCode(code)
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate link code')
    }
  }

  const handleCopyCode = () => {
    if (linkCode) {
      Clipboard.setString(linkCode)
      Alert.alert('Copied', 'Link code copied to clipboard')
    }
  }

  const handleUnlink = () => {
    Alert.alert('Unlink Telegram?', 'You will stop receiving notifications.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unlink',
        style: 'destructive',
        onPress: () => unlinkTelegram.mutate(),
      },
    ])
  }

  const handleLogout = () => {
    Alert.alert('Disconnect?', 'This will log you out.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: logout },
    ])
  }

  return (
    <View style={styles.container}>
      {/* Account */}
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Wallet</Text>
          <Text style={styles.rowValue}>
            {user?.walletAddress ? truncateAddress(user.walletAddress, 6) : '—'}
          </Text>
        </View>
      </View>

      {/* Telegram */}
      <Text style={styles.sectionTitle}>Telegram Notifications</Text>
      <View style={styles.card}>
        {isLinked ? (
          <>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Status</Text>
              <Text style={[styles.rowValue, { color: colors.green }]}>Linked</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Notifications</Text>
              <Switch
                value={isEnabled}
                onValueChange={(val) => setTelegramEnabled.mutate(val)}
                trackColor={{ false: colors.border, true: colors.green }}
                thumbColor={colors.white}
              />
            </View>
            <TouchableOpacity style={styles.linkBtn} onPress={handleUnlink}>
              <Text style={styles.linkBtnTextDanger}>Unlink Telegram</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.description}>
              Get DMs when your vaults trade — rebalances, deposits, withdrawals.
            </Text>
            {linkCode ? (
              <View style={styles.codeBox}>
                <Text style={styles.codeText}>{linkCode}</Text>
                <TouchableOpacity onPress={handleCopyCode}>
                  <Text style={styles.copyBtn}>Copy</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.linkBtn} onPress={handleLinkTelegram}>
                <Text style={styles.linkBtnText}>Link Telegram</Text>
              </TouchableOpacity>
            )}
            {linkCode && (
              <Text style={styles.codeInstructions}>
                Send this code to @bagsindexbot on Telegram
              </Text>
            )}
          </>
        )}
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutBtnText}>Disconnect Wallet</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: {
    fontSize: 15,
    color: colors.textSecondary,
  },
  rowValue: {
    fontSize: 15,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  description: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  linkBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  linkBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.green,
  },
  linkBtnTextDanger: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.red,
  },
  codeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 16,
  },
  codeText: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.green,
    letterSpacing: 4,
  },
  copyBtn: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '500',
  },
  codeInstructions: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  },
  logoutBtn: {
    marginTop: 32,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  logoutBtnText: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.red,
  },
})

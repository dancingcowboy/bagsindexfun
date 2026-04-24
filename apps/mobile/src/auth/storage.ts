import * as Keychain from 'react-native-keychain'

const SERVICE = 'bags-index-jwt'

export async function setToken(jwt: string): Promise<void> {
  await Keychain.setGenericPassword('jwt', jwt, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
  })
}

export async function getToken(): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({ service: SERVICE })
  if (!creds) return null
  return creds.password
}

export async function clearToken(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
}

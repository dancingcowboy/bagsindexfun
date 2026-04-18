'use client'

import { useEffect } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { api } from '@/lib/api'

/**
 * Bridges Privy auth into our API JWT.
 * On Privy login → call /auth/login with the Privy access token,
 * which sets an HttpOnly cookie server-side.
 */
export function AuthBridge() {
  const { ready, authenticated, getAccessToken, user } = usePrivy()

  useEffect(() => {
    if (!ready || !authenticated) return
    ;(async () => {
      try {
        const privyToken = await getAccessToken()
        if (!privyToken) return
        await api.login(privyToken)
      } catch (err) {
        console.error('auth bridge login failed', err)
      }
    })()
  }, [ready, authenticated, getAccessToken, user?.id])

  return null
}

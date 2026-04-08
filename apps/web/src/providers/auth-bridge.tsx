'use client'

import { useEffect, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { api } from '@/lib/api'

/**
 * Bridges Privy auth into our API JWT.
 * On Privy login → call /auth/login with the Privy access token,
 * stash returned JWT in localStorage and on the api client.
 *
 * If the API returns WALLET_NOT_ALLOWED (pre-launch allowlist), we log
 * the user out of Privy and show a "coming soon" overlay.
 */
export function AuthBridge() {
  const { ready, authenticated, getAccessToken, user, logout } = usePrivy()
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    if (!ready) return
    if (!authenticated) {
      // No-op for cookie-based auth; /auth/logout clears the cookie server-side.
      // We also proactively ping logout to invalidate the server-side JTI.
      api.logout().catch(() => {})
      setBlocked(false)
      return
    }
    ;(async () => {
      try {
        const privyToken = await getAccessToken()
        if (!privyToken) return
        // Login sets the HttpOnly cookie server-side; nothing to stash client-side.
        await api.login(privyToken)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'WALLET_NOT_ALLOWED') {
          setBlocked(true)
          try { await logout() } catch { /* ignore */ }
        } else {
          console.error('auth bridge login failed', err)
        }
      }
    })()
  }, [ready, authenticated, getAccessToken, user?.id, logout])

  if (!blocked) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 backdrop-blur-md p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-w-md w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-8 text-center">
        <div
          className="text-xs font-bold tracking-widest mb-3"
          style={{ color: '#00D62B' }}
        >
          PRIVATE BETA
        </div>
        <h2 className="text-2xl font-bold mb-3">Coming soon</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mb-6">
          bags-index is in closed testing right now. Public deposits open
          shortly. Follow{' '}
          <a
            href="https://x.com/bagsindex"
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: '#00D62B' }}
          >
            @bagsindex
          </a>{' '}
          to be the first to know.
        </p>
        <button
          onClick={() => setBlocked(false)}
          className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-white/5"
        >
          Close
        </button>
      </div>
    </div>
  )
}

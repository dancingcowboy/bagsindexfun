import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api, setOnUnauthorized } from '../api/client'
import { setToken, getToken, clearToken } from './storage'

interface User {
  id: string
  walletAddress: string
  subWallets: { riskTier: string; address: string }[]
}

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  user: User | null
  login: (privyToken: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: false,
  isLoading: true,
  user: null,
  login: async () => {},
  logout: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)


  const handleUnauthorized = useCallback(() => {
    setUser(null)
  }, [])

  useEffect(() => {
    setOnUnauthorized(handleUnauthorized)
  }, [handleUnauthorized])

  // Check for existing JWT on mount
  useEffect(() => {
    ;(async () => {
      const token = await getToken()
      if (!token) {
        setIsLoading(false)
        return
      }
      try {
        const res = await api.get('/auth/me')
        setUser(res.data.data?.user ?? res.data.user ?? null)
      } catch {
        await clearToken()
      }
      setIsLoading(false)
    })()
  }, [])

  const login = useCallback(async (privyToken: string) => {
    const res = await api.post('/auth/mobile-login', { privyToken })
    const { token, data } = res.data
    if (token) {
      await setToken(token)
    }
    setUser(data.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } catch {
      // best-effort server logout
    }
    await clearToken()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!user,
        isLoading,
        user,
        login,
        logout,
      }}>
      {children}
    </AuthContext.Provider>
  )
}

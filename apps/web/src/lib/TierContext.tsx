'use client'

import { createContext, useContext, useState, ReactNode } from 'react'

export type RiskTier = 'CONSERVATIVE' | 'BALANCED' | 'DEGEN'

interface TierContextValue {
  tier: RiskTier
  setTier: (t: RiskTier) => void
}

const TierContext = createContext<TierContextValue | null>(null)

export function TierProvider({ children }: { children: ReactNode }) {
  const [tier, setTier] = useState<RiskTier>('BALANCED')
  return <TierContext.Provider value={{ tier, setTier }}>{children}</TierContext.Provider>
}

export function useTier() {
  const ctx = useContext(TierContext)
  if (!ctx) throw new Error('useTier must be used inside TierProvider')
  return ctx
}

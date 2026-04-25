import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { RiskTier } from '@bags-index/shared'

// ── Auth ────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/auth/me').then((r) => r.data),
  })
}

// ── Portfolio ───────────────────────────────────────────────────────

export function usePortfolio(live = false) {
  return useQuery({
    queryKey: ['portfolio', live],
    queryFn: () => api.get(`/portfolio${live ? '?live=1' : ''}`).then((r) => r.data),
    refetchInterval: 30_000,
  })
}

export function usePortfolioPnl() {
  return useQuery({
    queryKey: ['portfolio-pnl'],
    queryFn: () => api.get('/portfolio/pnl').then((r) => r.data),
  })
}

export function useTransactions() {
  return useQuery({
    queryKey: ['transactions'],
    queryFn: () => api.get('/portfolio/transactions').then((r) => r.data),
  })
}

export function useReshuffle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (riskTier: RiskTier) =>
      api.post('/portfolio/reshuffle', { riskTier }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  })
}

export function useSetAutoTakeProfit() {
  return useMutation({
    mutationFn: ({ riskTier, pct }: { riskTier: RiskTier; pct: number }) =>
      api.put('/portfolio/auto-tp', { riskTier, pct }).then((r) => r.data),
  })
}

export function useLiquidateHolding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ mint, riskTier }: { mint: string; riskTier: RiskTier }) =>
      api.post(`/portfolio/holdings/${mint}/liquidate`, { riskTier }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio'] }),
  })
}

// ── Index (public) ──────────────────────────────────────────────────

export function useIndexCurrent(tier?: RiskTier) {
  return useQuery({
    queryKey: ['index-current', tier],
    queryFn: () =>
      api.get(`/index/current${tier ? `?tier=${tier}` : ''}`).then((r) => r.data),
  })
}

export function useIndexSchedule() {
  return useQuery({
    queryKey: ['index-schedule'],
    queryFn: () => api.get('/index/schedule').then((r) => r.data),
    refetchInterval: 60_000,
  })
}

export function useHotlist(tier?: RiskTier) {
  return useQuery({
    queryKey: ['hotlist', tier],
    queryFn: () =>
      api.get(`/index/hotlist${tier ? `?tier=${tier}` : ''}`).then((r) => r.data),
  })
}

// ── Deposits ────────────────────────────────────────────────────────

export function useCreateDeposit() {
  return useMutation({
    mutationFn: ({ amountSol, riskTier }: { amountSol: number; riskTier: RiskTier }) =>
      api.post('/deposits', { amountSol, riskTier }).then((r) => r.data),
  })
}

export function useConfirmDeposit() {
  return useMutation({
    mutationFn: ({ id, txSignature }: { id: string; txSignature: string }) =>
      api.post(`/deposits/${id}/confirm`, { txSignature }).then((r) => r.data),
  })
}

export function useDepositProgress(id: string | null) {
  return useQuery({
    queryKey: ['deposit-progress', id],
    queryFn: () => api.get(`/deposits/${id}/progress`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: 3_000,
  })
}

export function useDeposits() {
  return useQuery({
    queryKey: ['deposits'],
    queryFn: () => api.get('/deposits').then((r) => r.data),
  })
}

// ── Withdrawals ─────────────────────────────────────────────────────

export function useCreateWithdrawal() {
  return useMutation({
    mutationFn: ({ riskTier, pct }: { riskTier: RiskTier; pct?: number }) =>
      api.post('/withdrawals', { riskTier, pct }).then((r) => r.data),
  })
}

export function useWithdrawalProgress(id: string | null) {
  return useQuery({
    queryKey: ['withdrawal-progress', id],
    queryFn: () => api.get(`/withdrawals/${id}/progress`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: 3_000,
  })
}

export function useWithdrawals() {
  return useQuery({
    queryKey: ['withdrawals'],
    queryFn: () => api.get('/withdrawals').then((r) => r.data),
  })
}

// ── Telegram ────────────────────────────────────────────────────────

export function useTelegramStatus() {
  return useQuery({
    queryKey: ['telegram-status'],
    queryFn: () => api.get('/user/telegram/status').then((r) => r.data),
  })
}

export function useCreateTelegramLinkCode() {
  return useMutation({
    mutationFn: () => api.post('/user/telegram/link-code').then((r) => r.data),
  })
}

export function useUnlinkTelegram() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete('/user/telegram').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram-status'] }),
  })
}

export function useSetTelegramEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put('/user/telegram/enabled', { enabled }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram-status'] }),
  })
}

// ── Chat ────────────────────────────────────────────────────────────

export function useChatMessages() {
  return useQuery({
    queryKey: ['chat-messages'],
    queryFn: () => api.get('/chat/messages').then((r) => r.data),
  })
}

export function useSendChatMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (message: string) =>
      api.post('/chat/send', { message }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-messages'] }),
  })
}

// Index aggregate history for charts
export function useAggregateHistory(tier: string, hours = 168) {
  return useQuery({
    queryKey: ['aggregate-history', tier, hours],
    queryFn: () =>
      api.get(`/index/aggregate-history?tier=${tier}&hours=${hours}`).then((r) => r.data),
    staleTime: 5 * 60_000,
  })
}

// AI analysis — latest scoring reasoning + allocations
export function useAnalysisLatest(tier?: string) {
  return useQuery({
    queryKey: ['analysis-latest', tier],
    queryFn: () =>
      api.get(`/analysis/latest${tier ? `?tier=${tier}` : ''}`).then((r) => r.data),
    staleTime: 5 * 60_000,
  })
}

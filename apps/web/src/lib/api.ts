export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

/** Dummy for backwards-compat with callers that still pass an auth header. */
export function authHeaders(): Record<string, string> {
  return {}
}

class ApiClient {
  // Token is held in an HttpOnly cookie set by the API on /auth/login.
  // The browser sends it automatically via `credentials: 'include'`.
  // `setToken` is kept as a no-op to avoid breaking existing call sites.
  setToken(_token: string | null) {
    /* noop — cookie is set server-side */
  }

  private async fetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts?.headers as Record<string, string>),
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers,
      credentials: 'include',
    })
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data.error || 'Request failed')
    }
    return data
  }

  // Auth
  login(privyToken: string) {
    return this.fetch<{ data: { user: any } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ privyToken }),
    })
  }

  getMe() {
    return this.fetch('/auth/me')
  }

  logout() {
    return this.fetch('/auth/logout', { method: 'POST' })
  }

  // Portfolio
  getPortfolio(live = false) {
    return this.fetch<{ data: any }>(`/portfolio${live ? '?live=1' : ''}`)
  }

  getTransactions() {
    return this.fetch<{ data: any[] }>('/portfolio/transactions')
  }

  getPnl() {
    return this.fetch<{ data: { tiers: any[]; totals: any } }>('/portfolio/pnl')
  }

  setRiskTier(tier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN') {
    return this.fetch<{ data: { tier: string } }>('/portfolio/tier', {
      method: 'PUT',
      body: JSON.stringify({ tier }),
    })
  }

  createSwitch(
    fromTier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN',
    toTier: 'CONSERVATIVE' | 'BALANCED' | 'DEGEN',
  ) {
    return this.fetch<{
      data: {
        id: string
        fromTier: string
        toTier: string
        sourceValueSol: string
        feeSol: string
        naiveFeeSol: string
        estimatedSavingsSol: string
        status: string
      }
    }>('/portfolio/switch', {
      method: 'POST',
      body: JSON.stringify({ fromTier, toTier }),
    })
  }

  getSwitches() {
    return this.fetch<{ data: any[] }>('/portfolio/switches')
  }

  // Deposits
  createDeposit(amountSol: number) {
    return this.fetch<{ data: any }>('/deposits', {
      method: 'POST',
      body: JSON.stringify({ amountSol }),
    })
  }

  confirmDeposit(id: string, txSignature: string) {
    return this.fetch(`/deposits/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ txSignature }),
    })
  }

  getDeposits() {
    return this.fetch<{ data: any[] }>('/deposits')
  }

  // Withdrawals
  createWithdrawal() {
    return this.fetch<{ data: any }>('/withdrawals', {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }

  getWithdrawals() {
    return this.fetch<{ data: any[] }>('/withdrawals')
  }

  // Index (public)
  getIndexCurrent() {
    return this.fetch<{ data: any }>('/index/current')
  }

  getIndexHistory() {
    return this.fetch<{ data: any[] }>('/index/history')
  }

  getBurnStats() {
    return this.fetch<{ data: any }>('/index/burns')
  }

  // Analysis (public)
  getLatestAnalysis() {
    return this.fetch<{ data: any }>('/analysis/latest')
  }

  getAnalysisHistory() {
    return this.fetch<{ data: any[] }>('/analysis/history')
  }
}

export const api = new ApiClient()

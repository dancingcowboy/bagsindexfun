import axios from 'axios'
import { getToken, clearToken } from '../auth/storage'

// TODO: move to env config (react-native-config)
const API_BASE = 'https://bagsindex.fun/api'

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT to every request
api.interceptors.request.use(async (config) => {
  const token = await getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// On 401, clear token — AuthProvider will detect and show login
let onUnauthorized: (() => void) | null = null

export function setOnUnauthorized(cb: () => void) {
  onUnauthorized = cb
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401) {
      await clearToken()
      onUnauthorized?.()
    }
    return Promise.reject(error)
  },
)

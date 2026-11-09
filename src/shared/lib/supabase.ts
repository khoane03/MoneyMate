import { createClient } from '@supabase/supabase-js'
import { createReferenceFetch } from './readCache'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined

let usageSessionId: string | null = null
let clearingExpiredSession = false
const pendingRequests = new Map<string, number>()
let requestFlushInProgress = false

function countSupabaseRequest(input: RequestInfo | URL) {
  if (!url || !usageSessionId) return
  const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!requestUrl.startsWith(url) || requestUrl.includes('/rpc/record_app_usage')) return
  pendingRequests.set(usageSessionId, (pendingRequests.get(usageSessionId) ?? 0) + 1)
}

async function trackedFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    const response = await fetch(input, init)
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // A 401 from Supabase means the current credential is no longer accepted.
    // Clear only this device's session so AuthGate returns to sign-in immediately.
    if (response.status === 401 && url && requestUrl.startsWith(url)) {
      void clearExpiredSession()
    }
    return response
  } finally {
    countSupabaseRequest(input)
  }
}

export async function clearExpiredSession() {
  if (!supabase || clearingExpiredSession) return
  clearingExpiredSession = true
  try { await supabase.auth.signOut({ scope: 'local' }) }
  finally { clearingExpiredSession = false }
}

export function setUsageSession(sessionId: string | null) {
  usageSessionId = sessionId
}

export async function recordUsageVisit(sessionId: string) {
  if (!supabase) return
  await supabase.rpc('record_app_usage', { p_session_id: sessionId, p_request_delta: 0 })
}

export async function flushUsageRequests() {
  if (!supabase || !usageSessionId || requestFlushInProgress) return
  const sessionId = usageSessionId
  const count = pendingRequests.get(sessionId) ?? 0
  if (count === 0) return
  requestFlushInProgress = true
  try {
    const { error } = await supabase.rpc('record_app_usage', { p_session_id: sessionId, p_request_delta: Math.min(count, 1000) })
    if (!error) {
      const remaining = (pendingRequests.get(sessionId) ?? 0) - Math.min(count, 1000)
      if (remaining > 0) pendingRequests.set(sessionId, remaining)
      else pendingRequests.delete(sessionId)
    }
  } finally {
    requestFlushInProgress = false
  }
}

const referenceFetch = createReferenceFetch(trackedFetch)

export const supabase = url && publishableKey ? createClient(url, publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: referenceFetch.fetch },
}) : null

export const backendConfigurationError = supabase ? null : 'Chưa cấu hình Supabase. Hãy khai báo VITE_SUPABASE_URL và VITE_SUPABASE_PUBLISHABLE_KEY để đồng bộ tài khoản.'

// Do not let cached private labels survive sign-out, account changes or reconnect.
supabase?.auth.onAuthStateChange(() => referenceFetch.clear())
if (typeof window !== 'undefined') {
  window.addEventListener('online', referenceFetch.clear)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') referenceFetch.clear() })
}

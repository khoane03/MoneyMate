import { useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createUuid } from './uuid'
import { flushUsageRequests, recordUsageVisit, setUsageSession, supabase } from './supabase'

const STORAGE_PREFIX = 'moneymate-usage-session-v1:'

function sessionIdFor(userId: string) {
  const key = `${STORAGE_PREFIX}${userId}`
  const saved = sessionStorage.getItem(key)
  if (saved) return saved
  const created = createUuid()
  sessionStorage.setItem(key, created)
  return created
}

/** Records authenticated app sessions and batches Supabase request counts. */
export function UsageTracker() {
  useEffect(() => {
    if (!supabase) return
    let mounted = true
    let activeUserId: string | null = null

    const activate = (session: Session | null) => {
      if (!mounted) return
      const userId = session?.user.id ?? null
      if (userId === activeUserId) return
      activeUserId = userId
      if (!userId) {
        setUsageSession(null)
        return
      }
      const id = sessionIdFor(userId)
      setUsageSession(id)
      void recordUsageVisit(id).catch(() => undefined)
    }

    void supabase.auth.getSession().then(({ data }) => activate(data.session)).catch(() => activate(null))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => activate(session))
    const interval = window.setInterval(() => { void flushUsageRequests().catch(() => undefined) }, 15_000)
    const flushOnHide = () => { if (document.visibilityState === 'hidden') void flushUsageRequests().catch(() => undefined) }
    document.addEventListener('visibilitychange', flushOnHide)
    window.addEventListener('pagehide', flushOnHide)

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', flushOnHide)
      window.removeEventListener('pagehide', flushOnHide)
      void flushUsageRequests().catch(() => undefined)
      setUsageSession(null)
    }
  }, [])

  return null
}

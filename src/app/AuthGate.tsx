import { Fragment, lazy, Suspense, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { clearExpiredSession, supabase } from '../shared/lib/supabase'
import { AppLaunchScreen } from '../shared/ui/AppLaunchScreen'

const AuthScreen = lazy(() => import('../features/auth/AuthScreen').then(module => ({ default: module.AuthScreen })))

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!supabase) { setReady(true); return }
    let mounted = true
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        if (!data.session) { setSession(null); setReady(true); return }

        // A persisted token is not proof that its Auth user still exists.
        const { data: userData, error } = await supabase.auth.getUser()
        if (!mounted) return
        if (error || !userData.user || userData.user.id !== data.session.user.id) {
          await clearExpiredSession()
          if (!mounted) return
          setSession(null)
        } else {
          setSession(data.session)
        }
      } catch {
        if (mounted) setSession(null)
      } finally {
        if (mounted) setReady(true)
      }
    })()
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setReady(true)
    })
    return () => { mounted = false; listener.subscription.unsubscribe() }
  }, [])

  if (!ready) return <AppLaunchScreen />
  if (!supabase || !session) return <Suspense fallback={<AppLaunchScreen />}><AuthScreen /></Suspense>
  return <Fragment key={session?.user.id ?? "local"}>{children}</Fragment>
}

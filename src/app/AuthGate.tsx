import { Fragment, lazy, Suspense, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../shared/lib/supabase'
import { AppLaunchScreen } from '../shared/ui/AppLaunchScreen'

const AuthScreen = lazy(() => import('../features/auth/AuthScreen').then(module => ({ default: module.AuthScreen })))

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!supabase)

  useEffect(() => {
    if (!supabase) return
    let mounted = true
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) { setSession(data.session); setReady(true) }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setReady(true)
    })
    return () => { mounted = false; listener.subscription.unsubscribe() }
  }, [])

  if (!ready) return <AppLaunchScreen />
  if (supabase && !session) return <Suspense fallback={<AppLaunchScreen />}><AuthScreen /></Suspense>
  return <Fragment key={session?.user.id ?? "local"}>{children}</Fragment>
}

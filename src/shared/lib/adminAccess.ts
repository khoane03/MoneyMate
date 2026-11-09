import { supabase } from './supabase'

const ADMIN_ACCESS_TTL_MS = 60_000
let cachedAccess: { isAdmin: boolean; expiresAt: number } | null = null
let pendingCheck: Promise<boolean> | null = null
let authGeneration = 0

supabase?.auth.onAuthStateChange(() => {
  authGeneration += 1
  cachedAccess = null
  pendingCheck = null
})

/** Share the server-verified status between route protection and menu rendering. */
export async function hasAdminAccess(): Promise<boolean> {
  if (!supabase) return false
  if (cachedAccess && cachedAccess.expiresAt > Date.now()) return cachedAccess.isAdmin
  if (pendingCheck) return pendingCheck

  const generation = authGeneration
  const check = supabase.functions.invoke('admin', { body: { action: 'status' } })
    .then(({ data, error }) => {
      const isAdmin = !error && data?.is_admin === true
      if (generation === authGeneration) {
        cachedAccess = isAdmin ? { isAdmin: true, expiresAt: Date.now() + ADMIN_ACCESS_TTL_MS } : null
      }
      return isAdmin
    })
    .catch(() => false)
    .finally(() => {
      if (generation === authGeneration) pendingCheck = null
    })
  pendingCheck = check
  return check
}

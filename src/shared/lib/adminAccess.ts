import { supabase } from './supabase'

/** Ask the server's admin function; never infer privileges from client profile data. */
export async function hasAdminAccess(): Promise<boolean> {
  if (!supabase) return false
  const { data, error } = await supabase.functions.invoke('admin', { body: { action: 'status' } })
  return !error && data?.is_admin === true
}

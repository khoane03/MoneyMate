import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { parsePublicNoticeInput, parseSystemCategoryInput, parseUserPage } from '../../../src/shared/lib/adminValidation.ts'

function firstConfiguredKey(name: string): string {
  try {
    const keys: unknown = JSON.parse(Deno.env.get(name) ?? '{}')
    if (keys && typeof keys === 'object') {
      const match = Object.values(keys).find(value => typeof value === 'string')
      if (typeof match === 'string') return match
    }
  } catch { /* no multi-key environment configured */ }
  return ''
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? firstConfiguredKey('SUPABASE_PUBLISHABLE_KEYS')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? firstConfiguredKey('SUPABASE_SECRET_KEYS')
const configuredOrigins = (Deno.env.get('ADMIN_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean)
const allowedOrigins = new Set(['http://localhost:5173','http://127.0.0.1:5173',...configuredOrigins])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get('origin') ?? ''
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' })
  if (allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info')
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
  return new Response(JSON.stringify(data), { status, headers })
}

async function audit(admin: ReturnType<typeof createClient>, actorId: string, entity: string, entityId: string, action: string) {
  const source = `${entity}:${entityId}:${action}:${Date.now()}`
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(value => value.toString(16).padStart(2,'0')).join('')
  await admin.from('audit_events').insert({ actor_id: actorId, entity, entity_id: entityId, action, new_hash: hash })
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') ?? ''
  if (origin && !allowedOrigins.has(origin)) return json(request, { error: 'origin_not_allowed' }, 403)
  if (request.method === 'OPTIONS') return new Response('ok', { headers: {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin'
  } })
  if (request.method !== 'POST') return json(request, { error: 'method_not_allowed' }, 405)
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(request, { error: 'admin_function_not_configured' }, 503)

  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return json(request, { error: 'authentication_required' }, 401)
  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } } })
  const { data: userData, error: authError } = await userClient.auth.getUser(token)
  if (authError || !userData.user) return json(request, { error: 'authentication_required' }, 401)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: membership, error: membershipError } = await admin.from('admin_users').select('user_id').eq('user_id', userData.user.id).maybeSingle()
  if (membershipError) return json(request, { error: 'admin_schema_unavailable' }, 503)
  if (!membership) return json(request, { error: 'admin_access_required', user_id: userData.user.id }, 403)

  let body: Record<string, unknown>
  try {
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > 16_384) return json(request, { error: 'request_too_large' }, 413)
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(request, { error: 'invalid_request' }, 400)
    body = parsed as Record<string, unknown>
  } catch { return json(request, { error: 'invalid_request' }, 400) }

  switch (body.action) {
    case 'status':
      return json(request, { is_admin: true, user_id: userData.user.id })
    case 'list_users': {
      const page = parseUserPage(body.page ?? 1)
      if (!page) return json(request, { error: 'invalid_admin_page' }, 400)
      const perPage = 50
      const { data: memberships, error: membershipListError, count } = await admin.from('admin_users')
        .select('user_id,created_at', { count: 'exact' })
        .order('created_at', { ascending: false }).order('user_id', { ascending: false })
        .range((page - 1) * perPage, page * perPage - 1)
      if (membershipListError) return json(request, { error: 'admins_unavailable' }, 502)
      const users = await Promise.all((memberships ?? []).map(async membershipRow => {
        const { data, error } = await admin.auth.admin.getUserById(membershipRow.user_id)
        if (error || !data.user) return null
        const user = data.user
        return {
          id: user.id, email: user.email ?? '', created_at: user.created_at ?? membershipRow.created_at,
          last_sign_in_at: user.last_sign_in_at ?? null, email_confirmed_at: user.email_confirmed_at ?? null,
          banned_until: user.banned_until ?? null
        }
      }))
      if (users.some(user => user === null)) return json(request, { error: 'admin_account_details_unavailable' }, 502)
      return json(request, { users, page, has_more: (count ?? 0) > page * perPage })
    }
    case 'list_accounts': {
      const page = parseUserPage(body.page ?? 1)
      if (!page) return json(request, { error: 'invalid_account_page' }, 400)
      const perPage = 50
      const first = await admin.auth.admin.listUsers({ page: 1, perPage })
      if (first.error) return json(request, { error: 'accounts_unavailable' }, 502)
      const lastPage = Math.max(1, first.data.lastPage || Math.ceil(first.data.total / perPage))
      if (page > lastPage) return json(request, { users: [], page, has_more: false })
      const sourcePage = lastPage - page + 1
      const result = sourcePage === 1 ? first : await admin.auth.admin.listUsers({ page: sourcePage, perPage })
      if (result.error) return json(request, { error: 'accounts_unavailable' }, 502)
      const ids = result.data.users.map(user => user.id)
      const { data: admins, error: adminLookupError } = ids.length
        ? await admin.from('admin_users').select('user_id').in('user_id', ids)
        : { data: [], error: null }
      if (adminLookupError) return json(request, { error: 'admin_membership_check_failed' }, 502)
      const adminIds = new Set((admins ?? []).map(row => row.user_id))
      const users = result.data.users
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id.localeCompare(a.id))
        .map(user => ({
          id: user.id, email: user.email ?? '', created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at ?? null, email_confirmed_at: user.email_confirmed_at ?? null,
          banned_until: user.banned_until ?? null, is_admin: adminIds.has(user.id),
        }))
      return json(request, { users, page, has_more: page < lastPage })
    }
    case 'get_usage_metrics': {
      const { data: authPage, error: authPageError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
      if (authPageError) return json(request, { error: 'accounts_unavailable' }, 502)
      const { data: usage, error: usageError } = await admin.rpc('get_admin_usage_metrics', { p_actor_id: userData.user.id })
      if (usageError) return json(request, { error: 'usage_metrics_unavailable' }, 502)
      return json(request, { metrics: { total_accounts: authPage.total ?? 0, ...usage } })
    }
    case 'list_locked_users': {
      const first = await admin.auth.admin.listUsers({ page: 1, perPage: 50 })
      if (first.error) return json(request, { error: 'locked_users_unavailable' }, 502)
      const lastPage = Math.max(1, first.data.lastPage || Math.ceil(first.data.total / 50))
      const cursor = body.cursor === undefined || body.cursor === null ? lastPage : body.cursor
      if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 1 || cursor > lastPage) {
        return json(request, { error: 'invalid_locked_user_cursor' }, 400)
      }
      const users: Array<{ id: string; email: string; created_at: string; last_sign_in_at: string | null; email_confirmed_at: string | null; banned_until: string }> = []
      let scanPage = cursor
      while (scanPage >= 1 && users.length < 50) {
        const { data, error } = scanPage === 1 ? first : await admin.auth.admin.listUsers({ page: scanPage, perPage: 50 })
        if (error) return json(request, { error: 'locked_users_unavailable' }, 502)
        const locked = data.users.filter(user => user.banned_until && Date.parse(user.banned_until) > Date.now())
        const adminIds = locked.map(user => user.id)
        const adminMemberships = adminIds.length
          ? await admin.from('admin_users').select('user_id').in('user_id', adminIds)
          : { data: [], error: null }
        if (adminMemberships.error) return json(request, { error: 'admin_membership_check_failed' }, 502)
        const adminIdSet = new Set((adminMemberships.data ?? []).map(row => row.user_id))
        for (const user of locked) {
          if (adminIdSet.has(user.id)) continue
          users.push({
            id: user.id, email: user.email ?? '', created_at: user.created_at,
            last_sign_in_at: user.last_sign_in_at ?? null, email_confirmed_at: user.email_confirmed_at ?? null,
            banned_until: user.banned_until!,
          })
          if (users.length >= 50) break
        }
        scanPage -= 1
      }
      return json(request, { users, next_cursor: scanPage >= 1 ? scanPage : null, has_more: scanPage >= 1 })
    }
    case 'ban_user':
    case 'unban_user': {
      const targetId = body.user_id
      if (typeof targetId !== 'string' || !UUID.test(targetId) || targetId === userData.user.id) return json(request, { error: 'invalid_target_user' }, 400)
      const {data:targetAdmin,error:targetAdminError}=await admin.from('admin_users').select('user_id').eq('user_id',targetId).maybeSingle()
      if(targetAdminError)return json(request,{error:'admin_membership_check_failed'},502)
      if(targetAdmin)return json(request,{error:'cannot_modify_admin_account'},409)
      const { data, error } = await admin.auth.admin.updateUserById(targetId, { ban_duration: body.action === 'ban_user' ? '720h' : 'none' })
      if (error || !data.user) return json(request, { error: 'user_status_update_failed' }, 502)
      await audit(admin, userData.user.id, 'auth_user', targetId, body.action)
      return json(request, { user_id: data.user.id, banned_until: data.user.banned_until ?? null })
    }
    case 'list_categories': {
      const page = parseUserPage(body.page ?? 1)
      if (!page) return json(request, { error: 'invalid_category_page' }, 400)
      const perPage = 50
      const { data, error, count } = await admin.from('categories').select('id,kind,name,icon,color,created_at', { count: 'exact' })
        .is('owner_id',null).order('created_at', { ascending: false }).order('id', { ascending: false })
        .range((page - 1) * perPage, page * perPage - 1)
      if (error) return json(request, { error: 'categories_unavailable' }, 502)
      return json(request, { categories: data ?? [], page, has_more: (count ?? 0) > page * perPage })
    }
    case 'save_category': {
      const input = parseSystemCategoryInput(body.category)
      if (!input) return json(request, { error: 'invalid_category' }, 400)
      let query = admin.from('categories').select('id').is('owner_id',null).eq('kind',input.kind).eq('name',input.name)
      if (input.id) query = query.neq('id',input.id)
      const { data: duplicate, error: duplicateError } = await query.maybeSingle()
      if (duplicateError) return json(request, { error: 'category_check_failed' }, 502)
      if (duplicate) return json(request, { error: 'category_name_exists' }, 409)
      if (input.id) {
        const {data:existing,error:existingError}=await admin.from('categories').select('kind').eq('id',input.id).is('owner_id',null).maybeSingle()
        if(existingError)return json(request,{error:'category_check_failed'},502)
        if(!existing||existing.kind!==input.kind)return json(request,{error:'category_not_found_or_kind_change'},409)
        const { data: updated, error } = await admin.from('categories').update({ name:input.name, icon:input.icon, color:input.color }).eq('id',input.id).is('owner_id',null).select('id').maybeSingle()
        if (error || !updated) return json(request, { error: 'category_update_failed' }, 409)
        await audit(admin,userData.user.id,'system_category',input.id,'updated')
        return json(request,{id:updated.id})
      }
      const { data: inserted, error } = await admin.from('categories').insert({ owner_id:null, kind:input.kind, name:input.name, icon:input.icon, color:input.color }).select('id').single()
      if (error || !inserted) return json(request, { error: 'category_create_failed' }, 409)
      await audit(admin,userData.user.id,'system_category',inserted.id,'created')
      return json(request,{id:inserted.id})
    }
    case 'delete_category': {
      const id = body.category_id
      if (typeof id !== 'string' || !UUID.test(id)) return json(request, { error: 'invalid_category' }, 400)
      const { data: found, error: findError } = await admin.from('categories').select('id').eq('id',id).is('owner_id',null).maybeSingle()
      if (findError || !found) return json(request, { error: 'category_not_found' }, 404)
      const { error } = await admin.from('categories').delete().eq('id',id).is('owner_id',null)
      if (error) return json(request, { error: 'category_in_use_or_delete_failed' }, 409)
      await audit(admin,userData.user.id,'system_category',id,'deleted')
      return json(request,{id})
    }
    case 'get_public_settings': {
      const { data, error } = await admin.from('app_public_settings').select('notice_active,notice_title,notice_body,updated_at').eq('id',true).single()
      if (error || !data) return json(request, { error: 'settings_unavailable' }, 502)
      return json(request,{settings:data})
    }
    case 'save_public_settings': {
      const input = parsePublicNoticeInput(body.settings)
      if (!input) return json(request, { error: 'invalid_public_notice' }, 400)
      const { data: recipientsNotified, error: saveError } = await admin.rpc('save_public_notice_and_fanout', {
        p_actor_id: userData.user.id, p_active: input.active, p_title: input.title, p_body: input.body
      })
      if (saveError) return json(request, { error: 'settings_update_failed' }, 502)
      const { data, error } = await admin.from('app_public_settings').select('notice_active,notice_title,notice_body,updated_at').eq('id',true).single()
      if (error || !data) return json(request, { error: 'settings_unavailable' }, 502)
      await audit(admin,userData.user.id,'app_public_settings','00000000-0000-4000-8000-000000000000','notice_updated')
      return json(request,{settings:data,recipients_notified:recipientsNotified ?? 0})
    }
    default:
      return json(request, { error: 'unknown_admin_action' }, 400)
  }
})

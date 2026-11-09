import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

type Purpose = 'receipt' | 'transaction-evidence' | 'loan-evidence' | 'bill-checkin' | 'avatar'
type JsonRecord = Record<string, unknown>

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
const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME') ?? ''
const cloudinaryKey = Deno.env.get('CLOUDINARY_API_KEY') ?? ''
const cloudinarySecret = Deno.env.get('CLOUDINARY_API_SECRET') ?? ''
const configuredOrigins = (Deno.env.get('MEDIA_ALLOWED_ORIGINS') ?? Deno.env.get('ADMIN_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean)
const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', ...configuredOrigins])
const purposes = new Set<Purpose>(['receipt', 'transaction-evidence', 'loan-evidence', 'bill-checkin', 'avatar'])
const publicIdPattern = /^moneymate\/[0-9a-f-]{36}\/(receipt|transaction-evidence|loan-evidence|bill-checkin|avatar)\/[0-9a-f-]{36}$/i
const assetIdPattern = /^[A-Za-z0-9_-]{16,64}$/
const checksumPattern = /^[0-9a-f]{64}$/
const formatPattern = /^(jpe?g|png|webp)$/

function response(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get('origin') ?? ''
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' })
  if (allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info')
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
  return new Response(JSON.stringify(data), { status, headers })
}

async function sha1Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function signableValue(value: unknown) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

async function apiSignature(parameters: JsonRecord) {
  const serialized = Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${signableValue(value)}`).join('&')
  return sha1Hex(serialized + cloudinarySecret)
}

async function destroyCloudinary(publicId: string) {
  const timestamp = Math.floor(Date.now() / 1000)
  const parameters = { invalidate: true, public_id: publicId, timestamp, type: 'authenticated' }
  const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), api_key: cloudinaryKey, signature: await apiSignature(parameters) })
  const result = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, { method: 'POST', body })
  return result.ok
}

async function getCloudinaryResource(publicId: string) {
  const authorization = btoa(`${cloudinaryKey}:${cloudinarySecret}`)
  const result = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/resources/image/authenticated/${encodeURIComponent(publicId)}`, {
    headers: { Authorization: `Basic ${authorization}` },
  })
  if (!result.ok) return null
  const value: unknown = await result.json()
  return value && typeof value === 'object' ? value as JsonRecord : null
}

async function canReadShared(admin: ReturnType<typeof createClient>, actorId: string, publicId: string) {
  const { data: avatarRows } = await admin.from('connection_members').select('connection_id').eq('avatar_storage_path', publicId)
  const avatarConnections = (avatarRows ?? []).map(row => row.connection_id)
  if (avatarConnections.length) {
    const { data } = await admin.from('connection_members').select('connection_id,connections!inner(status)').eq('user_id', actorId).in('connection_id', avatarConnections).eq('connections.status', 'active').limit(1)
    if (data?.length) return true
  }
  const { data: checkin } = await admin.from('personal_bill_checkins').select('id').eq('storage_path', publicId).maybeSingle()
  if (checkin) {
    const { data: shares } = await admin.from('personal_bill_checkin_shares').select('connection_id').eq('checkin_id', checkin.id)
    const connections = (shares ?? []).map(row => row.connection_id)
    if (connections.length) {
      const { data } = await admin.from('connection_members').select('connection_id,connections!inner(status)').eq('user_id', actorId).in('connection_id', connections).eq('connections.status', 'active').limit(1)
      if (data?.length) return true
    }
  }
  const { data: evidence } = await admin.from('shared_loan_payment_evidence').select('shared_payment_id').eq('storage_path', publicId).maybeSingle()
  if (evidence) {
    const { data: payment } = await admin.from('shared_personal_loan_payments').select('shared_personal_loans!inner(connection_id)').eq('id', evidence.shared_payment_id).maybeSingle()
    const joined = payment?.shared_personal_loans as unknown as { connection_id?: string } | null
    if (joined?.connection_id) {
      const { data } = await admin.from('connection_members').select('connection_id,connections!inner(status)').eq('connection_id', joined.connection_id).eq('user_id', actorId).eq('connections.status', 'active').limit(1)
      if (data?.length) return true
    }
  }
  return false
}

async function isReferenced(admin: ReturnType<typeof createClient>, publicId: string) {
  const checks = await Promise.all([
    admin.from('receipts').select('id').eq('storage_path', publicId).limit(1),
    admin.from('transaction_evidence').select('transaction_id').eq('storage_path', publicId).limit(1),
    admin.from('personal_bill_checkins').select('id').eq('storage_path', publicId).limit(1),
    admin.from('shared_loan_payment_evidence').select('shared_payment_id').eq('storage_path', publicId).limit(1),
    admin.from('profiles').select('user_id').eq('avatar_storage_path', publicId).limit(1),
  ])
  return checks.some(result => (result.data?.length ?? 0) > 0)
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') ?? ''
  if (origin && !allowedOrigins.has(origin)) return response(request, { error: 'origin_not_allowed' }, 403)
  if (request.method === 'OPTIONS') return new Response('ok', { headers: {
    'Access-Control-Allow-Origin': origin || 'null', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin',
  } })
  if (request.method !== 'POST') return response(request, { error: 'method_not_allowed' }, 405)
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !cloudName || !cloudinaryKey || !cloudinarySecret) return response(request, { error: 'media_function_not_configured' }, 503)
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return response(request, { error: 'authentication_required' }, 401)
  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } } })
  const { data: userData, error: userError } = await userClient.auth.getUser(token)
  if (userError || !userData.user) return response(request, { error: 'authentication_required' }, 401)
  const actorId = userData.user.id
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let body: JsonRecord
  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > 16_384) return response(request, { error: 'request_too_large' }, 413)
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return response(request, { error: 'invalid_request' }, 400)
    body = parsed as JsonRecord
  } catch { return response(request, { error: 'invalid_request' }, 400) }

  const action = body.action
  if (action === 'prepare_upload') {
    const purpose = body.purpose
    const byteSize = body.byte_size
    const checksum = body.checksum
    const maxBytes = purpose === 'avatar' ? 3 * 1024 * 1024 : 15 * 1024 * 1024
    if (typeof purpose !== 'string' || !purposes.has(purpose as Purpose) || typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > maxBytes || (checksum !== null && checksum !== undefined && (typeof checksum !== 'string' || !checksumPattern.test(checksum)))) return response(request, { error: 'invalid_upload' }, 400)
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
    const { count } = await admin.from('media_assets').select('public_id', { count: 'exact', head: true }).eq('uploaded_by', actorId).gte('created_at', oneMinuteAgo)
    if ((count ?? 0) >= 10) return response(request, { error: 'upload_rate_limited' }, 429)
    const id = crypto.randomUUID()
    const publicId = `moneymate/${actorId}/${purpose}/${id}`
    const { error } = await admin.from('media_assets').insert({ public_id: publicId, uploaded_by: actorId, purpose, checksum: checksum ?? null, byte_size: byteSize, state: 'pending' })
    if (error) return response(request, { error: 'upload_reservation_failed' }, 409)
    const timestamp = Math.floor(Date.now() / 1000)
    const signed = { overwrite: false, public_id: publicId, timestamp, type: 'authenticated' }
    return response(request, { cloud_name: cloudName, api_key: cloudinaryKey, ...signed, overwrite: 'false', signature: await apiSignature(signed) })
  }

  const publicId = body.public_id
  if (typeof publicId !== 'string' || !publicIdPattern.test(publicId)) return response(request, { error: 'invalid_public_id' }, 400)
  const { data: asset, error: assetError } = await admin.from('media_assets').select('*').eq('public_id', publicId).maybeSingle()
  if (assetError || !asset) return response(request, { error: 'media_not_found' }, 404)

  if (action === 'complete_upload') {
    const assetId = body.asset_id
    const version = body.version
    const format = body.format
    const byteSize = body.byte_size
    const responseSignature = body.response_signature
    if (asset.uploaded_by !== actorId || asset.state !== 'pending' || typeof assetId !== 'string' || !assetIdPattern.test(assetId) || typeof version !== 'number' || !Number.isInteger(version) || typeof format !== 'string' || !formatPattern.test(format) || typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 1 || typeof responseSignature !== 'string') return response(request, { error: 'invalid_upload_completion' }, 400)
    const maxBytes = asset.purpose === 'avatar' ? 3 * 1024 * 1024 : 15 * 1024 * 1024
    const expectedSignature = await sha1Hex(`public_id=${publicId}&version=${version}${cloudinarySecret}`)
    const resource = await getCloudinaryResource(publicId)
    const resourceBytes = typeof resource?.bytes === 'number' ? resource.bytes : null
    const verified = resource && resource.public_id === publicId && resource.asset_id === assetId && resource.version === version
      && resource.resource_type === 'image' && resource.type === 'authenticated' && resource.format === format
      && resourceBytes !== null && Number.isInteger(resourceBytes) && resourceBytes > 0 && resourceBytes <= maxBytes
    if (responseSignature !== expectedSignature || !verified || byteSize !== resourceBytes || body.resource_type !== 'image') {
      await destroyCloudinary(publicId)
      await admin.from('media_assets').update({ state: 'deleted', deleted_at: new Date().toISOString() }).eq('public_id', publicId)
      return response(request, { error: 'upload_verification_failed' }, 400)
    }
    const { error } = await admin.from('media_assets').update({ asset_id: assetId, version, format, byte_size: resourceBytes, state: 'ready', ready_at: new Date().toISOString() }).eq('public_id', publicId).eq('uploaded_by', actorId).eq('state', 'pending')
    if (error) return response(request, { error: 'upload_completion_failed' }, 409)
    return response(request, { public_id: publicId })
  }

  if (action === 'cancel_upload') {
    if (asset.uploaded_by !== actorId || asset.state !== 'pending') return response(request, { error: 'media_not_cancellable' }, 409)
    await destroyCloudinary(publicId)
    await admin.from('media_assets').update({ state: 'deleted', deleted_at: new Date().toISOString() }).eq('public_id', publicId)
    return response(request, { public_id: publicId })
  }

  if (action === 'view') {
    if (asset.state !== 'ready') return response(request, { error: 'media_not_ready' }, 409)
    const allowed = asset.uploaded_by === actorId || await canReadShared(admin, actorId, publicId)
    if (!allowed) return response(request, { error: 'media_access_denied' }, 403)
    const requestedExpiry = typeof body.expires_in === 'number' && Number.isInteger(body.expires_in) ? body.expires_in : 1800
    const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(requestedExpiry, 60), 3600)
    const timestamp = Math.floor(Date.now() / 1000)
    const parameters = { expires_at: expiresAt, format: asset.format, public_id: publicId, timestamp, type: 'authenticated' }
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), api_key: cloudinaryKey, signature: await apiSignature(parameters) })
    return response(request, { url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/download?${query.toString()}`, expires_at: expiresAt })
  }

  if (action === 'delete') {
    if (asset.uploaded_by !== actorId) return response(request, { error: 'media_access_denied' }, 403)
    if (await isReferenced(admin, publicId)) return response(request, { error: 'media_still_referenced' }, 409)
    const deleted = asset.state === 'deleted' || await destroyCloudinary(publicId)
    if (!deleted) return response(request, { error: 'cloudinary_delete_failed' }, 502)
    await admin.from('media_assets').update({ state: 'deleted', deleted_at: new Date().toISOString() }).eq('public_id', publicId)
    return response(request, { public_id: publicId })
  }

  return response(request, { error: 'unknown_action' }, 400)
})

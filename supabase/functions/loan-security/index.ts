import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from 'npm:@simplewebauthn/server@13.2.2'

type JsonRecord = Record<string, unknown>
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
const rpId = Deno.env.get('LOAN_SECURITY_RP_ID') ?? ''
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(Deno.env.get('LOAN_SECURITY_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean),
])

function jsonResponse(request: Request, body: unknown, status = 200) {
  const origin = request.headers.get('origin') ?? ''
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  })
  if (allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info')
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
  return new Response(JSON.stringify(body), { status, headers })
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function objectValue(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function sessionIdFromToken(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
    const sessionId = objectValue(parsed)?.session_id
    return typeof sessionId === 'string' ? sessionId : null
  } catch {
    return null
  }
}

function originMatchesRp(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname
    return Boolean(rpId) && (hostname === rpId || hostname.endsWith(`.${rpId}`))
  } catch {
    return false
  }
}

function credentialResponse(value: unknown): JsonRecord | null {
  const credential = objectValue(value)
  const response = objectValue(credential?.response)
  if (credential?.type !== 'public-key' || typeof credential.id !== 'string'
    || typeof credential.rawId !== 'string' || credential.id !== credential.rawId || !response) return null
  return credential
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') ?? ''
  if (!origin || !allowedOrigins.has(origin) || !originMatchesRp(origin)) {
    return jsonResponse(request, { error: 'origin_not_allowed' }, 403)
  }
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    } })
  }
  if (request.method !== 'POST') return jsonResponse(request, { error: 'method_not_allowed' }, 405)
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !rpId) {
    return jsonResponse(request, { error: 'loan_security_function_not_configured' }, 503)
  }
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return jsonResponse(request, { error: 'authentication_required' }, 401)
  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userResult, error: authError } = await userClient.auth.getUser(token)
  if (authError || !userResult.user) return jsonResponse(request, { error: 'authentication_required' }, 401)
  const actor = userResult.user
  const sessionId = sessionIdFromToken(token)
  if (!sessionId) return jsonResponse(request, { error: 'invalid_session' }, 401)

  let body: JsonRecord
  try {
    const declaredLength = Number(request.headers.get('content-length') ?? 0)
    if (declaredLength > 48_000) return jsonResponse(request, { error: 'request_too_large' }, 413)
    const reader = request.body?.getReader()
    if (!reader) return jsonResponse(request, { error: 'invalid_request' }, 400)
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > 48_000) {
        await reader.cancel()
        return jsonResponse(request, { error: 'request_too_large' }, 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const raw = new TextDecoder().decode(bytes)
    const parsed: unknown = JSON.parse(raw)
    const record = objectValue(parsed)
    if (!record) return jsonResponse(request, { error: 'invalid_request' }, 400)
    body = record
  } catch {
    return jsonResponse(request, { error: 'invalid_request' }, 400)
  }

  const action = body.action
  if (action === 'registration-options') {
    const { data: credentials, error: credentialError } = await admin.from('loan_webauthn_credentials')
      .select('credential_id,transports').eq('owner_id', actor.id)
    if (credentialError) return jsonResponse(request, { error: 'credential_lookup_failed' }, 500)
    const options = await generateRegistrationOptions({
      rpName: 'MoneyMate',
      rpID: rpId,
      userID: new TextEncoder().encode(actor.id),
      userName: actor.email ?? actor.id,
      userDisplayName: 'MoneyMate',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: (credentials ?? []).map(credential => ({
        id: credential.credential_id,
        transports: credential.transports,
      })),
    })
    const { data: challengeId, error: challengeError } = await userClient.rpc('create_loan_webauthn_challenge', {
      p_challenge: options.challenge,
      p_purpose: 'register',
    })
    if (challengeError || typeof challengeId !== 'string') {
      return jsonResponse(request, { error: 'recent_authentication_required' }, 403)
    }
    return jsonResponse(request, { challengeId, options })
  }

  if (action === 'registration-verify') {
    const response = credentialResponse(body.credential)
    const challengeId = body.challengeId
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : ''
    if (!response || typeof challengeId !== 'string') return jsonResponse(request, { error: 'invalid_credential' }, 400)
    const { data: challenge, error: challengeError } = await userClient.rpc('consume_loan_webauthn_challenge', {
      p_challenge_id: challengeId,
      p_purpose: 'register',
    })
    if (challengeError || typeof challenge !== 'string') return jsonResponse(request, { error: 'challenge_expired' }, 403)
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      })
    } catch {
      return jsonResponse(request, { error: 'credential_verification_failed' }, 400)
    }
    if (!verification.verified || !verification.registrationInfo) {
      return jsonResponse(request, { error: 'credential_verification_failed' }, 400)
    }
    const credential = verification.registrationInfo.credential
    const { error: saveError } = await admin.from('loan_webauthn_credentials').insert({
      credential_id: credential.id,
      owner_id: actor.id,
      public_key: encodeBase64Url(credential.publicKey),
      sign_count: credential.counter,
      transports: credential.transports ?? [],
      display_name: displayName || 'Passkey',
    })
    if (saveError) return jsonResponse(request, { error: 'credential_save_failed' }, 500)
    const { error: grantError } = await admin.rpc('grant_loan_step_up_internal', {
      p_actor: actor.id,
      p_session_id: sessionId,
      p_method: 'passkey',
      p_enable: true,
    })
    if (grantError) return jsonResponse(request, { error: 'step_up_grant_failed' }, 500)
    return jsonResponse(request, { verified: true })
  }

  if (action === 'authentication-options') {
    const { data: credentials, error: credentialError } = await admin.from('loan_webauthn_credentials')
      .select('credential_id,transports').eq('owner_id', actor.id)
    if (credentialError) return jsonResponse(request, { error: 'credential_lookup_failed' }, 500)
    if (!credentials?.length) return jsonResponse(request, { error: 'passkey_not_configured' }, 404)
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials: credentials.map(credential => ({
        id: credential.credential_id,
        transports: credential.transports,
      })),
    })
    const { data: challengeId, error: challengeError } = await userClient.rpc('create_loan_webauthn_challenge', {
      p_challenge: options.challenge,
      p_purpose: 'authenticate',
    })
    if (challengeError || typeof challengeId !== 'string') return jsonResponse(request, { error: 'challenge_failed' }, 403)
    return jsonResponse(request, { challengeId, options })
  }

  if (action === 'authentication-verify') {
    const response = credentialResponse(body.credential)
    const challengeId = body.challengeId
    if (!response || typeof challengeId !== 'string') return jsonResponse(request, { error: 'invalid_credential' }, 400)
    const { data: challenge, error: challengeError } = await userClient.rpc('consume_loan_webauthn_challenge', {
      p_challenge_id: challengeId,
      p_purpose: 'authenticate',
    })
    if (challengeError || typeof challenge !== 'string') return jsonResponse(request, { error: 'challenge_expired' }, 403)
    const { data: stored, error: lookupError } = await admin.from('loan_webauthn_credentials')
      .select('credential_id,owner_id,public_key,sign_count,transports')
      .eq('owner_id', actor.id).eq('credential_id', response.id).maybeSingle()
    if (lookupError || !stored) return jsonResponse(request, { error: 'credential_not_found' }, 403)
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: stored.credential_id,
          publicKey: decodeBase64Url(stored.public_key),
          counter: Number(stored.sign_count),
          transports: stored.transports,
        },
        requireUserVerification: true,
      })
    } catch {
      return jsonResponse(request, { error: 'credential_verification_failed' }, 400)
    }
    if (!verification.verified) return jsonResponse(request, { error: 'credential_verification_failed' }, 400)
    const { error: updateError } = await admin.from('loan_webauthn_credentials')
      .update({
        sign_count: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq('owner_id', actor.id).eq('credential_id', stored.credential_id)
    if (updateError) return jsonResponse(request, { error: 'credential_update_failed' }, 500)
    const { error: grantError } = await admin.rpc('grant_loan_step_up_internal', {
      p_actor: actor.id,
      p_session_id: sessionId,
      p_method: 'passkey',
      p_enable: false,
    })
    if (grantError) return jsonResponse(request, { error: 'step_up_grant_failed' }, 403)
    return jsonResponse(request, { verified: true })
  }

  return jsonResponse(request, { error: 'unknown_action' }, 400)
})

import { supabase } from '../../shared/lib/supabase'

export type LoanSecurityStatus = {
  enabled: boolean
  pinConfigured: boolean
  passkeyCount: number
  pinLocked: boolean
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function getLoanSecurityStatus(): Promise<LoanSecurityStatus> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { data, error } = await supabase.rpc('loan_security_status')
  if (error) throw error
  if (!isRecord(data) || typeof data.enabled !== 'boolean'
    || typeof data.pinConfigured !== 'boolean' || typeof data.passkeyCount !== 'number'
    || typeof data.pinLocked !== 'boolean') {
    throw new Error('Phản hồi trạng thái bảo mật không hợp lệ.')
  }
  return {
    enabled: data.enabled,
    pinConfigured: data.pinConfigured,
    passkeyCount: data.passkeyCount,
    pinLocked: data.pinLocked,
  }
}

export async function reauthenticateWithPassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { data: userResult, error: userError } = await supabase.auth.getUser()
  if (userError || !userResult.user?.email) throw new Error('Không xác định được email tài khoản để xác thực lại.')
  const { error } = await supabase.auth.signInWithPassword({ email: userResult.user.email, password })
  if (error) throw error
}

export async function setLoanPin(pin: string): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { error } = await supabase.rpc('set_loan_security_pin', { p_pin: pin })
  if (error) throw error
}

export async function unlockLoansWithPin(pin: string): Promise<{ unlocked: boolean; locked: boolean }> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { data, error } = await supabase.rpc('unlock_loans_with_pin', { p_pin: pin })
  if (error) throw error
  if (!isRecord(data) || typeof data.unlocked !== 'boolean' || typeof data.locked !== 'boolean') {
    throw new Error('Phản hồi mở khóa PIN không hợp lệ.')
  }
  return { unlocked: data.unlocked, locked: data.locked }
}

export async function unlockLoansWithPassword(password: string): Promise<void> {
  await reauthenticateWithPassword(password)
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { error } = await supabase.rpc('unlock_loans_with_password')
  if (error) throw error
}

export async function disableLoanSecurity(password: string): Promise<void> {
  await reauthenticateWithPassword(password)
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { error } = await supabase.rpc('disable_loan_security')
  if (error) throw error
}

export async function lockLoansNow(): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('lock_loans_now')
  if (error) throw error
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function callPasskeyFunction<T>(body: JsonRecord): Promise<T> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ tài khoản.')
  const { data, error } = await supabase.functions.invoke('loan-security', { body })
  if (error) throw error
  if (!isRecord(data)) throw new Error('Dịch vụ passkey trả về dữ liệu không hợp lệ.')
  if (typeof data.error === 'string') throw new Error(data.error)
  return data as T
}

type PublicKeyOptionsJson = {
  challenge: string
  rp: PublicKeyCredentialRpEntity
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  timeout?: number
  attestation?: AttestationConveyancePreference
  authenticatorSelection?: AuthenticatorSelectionCriteria
  excludeCredentials?: Array<{
    id: string
    type: 'public-key'
    transports?: AuthenticatorTransport[]
  }>
  extensions?: AuthenticationExtensionsClientInputs
}

function toCreationOptions(json: PublicKeyOptionsJson): PublicKeyCredentialCreationOptions {
  const { user, excludeCredentials, challenge, ...options } = json
  return {
    ...options,
    challenge: decodeBase64Url(challenge),
    user: { ...user, id: decodeBase64Url(user.id) },
    excludeCredentials: excludeCredentials?.map(credential => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  }
}

function toRequestOptions(json: PublicKeyOptionsOptionsJson): PublicKeyCredentialRequestOptions {
  const { allowCredentials, challenge, ...options } = json
  return {
    ...options,
    challenge: decodeBase64Url(challenge),
    allowCredentials: allowCredentials?.map(credential => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  }
}

type PublicKeyOptionsOptionsJson = {
  challenge: string
  rpId: string
  timeout?: number
  userVerification?: UserVerificationRequirement
  allowCredentials?: Array<{
    id: string
    type: 'public-key'
    transports?: AuthenticatorTransport[]
  }>
  extensions?: AuthenticationExtensionsClientInputs
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.isSecureContext || !('PublicKeyCredential' in window)
    || typeof navigator === 'undefined' || !navigator.credentials?.create || !navigator.credentials?.get) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export async function registerLoanPasskey(displayName: string): Promise<void> {
  const { challengeId, options } = await callPasskeyFunction<{ challengeId: string; options: PublicKeyOptionsJson }>({
    action: 'registration-options',
  })
  const credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey registration was cancelled.')
  const response = credential.response as AuthenticatorAttestationResponse
  await callPasskeyFunction({
    action: 'registration-verify',
    challengeId,
    displayName,
    credential: {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      response: {
        attestationObject: encodeBase64Url(response.attestationObject),
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
        transports: response.getTransports(),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    },
  })
}

export async function unlockLoansWithPasskey(): Promise<void> {
  const { challengeId, options } = await callPasskeyFunction<{ challengeId: string; options: PublicKeyOptionsOptionsJson }>({
    action: 'authentication-options',
  })
  const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey authentication was cancelled.')
  const response = credential.response as AuthenticatorAssertionResponse
  await callPasskeyFunction({
    action: 'authentication-verify',
    challengeId,
    credential: {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      response: {
        authenticatorData: encodeBase64Url(response.authenticatorData),
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
        signature: encodeBase64Url(response.signature),
        userHandle: response.userHandle ? encodeBase64Url(response.userHandle) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    },
  })
}

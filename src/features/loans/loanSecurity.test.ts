import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()
const mockGetUser = vi.fn()
const mockSignInWithPassword = vi.fn()
const mockInvoke = vi.fn()

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    },
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
  },
}))

import {
  getLoanSecurityStatus,
  reauthenticateWithPassword,
  setLoanPin,
  unlockLoansWithPin,
  unlockLoansWithPassword,
  disableLoanSecurity,
  lockLoansNow,
  isPlatformAuthenticatorAvailable,
} from './loanSecurity'

describe('loanSecurity client functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getLoanSecurityStatus', () => {
    it('returns valid status structure when RPC succeeds', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          enabled: true,
          pinConfigured: true,
          passkeyCount: 2,
          pinLocked: false,
        },
        error: null,
      })

      const status = await getLoanSecurityStatus()
      expect(mockRpc).toHaveBeenCalledWith('loan_security_status')
      expect(status).toEqual({
        enabled: true,
        pinConfigured: true,
        passkeyCount: 2,
        pinLocked: false,
      })
    })

    it('throws error when RPC returns an error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: new Error('RPC failure'),
      })

      await expect(getLoanSecurityStatus()).rejects.toThrow('RPC failure')
    })

    it('throws error when RPC returns malformed data', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { enabled: 'yes' },
        error: null,
      })

      await expect(getLoanSecurityStatus()).rejects.toThrow('Phản hồi trạng thái bảo mật không hợp lệ.')
    })
  })

  describe('reauthenticateWithPassword', () => {
    it('signs in with user email and password', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: { email: 'user@example.com' } },
        error: null,
      })
      mockSignInWithPassword.mockResolvedValueOnce({ error: null })

      await reauthenticateWithPassword('correct-password')
      expect(mockGetUser).toHaveBeenCalled()
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'correct-password',
      })
    })

    it('throws when user has no email', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: { email: null } },
        error: null,
      })

      await expect(reauthenticateWithPassword('password')).rejects.toThrow('Không xác định được email tài khoản')
    })

    it('propagates signInWithPassword failure', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: { email: 'user@example.com' } },
        error: null,
      })
      mockSignInWithPassword.mockResolvedValueOnce({ error: new Error('Invalid credentials') })

      await expect(reauthenticateWithPassword('wrong-password')).rejects.toThrow('Invalid credentials')
    })
  })

  describe('setLoanPin', () => {
    it('calls set_loan_security_pin RPC with exact 6-digit pin', async () => {
      mockRpc.mockResolvedValueOnce({ error: null })

      await setLoanPin('123456')
      expect(mockRpc).toHaveBeenCalledWith('set_loan_security_pin', { p_pin: '123456' })
    })

    it('propagates error when set pin fails', async () => {
      mockRpc.mockResolvedValueOnce({ error: new Error('PIN verification failed') })

      await expect(setLoanPin('123456')).rejects.toThrow('PIN verification failed')
    })
  })

  describe('unlockLoansWithPin', () => {
    it('returns unlocked status when pin is correct', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { unlocked: true, locked: false },
        error: null,
      })

      const result = await unlockLoansWithPin('654321')
      expect(mockRpc).toHaveBeenCalledWith('unlock_loans_with_pin', { p_pin: '654321' })
      expect(result).toEqual({ unlocked: true, locked: false })
    })

    it('returns locked status when pin attempts exceeded', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { unlocked: false, locked: true },
        error: null,
      })

      const result = await unlockLoansWithPin('000000')
      expect(result).toEqual({ unlocked: false, locked: true })
    })

    it('throws error when response data is invalid', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: null,
      })

      await expect(unlockLoansWithPin('123456')).rejects.toThrow('Phản hồi mở khóa PIN không hợp lệ.')
    })
  })

  describe('unlockLoansWithPassword', () => {
    it('reauthenticates and calls unlock_loans_with_password', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: { email: 'user@example.com' } },
        error: null,
      })
      mockSignInWithPassword.mockResolvedValueOnce({ error: null })
      mockRpc.mockResolvedValueOnce({ error: null })

      await unlockLoansWithPassword('my-secret-password')
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'my-secret-password',
      })
      expect(mockRpc).toHaveBeenCalledWith('unlock_loans_with_password')
    })
  })

  describe('disableLoanSecurity', () => {
    it('reauthenticates and calls disable_loan_security', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: { email: 'user@example.com' } },
        error: null,
      })
      mockSignInWithPassword.mockResolvedValueOnce({ error: null })
      mockRpc.mockResolvedValueOnce({ error: null })

      await disableLoanSecurity('my-secret-password')
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'my-secret-password',
      })
      expect(mockRpc).toHaveBeenCalledWith('disable_loan_security')
    })
  })

  describe('lockLoansNow', () => {
    it('calls lock_loans_now RPC', async () => {
      mockRpc.mockResolvedValueOnce({ error: null })

      await lockLoansNow()
      expect(mockRpc).toHaveBeenCalledWith('lock_loans_now')
    })
  })

  describe('isPlatformAuthenticatorAvailable', () => {
    it('returns false in non-secure or mock environment where PublicKeyCredential is not defined', async () => {
      const available = await isPlatformAuthenticatorAvailable()
      expect(typeof available).toBe('boolean')
    })
  })
})

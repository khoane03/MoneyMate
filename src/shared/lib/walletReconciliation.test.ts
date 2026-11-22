import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()
const mockFrom = vi.fn()
const mockGetUser = vi.fn()
const mockDispatchEvent = vi.fn()

// Mock window for node environment
globalThis.window = {
  dispatchEvent: mockDispatchEvent,
} as unknown as Window & typeof globalThis

globalThis.CustomEvent = class CustomEvent {
  type: string
  constructor(type: string) {
    this.type = type
  }
} as unknown as typeof CustomEvent

vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}))

import {
  reconcileWalletBalance,
  updatePersonalTransaction,
  deletePersonalTransaction,
  updateWallet,
  deleteWallet,
} from './walletReconciliation'

describe('walletReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('reconcileWalletBalance', () => {
    it('uses RPC when available and dispatches financial change event', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          success: true,
          difference: '100000',
          current_balance: '500000',
        },
        error: null,
      })

      const result = await reconcileWalletBalance('wallet-1', '500000', '2026-11-22', 'Test adjust')
      expect(mockRpc).toHaveBeenCalledWith('reconcile_wallet_balance', expect.objectContaining({
        p_wallet_id: 'wallet-1',
        p_target_balance: '500000',
        p_accounting_date: '2026-11-22',
        p_note: 'Test adjust',
      }))
      expect(result.success).toBe(true)
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('falls back to create_personal_transaction RPC when reconcile_wallet_balance is not available', async () => {
      mockRpc
        .mockResolvedValueOnce({
          data: null,
          error: new Error('RPC not found'),
        })
        .mockResolvedValueOnce({
          data: { id: 'created-tx-id' },
          error: null,
        })

      // Mock wallet_balances query
      const selectWalletBalances = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { current_balance_bigint: '300000' },
            error: null,
          }),
        }),
      })

      mockFrom.mockImplementation((table: string) => {
        if (table === 'wallet_balances') return { select: selectWalletBalances }
        return {}
      })

      const result = await reconcileWalletBalance('wallet-1', '500000', '2026-11-22')
      expect(result.difference).toBe('200000')
      expect(result.current_balance).toBe('500000')
      expect(result.transaction_id).toBe('created-tx-id')
      expect(mockRpc).toHaveBeenCalledWith('create_personal_transaction', expect.objectContaining({
        p_wallet_id: 'wallet-1',
        p_kind: 'income',
        p_amount_bigint: '200000',
      }))
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('creates expense transaction when target balance is lower than current balance in fallback', async () => {
      mockRpc
        .mockResolvedValueOnce({
          data: null,
          error: new Error('RPC not found'),
        })
        .mockResolvedValueOnce({
          data: { id: 'created-tx-0' },
          error: null,
        })

      const selectWalletBalances = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { current_balance_bigint: '500000' },
            error: null,
          }),
        }),
      })

      mockFrom.mockImplementation((table: string) => {
        if (table === 'wallet_balances') return { select: selectWalletBalances }
        return {}
      })

      const result = await reconcileWalletBalance('wallet-1', '0', '2026-11-22')
      expect(result.difference).toBe('-500000')
      expect(result.current_balance).toBe('0')
      expect(result.transaction_id).toBe('created-tx-0')
      expect(mockRpc).toHaveBeenCalledWith('create_personal_transaction', expect.objectContaining({
        p_wallet_id: 'wallet-1',
        p_kind: 'expense',
        p_amount_bigint: '500000',
      }))
    })

    it('falls back to direct table insert when both RPCs are not available', async () => {
      mockRpc
        .mockResolvedValueOnce({
          data: null,
          error: new Error('RPC not found'),
        })
        .mockResolvedValueOnce({
          data: null,
          error: new Error('create_personal_transaction RPC not found'),
        })

      const selectWalletBalances = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { current_balance_bigint: '300000' },
            error: null,
          }),
        }),
      })

      const insertTransaction = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'new-tx-id' },
            error: null,
          }),
        }),
      })

      mockFrom.mockImplementation((table: string) => {
        if (table === 'wallet_balances') return { select: selectWalletBalances }
        if (table === 'transactions') return { insert: insertTransaction }
        return {}
      })

      mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } })

      const result = await reconcileWalletBalance('wallet-1', '500000', '2026-11-22')
      expect(result.difference).toBe('200000')
      expect(result.current_balance).toBe('500000')
      expect(insertTransaction).toHaveBeenCalledWith(expect.objectContaining({
        wallet_id: 'wallet-1',
        kind: 'income',
        amount_bigint: '200000',
      }))
      expect(mockDispatchEvent).toHaveBeenCalled()
    })
  })

  describe('updatePersonalTransaction', () => {
    it('calls RPC when available and dispatches event', async () => {
      mockRpc.mockResolvedValueOnce({ error: null })

      await updatePersonalTransaction({
        id: 'tx-1',
        amount: '150000',
        date: '2026-11-22',
        note: 'Updated note',
      })

      expect(mockRpc).toHaveBeenCalledWith('update_personal_transaction', expect.objectContaining({
        p_id: 'tx-1',
        p_amount_bigint: '150000',
        p_accounting_date: '2026-11-22',
        p_note: 'Updated note',
      }))
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('falls back to direct table update when RPC is unavailable', async () => {
      mockRpc.mockResolvedValueOnce({ error: new Error('RPC not found') })

      const updateEq = vi.fn().mockResolvedValue({ error: null })
      const updateMock = vi.fn().mockReturnValue({ eq: updateEq })

      mockFrom.mockReturnValue({ update: updateMock })

      await updatePersonalTransaction({
        id: 'tx-1',
        amount: '200000',
        date: '2026-11-22',
        note: 'Fallback updated note',
      })

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        amount_bigint: '200000',
        accounting_date: '2026-11-22',
        note: 'Fallback updated note',
      }))
      expect(updateEq).toHaveBeenCalledWith('id', 'tx-1')
      expect(mockDispatchEvent).toHaveBeenCalled()
    })
  })

  describe('deletePersonalTransaction', () => {
    it('calls RPC when available and dispatches event', async () => {
      mockRpc.mockResolvedValueOnce({ error: null })

      await deletePersonalTransaction('tx-1')
      expect(mockRpc).toHaveBeenCalledWith('delete_personal_transaction', { p_id: 'tx-1' })
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('falls back to direct table delete when RPC is unavailable', async () => {
      mockRpc.mockResolvedValueOnce({ error: new Error('RPC not found') })

      const deleteEq = vi.fn().mockResolvedValue({ error: null })
      const deleteMock = vi.fn().mockReturnValue({ eq: deleteEq })

      mockFrom.mockReturnValue({ delete: deleteMock })

      await deletePersonalTransaction('tx-1')
      expect(deleteEq).toHaveBeenCalledWith('id', 'tx-1')
      expect(mockDispatchEvent).toHaveBeenCalled()
    })
  })

  describe('updateWallet', () => {
    it('uses RPC when available and dispatches financial change event', async () => {
      mockRpc.mockResolvedValueOnce({ error: null, data: { success: true } })

      await updateWallet({
        id: 'w-1',
        displayName: 'Ví chính',
        kind: 'bank',
        openingBalance: '100000',
        status: 'active',
      })

      expect(mockRpc).toHaveBeenCalledWith('update_wallet', {
        p_id: 'w-1',
        p_display_name: 'Ví chính',
        p_kind: 'bank',
        p_opening_balance: '100000',
        p_status: 'active',
      })
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('falls back to direct table update when RPC is unavailable', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'function does not exist' }, data: null })
      const updateEq = vi.fn().mockResolvedValue({ error: null })
      const updateMock = vi.fn().mockReturnValue({ eq: updateEq })
      mockFrom.mockReturnValue({ update: updateMock })

      await updateWallet({
        id: 'w-1',
        displayName: 'Ví chính',
        kind: 'bank',
        status: 'active',
      })

      expect(mockFrom).toHaveBeenCalledWith('wallets')
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        display_name: 'Ví chính',
        kind: 'bank',
        status: 'active',
      }))
      expect(updateEq).toHaveBeenCalledWith('id', 'w-1')
      expect(mockDispatchEvent).toHaveBeenCalled()
    })
  })

  describe('deleteWallet', () => {
    it('uses RPC when available and dispatches financial change event', async () => {
      mockRpc.mockResolvedValueOnce({ error: null, data: { success: true } })

      await deleteWallet('w-1')

      expect(mockRpc).toHaveBeenCalledWith('delete_wallet', { p_id: 'w-1' })
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('falls back to direct delete when RPC is unavailable', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'function does not exist' }, data: null })
      const deleteEq = vi.fn().mockResolvedValue({ error: null })
      const deleteMock = vi.fn().mockReturnValue({ eq: deleteEq })
      mockFrom.mockReturnValue({ delete: deleteMock })

      await deleteWallet('w-1')

      expect(mockFrom).toHaveBeenCalledWith('wallets')
      expect(deleteEq).toHaveBeenCalledWith('id', 'w-1')
      expect(mockDispatchEvent).toHaveBeenCalled()
    })

    it('throws friendly error when wallet has foreign key transactions', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'function does not exist' }, data: null })
      const deleteEq = vi.fn().mockResolvedValue({
        error: { code: '23503', message: 'foreign key constraint "transactions_wallet_id_fkey" violated' }
      })
      const deleteMock = vi.fn().mockReturnValue({ eq: deleteEq })
      mockFrom.mockReturnValue({ delete: deleteMock })

      await expect(deleteWallet('w-1')).rejects.toThrow('Ví này đã có giao dịch phát sinh')
    })
  })
})

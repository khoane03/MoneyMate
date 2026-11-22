import { supabase } from './supabase'
import { createUuid } from './uuid'

function parseBigIntSafe(val: unknown): bigint {
  if (typeof val === 'bigint') return val
  if (typeof val === 'number') return BigInt(Math.round(val))
  const parts = String(val ?? '0').trim().split('.')
  const str = (parts[0] ?? '0').replace(/[^0-9-]/g, '')
  return str === '' || str === '-' ? 0n : BigInt(str)
}

function notifyFinancialChange() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('moneymate:financial-change'))
  }
}

export type ReconcileResult = {
  success: boolean
  difference: string
  current_balance: string
  transaction_id?: string
}

export type UpdateTransactionInput = {
  id: string
  walletId?: string | null
  amount: string
  date: string
  categoryId?: string | null
  note?: string
  loanLenderName?: string | null
  loanPurpose?: string | null
}

export async function reconcileWalletBalance(
  walletId: string,
  targetBalance: string,
  accountingDate: string,
  note = 'Điều chỉnh số dư ví'
): Promise<ReconcileResult> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ.')

  // Try RPC first
  const { data, error } = await supabase.rpc('reconcile_wallet_balance', {
    p_wallet_id: walletId,
    p_target_balance: targetBalance,
    p_accounting_date: accountingDate,
    p_note: note,
    p_idempotency_key: createUuid(),
  })

  if (!error && data) {
    notifyFinancialChange()
    return data as ReconcileResult
  }

  // Fallback: Compute difference client-side
  const { data: balanceData, error: balanceError } = await supabase
    .from('wallet_balances')
    .select('current_balance_bigint')
    .eq('id', walletId)
    .single()

  let currentBalanceStr = balanceData?.current_balance_bigint
  if (balanceError || currentBalanceStr === undefined || currentBalanceStr === null) {
    const { data: walletData } = await supabase
      .from('wallets')
      .select('opening_balance_bigint')
      .eq('id', walletId)
      .single()
    currentBalanceStr = walletData?.opening_balance_bigint ?? '0'
  }

  const currentBalance = parseBigIntSafe(currentBalanceStr)
  const target = parseBigIntSafe(targetBalance)
  const diff = target - currentBalance

  if (diff === 0n) {
    return { success: true, difference: '0', current_balance: targetBalance }
  }

  const isIncome = diff > 0n
  const amountToAdjust = isIncome ? diff : -diff
  const occurredAt = new Date(`${accountingDate}T12:00:00+07:00`).toISOString()
  const idempotencyKey = createUuid()

  // Primary fallback: use create_personal_transaction RPC which already exists on database
  const rpcResult = await supabase.rpc('create_personal_transaction', {
    p_wallet_id: walletId,
    p_kind: isIncome ? 'income' : 'expense',
    p_amount_bigint: amountToAdjust.toString(),
    p_occurred_at: occurredAt,
    p_accounting_date: accountingDate,
    p_category_id: null,
    p_note: note.trim() || 'Điều chỉnh số dư ví',
    p_idempotency_key: idempotencyKey,
    p_affects_outstanding: false,
    p_loan_connection_id: null,
    p_loan_counterparty_id: null,
    p_loan_lender_name: null,
    p_loan_purpose: null,
    p_affects_wallet: true,
    p_loan_origin_transaction_id: null,
    p_share_with_counterparty: false,
  })

  const rpcData = rpcResult?.data
  const rpcError = rpcResult?.error

  if (!rpcError && rpcData) {
    notifyFinancialChange()
    return {
      success: true,
      difference: diff.toString(),
      current_balance: targetBalance,
      transaction_id: (rpcData as { id?: string })?.id,
    }
  }

  // Secondary fallback: direct insert if permissions allow
  const { data: insertData, error: insertError } = await supabase
    .from('transactions')
    .insert({
      owner_id: (await supabase.auth.getUser()).data.user?.id,
      wallet_id: walletId,
      kind: isIncome ? 'income' : 'expense',
      amount_bigint: amountToAdjust.toString(),
      occurred_at: occurredAt,
      accounting_date: accountingDate,
      note: note.trim() || 'Điều chỉnh số dư ví',
      idempotency_key: idempotencyKey,
      affects_outstanding: false,
      affects_wallet: true,
    })
    .select('id')
    .single()

  if (insertError) {
    const errorMsg = rpcError?.message || insertError?.message || 'Không thể tạo bút toán điều chỉnh.'
    throw new Error(errorMsg)
  }

  notifyFinancialChange()
  return {
    success: true,
    difference: diff.toString(),
    current_balance: targetBalance,
    transaction_id: insertData?.id,
  }
}

export async function updatePersonalTransaction(input: UpdateTransactionInput): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ.')

  // Try RPC first
  const { error: rpcError } = await supabase.rpc('update_personal_transaction', {
    p_id: input.id,
    p_wallet_id: input.walletId || null,
    p_amount_bigint: input.amount,
    p_accounting_date: input.date,
    p_category_id: input.categoryId || null,
    p_note: input.note ?? '',
    p_loan_lender_name: input.loanLenderName || null,
    p_loan_purpose: input.loanPurpose || null,
  })

  if (!rpcError) {
    notifyFinancialChange()
    return
  }

  // Fallback: direct update
  const occurredAt = new Date(`${input.date}T12:00:00+07:00`).toISOString()
  const updatePayload: Record<string, unknown> = {
    amount_bigint: input.amount,
    accounting_date: input.date,
    occurred_at: occurredAt,
    note: input.note ?? '',
    updated_at: new Date().toISOString(),
  }

  if (input.walletId !== undefined) {
    updatePayload.wallet_id = input.walletId || null
  }
  if (input.categoryId !== undefined) {
    updatePayload.category_id = input.categoryId || null
  }
  if (input.loanLenderName !== undefined) {
    updatePayload.loan_lender_name = input.loanLenderName || null
  }
  if (input.loanPurpose !== undefined) {
    updatePayload.loan_purpose = input.loanPurpose || null
  }

  const { error: directError } = await supabase
    .from('transactions')
    .update(updatePayload)
    .eq('id', input.id)

  if (directError) throw directError

  notifyFinancialChange()
}

export async function deletePersonalTransaction(id: string): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ.')

  // Try RPC first
  const { error: rpcError } = await supabase.rpc('delete_personal_transaction', {
    p_id: id,
  })

  if (!rpcError) {
    notifyFinancialChange()
    return
  }

  // Fallback: direct delete
  const { error: directError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', id)

  if (directError) throw directError

  notifyFinancialChange()
}

export type UpdateWalletInput = {
  id: string
  displayName: string
  kind: 'cash' | 'bank' | 'ewallet' | 'credit'
  openingBalance?: string
  status?: 'active' | 'archived'
}

export async function updateWallet(input: UpdateWalletInput): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ.')
  const updatePayload: Record<string, unknown> = {
    display_name: input.displayName.trim(),
    kind: input.kind,
    ...(input.status ? { status: input.status } : {}),
    updated_at: new Date().toISOString(),
  }
  if (input.openingBalance !== undefined) {
    updatePayload.opening_balance_bigint = input.openingBalance
  }
  const { error } = await supabase
    .from('wallets')
    .update(updatePayload)
    .eq('id', input.id)

  if (error) throw error
  notifyFinancialChange()
}

export async function deleteWallet(walletId: string): Promise<void> {
  if (!supabase) throw new Error('Chưa kết nối dịch vụ.')
  const { error } = await supabase
    .from('wallets')
    .delete()
    .eq('id', walletId)

  if (error) {
    const errorMsg = error.message || ''
    if (error.code === '23503' || errorMsg.includes('foreign key') || errorMsg.includes('violates foreign key constraint')) {
      throw new Error('Ví này đã có giao dịch phát sinh, không thể xóa trực tiếp. Bạn có thể chọn Lưu trữ ví thay vì xóa.')
    }
    throw error
  }
  notifyFinancialChange()
}

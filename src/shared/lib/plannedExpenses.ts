import { db, type LocalRecord, type OutboxCommand } from '../../data/local/database'
import { supabase } from './supabase'

export type PlannedExpenseStatus = 'planned' | 'converted' | 'skipped' | 'cancelled'
export type PlannedExpense = {
  id: string
  amount_bigint: string
  expected_date: string
  category_id: string | null
  wallet_id: string | null
  note: string
  reminder_days: number
  status: PlannedExpenseStatus
  converted_transaction_id: string | null
  version: number
  created_at: string
  updated_at: string
  pending?: boolean
}

export type PlannedExpenseInput = Pick<PlannedExpense, 'id' | 'amount_bigint' | 'expected_date' | 'category_id' | 'wallet_id' | 'note' | 'reminder_days'> & {
  idempotency_key: string
}

export function hcmDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(date)
}

export function plannedTotal(rows: readonly Pick<PlannedExpense, 'amount_bigint' | 'status'>[]): bigint {
  return rows.reduce((sum, row) => row.status === 'planned' ? sum + BigInt(row.amount_bigint) : sum, 0n)
}

export function plannedTotalByCategory(rows: readonly Pick<PlannedExpense, 'amount_bigint' | 'status' | 'category_id'>[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const row of rows) {
    if (row.status !== 'planned') continue
    const key = row.category_id ?? ''
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(row.amount_bigint))
  }
  return totals
}

export function dueState(expectedDate: string, today = hcmDate()): 'overdue' | 'today' | 'upcoming' {
  if (expectedDate < today) return 'overdue'
  if (expectedDate === today) return 'today'
  return 'upcoming'
}

function pendingRow(record: LocalRecord): PlannedExpense | null {
  const data = record.data as PlannedExpenseInput | undefined
  if (!data || typeof data.expected_date !== 'string' || typeof data.amount_bigint !== 'string' || typeof data.idempotency_key !== 'string') return null
  return {
    ...data,
    status: 'planned', converted_transaction_id: null, version: record.version,
    created_at: record.updatedAt, updated_at: record.updatedAt, pending: true,
  }
}

export async function getPendingPlannedExpenses(ownerId: string): Promise<PlannedExpense[]> {
  const records = await db.records.where('[ownerId+syncState]').equals([ownerId, 'pending']).toArray()
  return records.map(pendingRow).filter((row): row is PlannedExpense => Boolean(row))
}

export async function queuePlannedExpense(ownerId: string, input: PlannedExpenseInput): Promise<void> {
  const now = new Date().toISOString()
  const command: OutboxCommand = {
    id: input.idempotency_key, actorId: ownerId, scopeId: input.id, operation: 'planned_expense.create',
    payload: input, expectedVersion: null, createdAt: now, retries: 0, state: 'queued',
  }
  await db.transaction('rw', db.records, db.outbox, async () => {
    await db.records.put({ id: input.id, ownerId, updatedAt: now, version: 1, syncState: 'pending', data: input })
    await db.outbox.put(command)
  })
}

export async function flushPlannedExpenseOutbox(ownerId: string): Promise<{ synced: number; failed: number }> {
  if (!supabase || !navigator.onLine) return { synced: 0, failed: 0 }
  const commands = await db.outbox.where('actorId').equals(ownerId).filter(item => item.operation === 'planned_expense.create' && item.state !== 'blocked').sortBy('createdAt')
  let synced = 0
  let failed = 0
  for (const command of commands) {
    const input = command.payload as PlannedExpenseInput
    const { error } = await supabase.rpc('create_planned_expense', {
      p_id: input.id, p_amount_bigint: input.amount_bigint, p_expected_date: input.expected_date,
      p_category_id: input.category_id, p_wallet_id: input.wallet_id, p_note: input.note,
      p_reminder_days: input.reminder_days, p_idempotency_key: input.idempotency_key,
    })
    if (!error) {
      await db.transaction('rw', db.records, db.outbox, async () => {
        await db.records.delete(input.id)
        await db.outbox.delete(command.id)
      })
      synced += 1
    } else {
      const retries = command.retries + 1
      await db.outbox.update(command.id, { retries, state: retries >= 5 ? 'blocked' : 'retry' })
      failed += 1
    }
  }
  return { synced, failed }
}

import { z } from 'zod'

export const vndSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Số tiền phải là số nguyên đồng, không âm.')
const max = 9_223_372_036_854_775_807n

/** Keep numeric VND inputs canonical so a pasted/typed leading zero never blocks saving. */
export function normalizeVndInput(value: string): string {
  return value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '')
}

export function parseVnd(value: string): bigint {
  const parsed = BigInt(vndSchema.parse(value))
  if (parsed > max) throw new RangeError('Số tiền vượt giới hạn lưu trữ.')
  return parsed
}

export function formatVnd(value: bigint | string): string {
  return `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} ₫`
}

export function allocateEqual(total: bigint, participantIds: readonly string[]): Map<string, bigint> {
  if (total < 0n || participantIds.length === 0 || new Set(participantIds).size !== participantIds.length) {
    throw new RangeError('Tổng tiền và danh sách người nhận không hợp lệ.')
  }
  const stable = [...participantIds].sort()
  const base = total / BigInt(stable.length)
  const remainder = total % BigInt(stable.length)
  return new Map(stable.map((id, index) => [id, base + (BigInt(index) < remainder ? 1n : 0n)]))
}

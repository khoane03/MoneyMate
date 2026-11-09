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

const vietnameseDigits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín']
const vietnameseScales = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ', 'tỷ tỷ']

function digitWord(value: number): string {
  return vietnameseDigits[value] ?? ''
}

function readVietnameseGroup(value: number, fillHundreds: boolean): string {
  const hundreds = Math.floor(value / 100)
  const tensAndOnes = value % 100
  const parts: string[] = []

  if (hundreds > 0 || fillHundreds) parts.push(`${digitWord(hundreds)} trăm`)
  if (tensAndOnes === 0) return parts.join(' ')

  const tens = Math.floor(tensAndOnes / 10)
  const ones = tensAndOnes % 10
  if (tens === 0) {
    if (hundreds > 0 || fillHundreds) parts.push('lẻ')
    parts.push(digitWord(ones))
  } else if (tens === 1) {
    parts.push('mười')
    if (ones > 0) parts.push(ones === 5 ? 'lăm' : digitWord(ones))
  } else {
    parts.push(`${digitWord(tens)} mươi`)
    if (ones > 0) parts.push(ones === 1 ? 'mốt' : ones === 5 ? 'lăm' : digitWord(ones))
  }
  return parts.join(' ')
}

/** Read an exact non-negative VND integer as Vietnamese words. */
export function amountInVietnameseWords(value: string): string | null {
  if (!/^(0|[1-9]\d{0,18})$/.test(value)) return null
  let amount: bigint
  try { amount = parseVnd(value) } catch { return null }
  if (amount === 0n) return 'Không đồng'

  const groups: number[] = []
  while (amount > 0n) {
    groups.push(Number(amount % 1000n))
    amount /= 1000n
  }
  if (groups.length > vietnameseScales.length) return null

  const highest = groups.length - 1
  const words = groups.flatMap((group, index) => {
    if (group === 0) return []
    const spoken = readVietnameseGroup(group, index < highest && group < 100)
    return [`${spoken}${vietnameseScales[index] ? ` ${vietnameseScales[index]}` : ''}`]
  }).reverse()
  const result = `${words.join(' ')} đồng`
  return result.replace(/^[a-z]/, first => first.toLocaleUpperCase('vi-VN'))
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

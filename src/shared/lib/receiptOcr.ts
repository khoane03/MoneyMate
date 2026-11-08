export type OcrSuggestion = {
  merchant: string
  accountingDate: string
  total: string
  items: Array<{ name: string; quantity: string; unitPrice: string; confidence: number | null }>
}

function toVndDigits(value: string): string {
  return value.replace(/[^\d]/g, '')
}

function normalizeVietnamese(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('đ', 'd').replaceAll('Đ', 'D').toLowerCase()
}

function parseReceiptDate(line: string): string | null {
  const match = line.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/)
  if (!match) return null
  const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseReceiptText(text: string, confidenceByLine: number[] = []): OcrSuggestion {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const merchant = lines.find(line => line.length >= 2 && line.length <= 100 && !/^(receipt|invoice|\d{1,2}[./-]\d{1,2}[./-]20\d{2})/i.test(line) && !/^hoa don\b/.test(normalizeVietnamese(line))) ?? ''
  const accountingDate = lines.map(parseReceiptDate).find(Boolean) ?? ''
  let total = ''
  for (const line of lines) {
    if (!/(tong\s*(cong|thanh toan)|thanh toan|phai tra|grand total|total|amount due)/.test(normalizeVietnamese(line))) continue
    const match = line.match(/([\d][\d.,\s]{1,18})\s*(?:vnd|vn[dđ]|đ)?\s*$/i)
    if (match) { total = toVndDigits(match[1] ?? ''); if (total) break }
  }
  const items: OcrSuggestion['items'] = []
  lines.forEach((line, index) => {
    const match = line.match(/^(.{2,80}?)\s+(\d{1,5}(?:[.,]\d{1,3})?)\s*[x×]\s*([\d][\d.,]*)\s*(?:=|\s)\s*([\d][\d.,]*)$/i)
    if (!match) return
    const name = match[1] ?? ''
    const quantity = (match[2] ?? '').replace(',', '.')
    const unitPrice = toVndDigits(match[3] ?? '')
    const lineTotal = toVndDigits(match[4] ?? '')
    if (!name || !quantity || !unitPrice || !lineTotal) return
    items.push({ name: name.trim(), quantity, unitPrice, confidence: confidenceByLine[index] ?? null })
  })
  return { merchant, accountingDate, total, items }
}

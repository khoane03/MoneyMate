export type SystemCategoryInput = {
  id: string | null
  kind: 'income' | 'expense'
  name: string
  icon: string | null
  color: string | null
}

export type PublicNoticeInput = { active: boolean; title: string; body: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseSystemCategoryInput(value: unknown): SystemCategoryInput | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (row.id !== null && (typeof row.id !== 'string' || !UUID.test(row.id))) return null
  if (row.kind !== 'income' && row.kind !== 'expense') return null
  if (typeof row.name !== 'string' || row.name.trim().length < 1 || row.name.trim().length > 80) return null
  if (row.icon !== undefined && row.icon !== null && (typeof row.icon !== 'string' || row.icon.length > 48)) return null
  if (row.color !== undefined && row.color !== null && (typeof row.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(row.color))) return null
  return {
    id: typeof row.id === 'string' ? row.id : null,
    kind: row.kind,
    name: row.name.trim(),
    icon: typeof row.icon === 'string' && row.icon.trim() ? row.icon.trim() : null,
    color: typeof row.color === 'string' ? row.color : null
  }
}

export function parsePublicNoticeInput(value: unknown): PublicNoticeInput | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.active !== 'boolean' || typeof row.title !== 'string' || typeof row.body !== 'string') return null
  const title = row.title.trim(); const body = row.body.trim()
  if (title.length > 100 || body.length > 500) return null
  if (row.active && (!title || !body)) return null
  return { active: row.active, title, body }
}

export function parseUserPage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000) return null
  return value
}

export function isSafeUserSearch(value: unknown): value is string {
  return value === undefined || (typeof value === 'string' && value.length <= 120 && ![...value].some(character => character.charCodeAt(0) < 32))
}

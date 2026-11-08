const HCM_TIME_ZONE = 'Asia/Ho_Chi_Minh'

function getDateParts(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: HCM_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date)
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((item) => item.type === type)?.value ?? ''
}

/** Formats a calendar date (YYYY-MM-DD) without shifting it across time zones. */
export function formatDate(value: string | Date) {
  if (typeof value === 'string') {
    const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (calendarDate) return `${calendarDate[3]}/${calendarDate[2]}/${calendarDate[1]}`
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const parts = getDateParts(date)
  return `${part(parts, 'day')}/${part(parts, 'month')}/${part(parts, 'year')}`
}

/** Formats an instant in Vietnam time as dd/mm/yyyy hh:mm:ss. */
export function formatDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HCM_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  return `${part(parts, 'day')}/${part(parts, 'month')}/${part(parts, 'year')} ${part(parts, 'hour')}:${part(parts, 'minute')}:${part(parts, 'second')}`
}

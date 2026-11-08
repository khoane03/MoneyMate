export type BudgetState = 'normal' | 'near' | 'over'

export function getBudgetMetrics(spent: bigint, limit: bigint): { percent: number; remaining: bigint; overage: bigint; state: BudgetState } {
  if (spent < 0n || limit <= 0n) throw new RangeError('Ngân sách và khoản chi không hợp lệ.')
  const rawPercent = spent * 100n / limit
  const percent = Number(rawPercent > 999n ? 999n : rawPercent)
  return {
    percent,
    remaining: spent < limit ? limit - spent : 0n,
    overage: spent > limit ? spent - limit : 0n,
    state: rawPercent >= 100n ? 'over' : rawPercent >= 80n ? 'near' : 'normal'
  }
}

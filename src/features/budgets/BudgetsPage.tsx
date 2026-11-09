import { useCallback, useEffect, useMemo, useState } from 'react'
import { CirclePlus, Gauge, LoaderCircle, RefreshCw, Target } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { getBudgetMetrics } from '../../shared/lib/budgets'
import { fetchAllPages } from '../../shared/lib/pagination'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { Button, Dropdown, IconButton, Input } from '../../shared/ui/Controls'
import { calculateSpendingTotal } from '../../shared/lib/spending'
import { AmountInWords } from '../../shared/ui/AmountInWords'
import { plannedTotal, plannedTotalByCategory, type PlannedExpense } from '../../shared/lib/plannedExpenses'

type Budget = { id: string; category_id: string | null; period_start: string; limit_bigint: string }
type Category = { id: string; name: string; kind: 'income' | 'expense' }
type Transaction = { category_id: string | null; kind: string; amount_bigint: string }
const monthStart = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()).slice(0, 7) + '-01'

export function BudgetsPage() {
  const [userId, setUserId] = useState('')
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [plannedExpenses, setPlannedExpenses] = useState<PlannedExpense[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [limit, setLimit] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    const client = supabase
    setLoading(true); setError('')
    const [{ data: userData, error: authError }, budgetResult, categoryResult, plannedResult] = await Promise.all([
      client.auth.getUser(),
      fetchAllPages((from, to) => client.from('budgets').select('id,category_id,period_start,limit_bigint')
        .eq('period_start', monthStart).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
      fetchAllPages((from, to) => client.from('categories').select('id,name,kind').eq('kind', 'expense')
        .order('name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('planned_expenses').select('id,amount_bigint,expected_date,category_id,wallet_id,note,reminder_days,status,converted_transaction_id,version,created_at,updated_at')
        .eq('status', 'planned').gte('expected_date', monthStart).lt('expected_date', `${Number(monthStart.slice(0, 4)) + (monthStart.slice(5, 7) === '12' ? 1 : 0)}-${monthStart.slice(5, 7) === '12' ? '01' : String(Number(monthStart.slice(5, 7)) + 1).padStart(2, '0')}-01`).order('expected_date').range(from, to)),
    ])
    const transactionRows: Transaction[] = []
    let transactionError = false
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
    for (let offset = 0; ; offset += 1000) {
      const result = await client.from('transactions').select('id,category_id,kind,amount_bigint').in('kind', ['expense', 'loan_principal_payment']).gte('accounting_date', monthStart).lte('accounting_date', today).order('accounting_date', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 999)
      if (result.error) { transactionError = true; break }
      const page = (result.data ?? []) as Transaction[]
      transactionRows.push(...page)
      if (page.length < 1000) break
    }
    if (authError || budgetResult.error || categoryResult.error || plannedResult.error || transactionError) setError('Không tải được ngân sách tháng này. Hãy kiểm tra kết nối và thử lại.')
    else {
      setUserId(userData.user?.id ?? '')
      setBudgets((budgetResult.data ?? []) as Budget[])
      setCategories((categoryResult.data ?? []) as Category[])
      setTransactions(transactionRows)
      setPlannedExpenses((plannedResult.data ?? []) as PlannedExpense[])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const update = () => { void refresh() }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])

  const spentByCategory = useMemo(() => {
    const result = new Map<string, bigint>()
    for (const transaction of transactions) {
      const key = transaction.category_id ?? ''
      result.set(key, (result.get(key) ?? 0n) + BigInt(transaction.amount_bigint))
    }
    return result
  }, [transactions])
  const spentTotal = calculateSpendingTotal(transactions)
  const forecastTotal = plannedTotal(plannedExpenses)
  const forecastByCategory = plannedTotalByCategory(plannedExpenses)

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSuccess('')
    if (!userId || !supabase) { setError('Bạn cần đăng nhập để lưu ngân sách.'); return }
    try { if (parseVnd(limit) <= 0n) throw new Error() } catch { setError('Hạn mức phải là số đồng nguyên dương hợp lệ.'); return }
    setBusy(true)
    const { error: saveError } = await supabase.from('budgets').upsert({ owner_id: userId, category_id: categoryId || null, period_start: monthStart, limit_bigint: limit }, { onConflict: 'owner_id,period_start,category_id' })
    if (saveError) setError(saveError.code === '42501' ? 'Không có quyền lưu ngân sách cho danh mục này.' : 'Không lưu được hạn mức. Hãy kiểm tra giá trị hoặc thử lại.')
    else { setCategoryId(''); setLimit(''); setSuccess('Đã lưu hạn mức cho tháng này.'); await refresh() }
    setBusy(false)
  }

  const monthLabel = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric' }).format(new Date(`${monthStart}T12:00:00+07:00`))
  const budgetCards = budgets.map(budget => {
    const category = categories.find(item => item.id === budget.category_id)
    const spent = budget.category_id ? spentByCategory.get(budget.category_id) ?? 0n : spentTotal
    const limitAmount = BigInt(budget.limit_bigint)
    const planned = budget.category_id ? forecastByCategory.get(budget.category_id) ?? 0n : forecastTotal
    const projected = spent + planned
    return { ...budget, label: category?.name ?? 'Ngân sách chung', spent, planned, projected, limitAmount, ...getBudgetMetrics(projected, limitAmount) }
  })

  return <section className="budgets-page" aria-labelledby="budgets-title">
    <LoadingModal message="Đang tổng hợp ngân sách tháng…" show={loading} />
    <header className="content-heading budgets-heading"><div><p className="eyebrow">KẾ HOẠCH CHI TIÊU</p><h1 id="budgets-title">Ngân sách</h1><p className="subheading">Theo dõi chi tiêu so với hạn mức trong {monthLabel}.</p></div><div className="budget-month-badge"><Target size={16}/>{monthLabel}</div></header>
    {error && <div className="form-error" role="alert">{error}<Button onClick={() => void refresh()}>Thử lại</Button></div>}{success && <p className="budget-success" role="status">{success}</p>}
    <form className="budget-form" onSubmit={save}><div className="budget-form-intro"><span className="budget-form-kicker">THÁNG NÀY</span><h2>Đặt hạn mức</h2><p>Chọn một danh mục hoặc áp dụng cho tổng chi tiêu.</p></div><div className="budget-field"><label htmlFor="budget-category">Phạm vi ngân sách</label><Dropdown id="budget-category" value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Tổng chi tiêu</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Dropdown></div><div className="budget-field"><label htmlFor="budget-limit">Hạn mức (₫)</label><Input id="budget-limit" inputMode="numeric" placeholder="Ví dụ: 5.000.000" value={limit} onChange={event => setLimit(normalizeVndInput(event.target.value))} required/><AmountInWords id="budget-limit" value={limit}/></div><Button type="submit" variant="primary" className="mobile-plus-action" aria-label="Lưu hạn mức" title="Lưu hạn mức" disabled={busy || loading}>{busy ? <LoaderCircle size={18} className="spin" aria-hidden="true"/> : <><CirclePlus size={17} aria-hidden="true"/><span className="mobile-plus-label">Lưu hạn mức</span></>}</Button></form>
    <div className="budget-overview-card"><div className="budget-overview-icon"><Gauge size={20}/></div><div><span>Đã chi / Dự kiến / Có thể chi</span><strong>{formatVnd(spentTotal)} / {formatVnd(forecastTotal)} / {formatVnd(spentTotal + forecastTotal)}</strong></div><small>{transactions.length} khoản thực tế · {plannedExpenses.length} khoản dự kiến</small></div>
    <div className="budget-list-heading budget-section-heading"><div><span className="budget-form-kicker">TỔNG QUAN DANH MỤC</span><h2>Hạn mức của tháng</h2><p>Cập nhật theo các khoản chi đã ghi sổ.</p></div><IconButton onClick={() => void refresh()} label="Làm mới ngân sách" disabled={loading}><RefreshCw size={17}/></IconButton></div>
    {loading ? null : budgetCards.length === 0 ? (
      <div className="wallet-empty budget-empty-state"><Target size={28}/><h2>Chưa đặt ngân sách</h2><p>Thêm hạn mức đầu tiên để biết mình đã sử dụng bao nhiêu ngân sách tháng này.</p></div>
    ) : (
      <ul className="budget-list">{budgetCards.map(budget => (
        <li className={`budget-card ${budget.state}`} key={budget.id}>
          <div className="budget-card-top">
            <div className="budget-card-values"><span className="budget-scope">{budget.label}</span><strong>{formatVnd(budget.projected)} <small>/ {formatVnd(budget.limitAmount)}</small></strong><small>Đã chi {formatVnd(budget.spent)} · Dự kiến {formatVnd(budget.planned)}</small></div>
            <span className={`budget-state-label ${budget.state}`}>{budget.state === 'over' ? 'Đã vượt hạn mức' : budget.state === 'near' ? 'Sắp chạm hạn mức' : 'Trong hạn mức'}</span>
          </div>
          <div className="budget-progress" role="progressbar" aria-label={`Dự phóng sử dụng ${budget.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, budget.percent)}><span style={{ width: `${Math.min(100, budget.percent)}%` }} /></div>
          <div className="budget-card-foot"><span>{budget.percent}% nếu chi đúng kế hoạch</span><span className={budget.overage > 0n ? 'budget-overage' : ''}>{budget.overage > 0n ? `Có thể vượt ${formatVnd(budget.overage)}` : `Dự kiến còn ${formatVnd(budget.remaining)}`}</span></div>
        </li>
      ))}</ul>
    )}
  </section>
}

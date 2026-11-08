import { Button as CommonButton, Input as CommonInput } from '../../shared/ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import { Download, FileBarChart2, RefreshCw } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { calculateSpendingTotal, isSpendingKind } from '../../shared/lib/spending'

type Transaction = { id: string; wallet_id: string | null; kind: string; amount_bigint: string; accounting_date: string; occurred_at: string; note: string; category_id: string | null }
type Category = { id: string; name: string }
type Wallet = { id: string; display_name: string }
type ReportData = { transactions: Transaction[]; categories: Category[]; wallets: Wallet[] }

function hcmDate(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(date) }
function monthStart(date: string) { return `${date.slice(0, 7)}-01` }
const initialRange = { from: monthStart(hcmDate()), to: hcmDate() }
function csvCell(value: string) { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"` }

export function ReportsPage() {
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(hcmDate())
  const [applied, setApplied] = useState(initialRange)
  const [data, setData] = useState<ReportData>({ transactions: [], categories: [], wallets: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (range: { from: string; to: string }) => {
    if (!supabase) { setLoading(false); return }
    const client = supabase
    if (range.from > range.to) { setError('Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.'); return }
    setLoading(true); setError('')
    const transactions: Transaction[] = []
    for (let offset = 0; ; offset += 1000) {
      const result = await client.from('transactions').select('id,wallet_id,kind,amount_bigint,accounting_date,occurred_at,note,category_id').gte('accounting_date', range.from).lte('accounting_date', range.to).order('accounting_date', { ascending: false }).order('occurred_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 999)
      if (result.error) { setError('Không tải được báo cáo. Kiểm tra kết nối rồi thử lại.'); setLoading(false); return }
      const page = (result.data ?? []) as Transaction[]
      transactions.push(...page)
      if (page.length < 1000) break
    }
    const [categories, wallets] = await Promise.all([
      fetchAllPages((from, to) => client.from('categories').select('id,name')
        .order('name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('wallets').select('id,display_name')
        .order('display_name').order('id').range(from, to)),
    ])
    if (categories.error || wallets.error) setError('Một phần dữ liệu báo cáo chưa tải được. Thử tải lại để cập nhật đầy đủ.')
    else setData({ transactions, categories: (categories.data ?? []) as Category[], wallets: (wallets.data ?? []) as Wallet[] })
    setApplied(range); setLoading(false)
  }, [])
  useEffect(() => {
    const update = () => { void load(applied) }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [load, applied])
  useEffect(() => { void load(initialRange) }, [load])

  const monetaryRows = data.transactions.filter(row => row.kind === 'income' || row.kind === 'expense' || row.kind === 'loan_principal_payment')
  const income = monetaryRows.filter(row => row.kind === 'income').reduce((sum, row) => sum + BigInt(row.amount_bigint), 0n)
  const expense = calculateSpendingTotal(monetaryRows)
  const categoryTotals = new Map<string, bigint>()
  for (const row of monetaryRows.filter(item => isSpendingKind(item.kind))) {
    const name = row.kind === 'loan_principal_payment' ? 'Trả nợ' : data.categories.find(category => category.id === row.category_id)?.name ?? 'Chưa phân loại'
    categoryTotals.set(name, (categoryTotals.get(name) ?? 0n) + BigInt(row.amount_bigint))
  }
  const categories = [...categoryTotals].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0].localeCompare(b[0], 'vi')).slice(0, 8)
  const largestExpenses = monetaryRows.filter(row => isSpendingKind(row.kind)).sort((a, b) => BigInt(a.amount_bigint) > BigInt(b.amount_bigint) ? -1 : BigInt(a.amount_bigint) < BigInt(b.amount_bigint) ? 1 : 0).slice(0, 8)
  const maxCategory = categories[0]?.[1] ?? 0n

  function exportCsv() {
    const header = ['Ngày', 'Loại', 'Danh mục', 'Ví', 'Ghi chú', 'Số tiền (VND)']
    const rows = monetaryRows.map(row => [row.accounting_date, row.kind === 'income' ? 'Thu nhập' : row.kind === 'loan_principal_payment' ? 'Trả nợ' : 'Chi tiêu', row.kind === 'loan_principal_payment' ? 'Trả nợ' : data.categories.find(category => category.id === row.category_id)?.name ?? 'Chưa phân loại', data.wallets.find(wallet => wallet.id === row.wallet_id)?.display_name ?? 'Ví', row.note, row.kind === 'income' ? row.amount_bigint : `-${row.amount_bigint}`])
    const csv = '\uFEFF' + [header, ...rows].map(line => line.map(value => csvCell(String(value))).join(',')).join('\r\n')
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = href; link.download = `moneymate-bao-cao-${applied.from}-${applied.to}.csv`; link.click(); URL.revokeObjectURL(href)
  }

  return <section className="reports-page" aria-labelledby="reports-title">
    <LoadingModal message="Đang phân tích báo cáo tài chính…" show={loading} />
    <header className="content-heading"><div><p className="eyebrow">BỨC TRANH TÀI CHÍNH</p><h1 id="reports-title">Báo cáo</h1><p className="subheading">Tổng hợp từ giao dịch thực tế trong sổ của bạn.</p></div><CommonButton type="button" className="secondary-button" onClick={exportCsv} disabled={loading || monetaryRows.length === 0}><Download size={17}/>Xuất CSV</CommonButton></header>
    <form className="report-filter" onSubmit={event => { event.preventDefault(); void load({ from, to }) }}><div><label htmlFor="report-from">Từ ngày</label><CommonInput id="report-from" type="date" value={from} max={to} onChange={event => setFrom(event.target.value)}/></div><div><label htmlFor="report-to">Đến ngày</label><CommonInput id="report-to" type="date" value={to} min={from} onChange={event => setTo(event.target.value)}/></div><CommonButton className="primary-button" disabled={loading}>{loading ? <RefreshCw className="spin" size={16}/> : <FileBarChart2 size={16}/>}Xem báo cáo</CommonButton></form>
    {error && <div className="form-error" role="alert">{error}<CommonButton type="button" onClick={() => void load(applied)}>Thử lại</CommonButton></div>}
    <div className="report-metrics"><article><span>Tổng thu</span><strong className="positive-value">{formatVnd(income)}</strong></article><article><span>Tổng chi</span><strong className="negative-value">{formatVnd(expense)}</strong></article><article><span>Chênh lệch</span><strong className={income >= expense ? 'positive-value' : 'negative-value'}>{formatVnd(income - expense)}</strong></article></div>
    <div className="report-grid"><article className="dashboard-panel report-card"><header className="panel-heading"><div><h2>Chi tiêu theo danh mục</h2><p>Từ {applied.from} đến {applied.to}</p></div></header>{loading ? null : categories.length === 0 ? <div className="chart-empty">Không có khoản chi nào trong khoảng ngày này.</div> : <ul className="report-category-list">{categories.map(([name, amount]) => <li key={name}><div className="category-row"><span>{name}</span><strong>{formatVnd(amount)}</strong></div><div className="category-track"><span style={{ width: `${maxCategory ? Number(amount * 100n / maxCategory) : 0}%` }}/></div></li>)}</ul>}</article>
      <article className="dashboard-panel report-card"><header className="panel-heading"><div><h2>Khoản chi lớn</h2><p>Gồm chi tiêu và trả nợ gốc</p></div></header>{loading ? null : largestExpenses.length === 0 ? <div className="chart-empty">Chưa có khoản chi để xếp hạng.</div> : <ol className="largest-list">{largestExpenses.map(row => <li key={row.id}><span className="largest-rank">{String(largestExpenses.indexOf(row) + 1).padStart(2, '0')}</span><div className="activity-info"><strong>{row.kind === 'loan_principal_payment' ? row.note.trim() || 'Trả nợ' : row.note.trim() || data.categories.find(category => category.id === row.category_id)?.name || 'Chưa phân loại'}</strong><small>{row.kind === 'loan_principal_payment' ? 'Trả nợ · ' : ''}{formatDate(row.accounting_date)} · {data.wallets.find(wallet => wallet.id === row.wallet_id)?.display_name ?? 'Ví'}</small></div><b className="negative-value">{formatVnd(row.amount_bigint)}</b></li>)}</ol>}</article></div>
    {!loading && monetaryRows.length === 0 && !error && <p className="report-note">Vay tiền được loại khỏi tổng thu chi; tiền trả nợ gốc được tính vào tổng chi.</p>}
  </section>
}

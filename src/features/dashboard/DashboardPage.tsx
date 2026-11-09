import { TransactionLink } from '../../shared/ui/TransactionLink'
import { Button as CommonButton } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  CirclePlus,
  CreditCard,
  Eye,
  EyeOff,
  HandCoins,
  Landmark,
  CalendarClock,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  WalletCards,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { Surface } from '../../shared/ui/Surface'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { isSpendingKind } from '../../shared/lib/spending'

type Wallet = {
  id: string
  kind: string
  display_name: string
  current_balance_bigint: string
  status: 'active' | 'archived'
}
type Transaction = {
  id: string
  wallet_id: string | null
  kind: string
  amount_bigint: string
  accounting_date: string
  occurred_at: string
  created_at: string
  note: string
  category_id: string | null
}
type Category = { id: string; name: string; kind: 'income' | 'expense' }
type Month = { key: string; label: string; income: bigint; expense: bigint }
type DashboardData = {
  wallets: Wallet[]
  transactions: Transaction[]
  categories: Category[]
  planned: { id: string; amount_bigint: string; expected_date: string; status: string }[]
}

const currencyKinds = new Set(['income', 'expense', 'loan_principal_payment'])
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  )

function recentMonths(): Month[] {
  const now = new Date(`${today()}T12:00:00+07:00`)
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    return {
      key,
      label: new Intl.DateTimeFormat('vi-VN', { month: 'short' }).format(date),
      income: 0n,
      expense: 0n,
    }
  })
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData>({
    wallets: [],
    transactions: [],
    categories: [],
    planned: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showBalance, setShowBalance] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mm_show_balance') !== 'false'
    } catch {
      return true
    }
  })

  function toggleBalanceVisibility() {
    setShowBalance((prev) => {
      const next = !prev
      try {
        localStorage.setItem('mm_show_balance', String(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    const client = supabase
    setLoading(true)
    setError('')
    const sixMonthsAgo = recentMonths()[0]?.key ?? today().slice(0, 7)
    const readTransactions = async () => {
      const all: Transaction[] = []
      for (let from = 0; ; from += 1000) {
        const page = await client
          .from('transactions')
          .select(
            'id,wallet_id,kind,amount_bigint,accounting_date,occurred_at,created_at,note,category_id',
          )
          .gte('accounting_date', `${sixMonthsAgo}-01`)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + 999)
        if (page.error) return { data: null, error: page.error }
        const rows = (page.data ?? []) as Transaction[]
        all.push(...rows)
        if (rows.length < 1000) return { data: all, error: null }
      }
    }
    const [wallets, transactions, categories, planned] = await Promise.all([
      fetchAllPages((from, to) => client
        .from('wallet_balances')
        .select('id,kind,display_name,current_balance_bigint,status')
        .eq('status', 'active')
        .order('display_name').order('id')
        .range(from, to)),
      readTransactions(),
      fetchAllPages((from, to) => client.from('categories').select('id,name,kind')
        .order('kind').order('name').order('id').range(from, to)),
      client.from('planned_expenses').select('id,amount_bigint,expected_date,status').eq('status', 'planned').gte('expected_date', today()).order('expected_date').limit(50),
    ])
    if (wallets.error || transactions.error || categories.error || planned.error) {
      setError('Chưa tải được tổng quan. Kiểm tra mạng rồi thử tải lại.')
    } else {
      setData({
        wallets: (wallets.data ?? []) as Wallet[],
        transactions: (transactions.data ?? []) as Transaction[],
        categories: (categories.data ?? []) as Category[],
        planned: (planned.data ?? []) as DashboardData['planned'],
      })
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const update = () => { void refresh() }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const summary = useMemo(() => {
    const months = recentMonths()
    const monthMap = new Map(months.map((month) => [month.key, month]))
    const currentMonthKey = today().slice(0, 7)
    let income = 0n
    let expense = 0n
    let incomeCurrent = 0n
    let expenseCurrent = 0n
    const categories = new Map<string, bigint>()
    for (const transaction of data.transactions) {
      const amount = BigInt(transaction.amount_bigint)
      if (transaction.kind === 'income') {
        income += amount
        const month = monthMap.get(transaction.accounting_date.slice(0, 7))
        if (month) month.income += amount
        if (transaction.accounting_date.startsWith(currentMonthKey))
          incomeCurrent += amount
      } else if (isSpendingKind(transaction.kind)) {
        expense += amount
        const month = monthMap.get(transaction.accounting_date.slice(0, 7))
        if (month) month.expense += amount
        if (transaction.accounting_date.startsWith(currentMonthKey)) {
          expenseCurrent += amount
          const categoryName = transaction.kind === 'loan_principal_payment' ? 'Trả nợ' :
            data.categories.find(
              (category) => category.id === transaction.category_id,
            )?.name ?? 'Chưa phân loại'
          categories.set(
            categoryName,
            (categories.get(categoryName) ?? 0n) + amount,
          )
        }
      }
    }
    const maxFlow =
      months.reduce(
        (max, month) => (month.income > max ? month.income : max),
        0n,
      ) >
      months.reduce(
        (max, month) => (month.expense > max ? month.expense : max),
        0n,
      )
        ? months.reduce(
            (max, month) => (month.income > max ? month.income : max),
            0n,
          )
        : months.reduce(
            (max, month) => (month.expense > max ? month.expense : max),
            0n,
          )
    const topCategories = [...categories]
      .sort((a, b) =>
        a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0].localeCompare(b[0], 'vi'),
      )
      .slice(0, 4)
    return {
      months,
      currentMonthKey,
      income,
      expense,
      incomeCurrent,
      expenseCurrent,
      topCategories,
      maxFlow,
    }
  }, [data])

  const currentMonthLabel = new Intl.DateTimeFormat('vi-VN', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${today()}T12:00:00+07:00`))
  const balance = data.wallets.reduce(
    (sum, wallet) => sum + BigInt(wallet.current_balance_bigint),
    0n,
  )
  const hasFinancialData =
    data.wallets.length > 0 || data.transactions.length > 0 || data.planned.length > 0
  const upcomingPlanned = data.planned.filter(item => {
    const difference = (new Date(`${item.expected_date}T12:00:00+07:00`).getTime() - new Date(`${today()}T12:00:00+07:00`).getTime()) / 86_400_000
    return difference >= 0 && difference <= 30
  })
  const upcomingPlannedTotal = upcomingPlanned.reduce((sum, item) => sum + BigInt(item.amount_bigint), 0n)

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <LoadingModal message="Đang tổng hợp dữ liệu tài chính…" show={loading} />
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">TÀI CHÍNH CỦA BẠN</p>
          <h1 id="dashboard-title">Tổng quan</h1>
          <p className="subheading">
            Dòng tiền cá nhân, chuẩn kế toán VND và cập nhật trực tiếp từ sổ
            giao dịch.
          </p>
        </div>
        <div className="dashboard-actions">
          <CommonButton
            className="icon-button"
            type="button"
            onClick={() => void refresh()}
            aria-label="Làm mới dữ liệu"
            disabled={loading}
          >
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </CommonButton>
          <TransactionLink className="primary-button mobile-plus-action" to="/transactions?action=new" aria-label="Ghi giao dịch" title="Ghi giao dịch">
            <CirclePlus size={18} aria-hidden="true" />
            <span className="mobile-plus-label">Ghi giao dịch</span>
          </TransactionLink>
        </div>
      </header>

      {error && (
        <div className="dashboard-error" role="alert">
          <span>{error}</span>
          <CommonButton
            type="button"
            className="text-button"
            onClick={() => void refresh()}
          >
            Thử lại
          </CommonButton>
        </div>
      )}

      {!hasFinancialData && !loading && !error ? (
        <div className="dashboard-welcome">
          <div className="welcome-mark">
            <WalletCards size={28} />
          </div>
          <p className="eyebrow">BẮT ĐẦU TỪ ĐÂY</p>
          <h2>Tạo một chiếc ví đầu tiên</h2>
          <p>
            Thêm số dư hiện có (tiền mặt, tài khoản ngân hàng hoặc ví điện tử),
            sau đó ghi lại khoản thu hoặc chi.
          </p>
          <Link className="primary-button mobile-plus-action" to="/wallets" aria-label="Tạo ví đầu tiên" title="Tạo ví đầu tiên">
            <CirclePlus size={18} aria-hidden="true" />
            <span className="mobile-plus-label">Tạo ví đầu tiên</span>
          </Link>
        </div>
      ) : (
        <>
          {/* Virtual Account Card with Privacy Toggle */}
          <section
            className="balance-overview-card"
            aria-label="Tổng số dư tài sản"
          >
            <div className="card-top-row">
              <div className="card-brand-tag">
                <span className="card-chip" aria-hidden="true" />
                <span className="card-brand-label">MONEYMATE VIRTUAL CARD</span>
              </div>
              <CommonButton
                type="button"
                className="privacy-toggle-btn"
                onClick={toggleBalanceVisibility}
                aria-label={
                  showBalance ? 'Ẩn số dư tài khoản' : 'Hiện số dư tài khoản'
                }
                title={showBalance ? 'Ẩn số dư' : 'Hiện số dư'}
              >
                {showBalance ? <Eye size={17} /> : <EyeOff size={17} />}
                <span>{showBalance ? 'Ẩn số dư' : 'Hiện số dư'}</span>
              </CommonButton>
            </div>

            <div className="card-balance-body">
              <span className="balance-label">TỔNG SỐ DƯ KHẢ DỤNG</span>
              <strong className="balance-amount-display">
                {loading
                  ? 'Đang tải…'
                  : showBalance
                    ? formatVnd(balance)
                    : '•••••••• ₫'}
              </strong>
              <div className="card-footer-meta">
                <span className="card-wallets-count">
                  <WalletCards size={14} aria-hidden="true" />
                  {data.wallets.length} ví đang hoạt động
                </span>
                <span className="card-security-badge">
                  <ShieldCheck size={14} aria-hidden="true" />
                  Bảo mật cấp RLS
                </span>
              </div>
            </div>

            <div className="card-action-bar">
              <TransactionLink
                to="/transactions?action=new"
                className="card-action-btn primary mobile-plus-action"
                aria-label="Ghi chép"
                title="Ghi chép"
              >
                <CirclePlus size={16} />
                <span className="mobile-plus-label">Ghi chép</span>
              </TransactionLink>
              <TransactionLink
                to="/transactions?action=transfer"
                className="card-action-btn secondary"
              >
                <CreditCard size={16} />
                <span>Chuyển ví</span>
              </TransactionLink>
              <Link to="/wallets" className="card-action-btn ghost">
                <span>Quản lý ví</span>
                <ChevronRight size={15} />
              </Link>
            </div>
          </section>

          {/* Quick Action Navigation Bar on Mobile */}
          <section className="quick-actions-bar" aria-label="Thao tác nhanh">
            <TransactionLink to="/transactions?action=new" className="quick-action-item">
              <div className="quick-action-circle income">
                <CirclePlus size={20} />
              </div>
              <span>Thu / Chi</span>
            </TransactionLink>
            <TransactionLink
              to="/transactions?action=transfer"
              className="quick-action-item"
            >
              <div className="quick-action-circle transfer">
                <CreditCard size={20} />
              </div>
              <span>Chuyển ví</span>
            </TransactionLink>
            <Link to="/receipts" className="quick-action-item">
              <div className="quick-action-circle receipt">
                <ScanLine size={20} />
              </div>
              <span>Quét bill OCR</span>
            </Link>
            <Link to="/sharing" className="quick-action-item">
              <div className="quick-action-circle sharing">
                <HandCoins size={20} />
              </div>
              <span>Chia tiền</span>
            </Link>
            <Link to="/loans" className="quick-action-item">
              <div className="quick-action-circle sharing">
                <Landmark size={20} aria-hidden="true" />
              </div>
              <span>Vay &amp; Trả nợ</span>
            </Link>
            <Link to="/planned-expenses" className="quick-action-item">
              <div className="quick-action-circle transfer"><CalendarClock size={20} /></div>
              <span>Dự kiến</span>
            </Link>
          </section>

          {/* Month Flow Metrics */}
          <div
            className="metric-grid"
            aria-label={`Thu chi ${currentMonthLabel}`}
          >
            <Surface as="article" className="metric-card">
              <div className="metric-label">
                <span className="metric-icon income-icon">
                  <ArrowDownLeft size={16} />
                </span>
                <span>Thu nhập tháng</span>
              </div>
              <strong>
                {loading
                  ? '—'
                  : showBalance
                    ? formatVnd(summary.incomeCurrent)
                    : '•••••••• ₫'}
              </strong>
              <small>{currentMonthLabel}</small>
            </Surface>

            <Surface as="article" className="metric-card">
              <div className="metric-label"><span className="metric-icon wallet-mini"><CalendarClock size={16} /></span><span>Dự kiến 30 ngày</span></div>
              <strong>{loading ? '—' : showBalance ? formatVnd(upcomingPlannedTotal) : '•••••••• ₫'}</strong>
              <small><Link to="/planned-expenses">{upcomingPlanned.length} khoản sắp tới</Link></small>
            </Surface>

            <Surface as="article" className="metric-card">
              <div className="metric-label">
                <span className="metric-icon expense-icon">
                  <ArrowUpRight size={16} />
                </span>
                <span>Chi tiêu tháng</span>
              </div>
              <strong>
                {loading
                  ? '—'
                  : showBalance
                    ? formatVnd(summary.expenseCurrent)
                    : '•••••••• ₫'}
              </strong>
              <small>{currentMonthLabel}</small>
            </Surface>

            <Surface as="article" className="metric-card">
              <div className="metric-label">
                <span className="metric-icon wallet-mini">
                  <CreditCard size={16} />
                </span>
                <span>Dòng tiền ròng</span>
              </div>
              <strong
                className={
                  summary.incomeCurrent >= summary.expenseCurrent
                    ? 'positive-value'
                    : 'negative-value'
                }
              >
                {loading
                  ? '—'
                  : showBalance
                    ? (summary.incomeCurrent >= summary.expenseCurrent
                        ? '+'
                        : '') +
                      formatVnd(summary.incomeCurrent - summary.expenseCurrent)
                    : '•••••••• ₫'}
              </strong>
              <small>Thu nhập trừ chi tiêu</small>
            </Surface>
          </div>

          <div className="dashboard-panels">
            {/* Cashflow Bar Chart */}
            <article className="dashboard-panel cashflow-panel">
              <header className="panel-heading">
                <div>
                  <h2>Dòng tiền sáu tháng</h2>
                  <p>So sánh thu và chi thực tế</p>
                </div>
                <Link to="/reports" className="panel-link">
                  Báo cáo chi tiết <ChevronRight size={16} />
                </Link>
              </header>

              {loading ? (
                <div className="chart-loading" aria-live="polite">
                  Đang tổng hợp dữ liệu…
                </div>
              ) : summary.months.every(
                  (month) => month.income === 0n && month.expense === 0n,
                ) ? (
                <div className="chart-empty">
                  Chưa có giao dịch thu hoặc chi trong sáu tháng này.
                </div>
              ) : (
                <div
                  className="flow-chart"
                  role="img"
                  aria-label="Biểu đồ cột dòng tiền trong sáu tháng. Cột xanh là thu nhập, cột đỏ là chi tiêu."
                >
                  {summary.months.map((month) => {
                    const incomeHeight =
                      summary.maxFlow > 0n
                        ? Math.max(
                            Number((month.income * 100n) / summary.maxFlow),
                            month.income > 0n ? 3 : 0,
                          )
                        : 0
                    const expenseHeight =
                      summary.maxFlow > 0n
                        ? Math.max(
                            Number((month.expense * 100n) / summary.maxFlow),
                            month.expense > 0n ? 3 : 0,
                          )
                        : 0
                    return (
                      <div
                        className={`flow-month${month.key === summary.currentMonthKey ? ' current' : ''}`}
                        key={month.key}
                        aria-label={`${month.label}: thu ${formatVnd(month.income)}, chi ${formatVnd(month.expense)}`}
                      >
                        <div className="flow-bars">
                          <span
                            className="flow-bar income-bar"
                            style={{ height: `${incomeHeight}%` }}
                            title={`Thu ${formatVnd(month.income)}`}
                          />
                          <span
                            className="flow-bar expense-bar"
                            style={{ height: `${expenseHeight}%` }}
                            title={`Chi ${formatVnd(month.expense)}`}
                          />
                        </div>
                        <span className="flow-month-label">{month.label}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="chart-legend">
                <span>
                  <i className="legend-dot income-dot" />
                  Thu nhập:{' '}
                  {showBalance ? formatVnd(summary.income) : '•••••••• ₫'}
                </span>
                <span>
                  <i className="legend-dot expense-dot" />
                  Chi tiêu:{' '}
                  {showBalance ? formatVnd(summary.expense) : '•••••••• ₫'}
                </span>
              </div>
            </article>

            {/* Category Breakdown */}
            <article className="dashboard-panel category-panel">
              <header className="panel-heading">
                <div>
                  <h2>Chi tiêu theo danh mục</h2>
                  <p>{currentMonthLabel}</p>
                </div>
                <Link to="/categories" className="panel-link">
                  Danh mục <ChevronRight size={16} />
                </Link>
              </header>

              {loading ? (
                <div className="chart-loading">Đang tổng hợp dữ liệu…</div>
              ) : summary.topCategories.length === 0 ? (
                <div className="chart-empty">
                  Chưa có khoản chi nào trong tháng này.
                </div>
              ) : (
                <ul className="category-summary">
                  {summary.topCategories.map(([name, amount]) => (
                    <li key={name}>
                      <div className="category-row">
                        <span>{name}</span>
                        <strong>
                          {showBalance ? formatVnd(amount) : '•••••• ₫'}
                        </strong>
                      </div>
                      <div className="category-track">
                        <span
                          style={{
                            width: `${Number((amount * 100n) / (summary.topCategories[0]?.[1] ?? amount))}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            {/* Recent Activity List */}
            <article className="dashboard-panel activity-panel">
              <header className="panel-heading">
                <div>
                  <h2>Giao dịch gần đây</h2>
                  <p>Các khoản ghi nhận mới nhất</p>
                </div>
                <Link to="/transactions" className="panel-link">
                  Tất cả giao dịch <ChevronRight size={16} />
                </Link>
              </header>

              {loading ? (
                <div className="chart-loading">Đang tải giao dịch…</div>
              ) : data.transactions.filter((transaction) =>
                  currencyKinds.has(transaction.kind),
                ).length === 0 ? (
                <div className="activity-empty">
                  <span className="empty-icon">
                    <WalletCards size={20} />
                  </span>
                  <div>
                    <strong>Chưa có giao dịch</strong>
                    <p>Ghi khoản thu hoặc chi đầu tiên để bắt đầu theo dõi.</p>
                  </div>
                  <TransactionLink to="/transactions?action=new" className="text-button mobile-plus-action" aria-label="Thêm giao dịch" title="Thêm giao dịch">
                    <CirclePlus size={17} aria-hidden="true" /><span className="mobile-plus-label">Thêm giao dịch</span>
                  </TransactionLink>
                </div>
              ) : (
                <ul className="activity-list">
                  {data.transactions
                    .filter((transaction) =>
                      currencyKinds.has(transaction.kind),
                    )
                    .slice(0, 6)
                    .map((transaction) => {
                      const categoryName = transaction.kind === 'loan_principal_payment' ? 'Trả nợ' :
                        data.categories.find(
                          (category) => category.id === transaction.category_id,
                        )?.name ??
                        (transaction.kind === 'income'
                          ? 'Thu nhập'
                          : 'Chưa phân loại')
                      return (
                        <li
                          key={transaction.id}
                          className="activity-item-interactive"
                        >
                          <span
                            className={`activity-icon ${
                              transaction.kind === 'income'
                                ? 'income-icon'
                                : 'expense-icon'
                            }`}
                          >
                            {transaction.kind === 'income' ? (
                              <ArrowDownLeft size={18} />
                            ) : (
                              <ArrowUpRight size={18} />
                            )}
                          </span>
                          <div className="activity-info">
                            <strong>
                              {transaction.note.trim() || categoryName}
                            </strong>
                            <small>
                              {formatDate(transaction.accounting_date)} ·{' '}
                              {data.wallets.find(
                                (wallet) => wallet.id === transaction.wallet_id,
                              )?.display_name ?? (transaction.wallet_id ? 'Ví' : 'Không ảnh hưởng ví')}
                            </small>
                          </div>
                          <b
                            className={
                              transaction.kind === 'income'
                                ? 'positive-value'
                                : 'negative-value'
                            }
                          >
                            {transaction.kind === 'income' ? '+' : '−'}
                            {showBalance
                              ? formatVnd(transaction.amount_bigint)
                              : '•••••• ₫'}
                          </b>
                        </li>
                      )
                    })}
                </ul>
              )}
            </article>
          </div>
        </>
      )}
    </section>
  )
}

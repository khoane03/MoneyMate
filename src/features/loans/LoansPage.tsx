import { TransactionLink } from '../../shared/ui/TransactionLink'
import { Button as CommonButton, Dropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, HandCoins, Plus } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { calculateLoanPaid, calculateLoanRemaining, calculateOutstanding } from '../../shared/lib/loanBalances'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { ImageViewer } from '../../shared/ui/ImageViewer'

type LoanRow = {
  id: string
  kind: string
  amount_bigint: string
  accounting_date: string
  note: string
  affects_outstanding: boolean
  affects_wallet: boolean
  loan_lender_name: string | null
  loan_purpose: string | null
  loan_origin_transaction_id: string | null
  loan_connection_id: string | null
  loan_counterparty_id: string | null
}
type SharedLoan = {
  id: string; connection_id: string; borrower_user_id: string; counterparty_user_id: string
  lender_name: string; purpose: string; principal_bigint: string; accounting_date: string
}
type SharedPayment = {
  id: string; shared_loan_id: string; amount_bigint: string; accounting_date: string; reduces_balance: boolean
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelled'; created_by: string; evidence_url?: string | null
}
type Wallet = { id: string; display_name: string }

export function LoansPage() {
  const [rows, setRows] = useState<LoanRow[]>([])
  const [sharedLoans, setSharedLoans] = useState<SharedLoan[]>([])
  const [sharedPayments, setSharedPayments] = useState<SharedPayment[]>([])
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [currentUserId, setCurrentUserId] = useState('')
  const [receiverWallets, setReceiverWallets] = useState<Record<string, string>>({})
  const [actionBusy, setActionBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!supabase) { setError('Cần cấu hình dịch vụ để mở sổ vay.'); setLoading(false); return }
    setLoading(true)
    const client = supabase
    const [result, shared, payments, user] = await Promise.all([
      fetchAllPages((from, to) => client.from('transactions')
        .select('id,kind,amount_bigint,accounting_date,note,affects_outstanding,affects_wallet,loan_lender_name,loan_purpose,loan_origin_transaction_id,loan_connection_id,loan_counterparty_id')
        .in('kind', ['borrowed_funds', 'loan_principal_payment'])
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
      fetchAllPages((from, to) => client.from('shared_personal_loans')
        .select('id,connection_id,borrower_user_id,counterparty_user_id,lender_name,purpose,principal_bigint,accounting_date')
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
      fetchAllPages((from, to) => client.from('shared_personal_loan_payments')
        .select('id,shared_loan_id,amount_bigint,accounting_date,reduces_balance,status,created_by')
        .order('accounting_date', { ascending: false }).order('id', { ascending: false }).range(from, to)),
      Promise.all([
        client.auth.getUser(),
        fetchAllPages((from, to) => client.from('wallets').select('id,display_name').eq('status', 'active').order('created_at').range(from, to))
      ])
    ])
    if (result.error || shared.error || payments.error || user[0].error || user[1].error) setError('Không tải được sổ vay hoặc khoản vay được chia sẻ. Kiểm tra kết nối và thử lại.')
    else {
      setRows((result.data ?? []) as LoanRow[])
      setSharedLoans((shared.data ?? []) as SharedLoan[])
      const paymentRows = (payments.data ?? []) as SharedPayment[]
      if (paymentRows.length) {
        const evidence = await client.from('shared_loan_payment_evidence').select('shared_payment_id,storage_path').in('shared_payment_id', paymentRows.map(payment => payment.id))
        if (!evidence.error) await Promise.all((evidence.data ?? []).map(async item => {
          const { data: signed } = await client.storage.from('receipt-files').createSignedUrl(item.storage_path, 1800)
          const payment = paymentRows.find(row => row.id === item.shared_payment_id)
          if (payment) payment.evidence_url = signed?.signedUrl ?? null
        }))
      }
      setSharedPayments(paymentRows)
      setCurrentUserId(user[0].data.user.id)
      setWallets((user[1].data ?? []) as Wallet[])
      setError('')
    }
    setLoading(false)
  }, [])

  const resolvePayment = async (payment: SharedPayment, approve: boolean) => {
    if (!supabase) return
    setActionBusy(payment.id)
    setError('')
    const { error: actionError } = await supabase.rpc('resolve_shared_loan_repayment', {
      p_shared_payment_id: payment.id,
      p_receiver_wallet_id: approve ? receiverWallets[payment.id] ?? null : null,
      p_approve: approve
    })
    if (actionError) setError(actionError.message.includes('choose one of your active wallets')
      ? 'Chọn ví nhận tiền trước khi xác nhận.'
      : 'Không thể cập nhật đề nghị trả nợ. Có thể đề nghị đã được xử lý; hãy tải lại.')
    else await refresh()
    setActionBusy('')
  }

  const cancelPayment = async (payment: SharedPayment) => {
    if (!supabase) return
    setActionBusy(payment.id)
    const { error: actionError } = await supabase.rpc('cancel_shared_loan_repayment', { p_shared_payment_id: payment.id })
    if (actionError) setError('Không thể hủy đề nghị trả nợ. Tải lại để kiểm tra trạng thái.')
    else await refresh()
    setActionBusy('')
  }
  useEffect(() => {
    const update = () => { void refresh() }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])

  const outstanding = useMemo(() => calculateOutstanding(rows), [rows])
  const loans = useMemo(() => rows.filter(row => row.kind === 'borrowed_funds').map(loan => {
    const repayments = rows.filter(row => row.kind === 'loan_principal_payment' && row.loan_origin_transaction_id === loan.id)
    const paid = calculateLoanPaid(loan.id, rows)
    const remaining = loan.affects_outstanding ? calculateLoanRemaining(loan.id, loan.amount_bigint, rows) : null
    return { loan, repayments: repayments.sort((a, b) => b.accounting_date.localeCompare(a.accounting_date)), paid, remaining }
  }), [rows])
  const unlinkedRepayments = rows.filter(row => row.kind === 'loan_principal_payment' && !row.loan_origin_transaction_id)
  const hasUntrackedRows = rows.some(row => !row.affects_outstanding)

  return <div className="loans-page">
    <LoadingModal message="Đang tải sổ Vay & Trả nợ…" show={loading} />
    <header className="loans-header"><div className="loans-header-copy"><span className="eyebrow">SỔ THEO DÕI RIÊNG</span><h1>Vay & Trả nợ</h1><p className="subheading">Theo dõi khoản vay, lịch sử thanh toán và số dư còn lại.</p></div>
      <div className="loans-header-actions"><TransactionLink className="secondary-button mobile-plus-action" to="/transactions?action=new&kind=borrowed_funds&historical=1" aria-label="Thêm khoản vay cũ" title="Thêm khoản vay cũ"><Plus size={18} aria-hidden="true"/><span className="mobile-plus-label">Thêm khoản vay cũ</span></TransactionLink><TransactionLink className="primary-button mobile-plus-action" to="/transactions?action=new&kind=borrowed_funds" aria-label="Ghi khoản vay" title="Ghi khoản vay"><Plus size={18} aria-hidden="true"/><span className="mobile-plus-label">Ghi khoản vay</span></TransactionLink></div>
    </header>
    <section className="loan-balance-card" aria-label="Tổng dư nợ đang theo dõi">
      <div className="loan-balance-main"><span className="loan-balance-icon" aria-hidden="true"><HandCoins size={22}/></span><div><span className="loan-balance-label">Tổng dư nợ đang theo dõi</span><strong>{formatVnd(outstanding > 0n ? outstanding : 0n)}</strong></div></div>
      <div className="loan-balance-meta"><span>{loans.filter(item => item.remaining !== null && item.remaining > 0n).length} khoản còn dư nợ</span><small>Khoản vay cũ không làm tăng số dư ví.</small></div>
    </section>
    {hasUntrackedRows && <p className="loan-tracking-note" role="status">Một số khoản trong lịch sử được lưu mà không thay đổi tổng dư nợ.</p>}
    <section className="loan-history"><div className="loan-history-heading"><div><span className="eyebrow">TỪNG KHOẢN</span><h2>Chi tiết khoản vay</h2></div></div>
      {error && <p className="data-status error" role="alert">{error} <CommonButton type="button" onClick={() => void refresh()}>Thử lại</CommonButton></p>}
      {!loading && !error && loans.length === 0 && <div className="empty-state"><HandCoins size={26}/><h3>Chưa có khoản vay</h3><p>Thêm khoản vay mới hoặc nhập dư nợ cũ để bắt đầu theo dõi.</p><TransactionLink className="primary-button mobile-plus-action" to="/transactions?action=new&kind=borrowed_funds&historical=1" aria-label="Thêm khoản vay cũ" title="Thêm khoản vay cũ"><Plus size={18} aria-hidden="true"/><span className="mobile-plus-label">Thêm khoản vay cũ</span></TransactionLink></div>}
      {loans.map(({ loan, repayments, paid, remaining }) => <article className="loan-detail-card" key={loan.id}>
        <header className="loan-detail-header"><span className="loan-row-icon borrowed_funds" aria-hidden="true"><ArrowDownLeft size={18}/></span><div className="loan-detail-title"><strong>{loan.loan_purpose || loan.note || 'Khoản vay'}</strong><small>Vay từ {loan.loan_lender_name || 'Chưa ghi rõ'} · {formatDate(loan.accounting_date)}</small></div><b>{formatVnd(loan.amount_bigint)}</b></header>
        {!loan.affects_wallet && <span className="loan-history-badge historical">Khoản vay cũ · Không cộng vào ví</span>}
        <div className="loan-detail-metrics"><div><span>Đã vay</span><strong>{formatVnd(loan.amount_bigint)}</strong></div><div><span>Đã trả</span><strong>{formatVnd(paid.toString())}</strong></div><div><span>Còn nợ</span><strong>{remaining === null ? 'Không theo dõi' : formatVnd(remaining.toString())}</strong></div></div>
        {loan.note && loan.loan_purpose && <p className="loan-extra-note">Ghi chú: {loan.note}</p>}
        {repayments.length > 0 && <div className="loan-repayments"><h3>Lịch sử trả nợ</h3>{repayments.map(repayment => <div className="loan-repayment-row" key={repayment.id}><span><ArrowUpRight size={15} aria-hidden="true"/> {formatDate(repayment.accounting_date)}</span><strong>{formatVnd(repayment.amount_bigint)}</strong>{!repayment.affects_outstanding && <small>Không trừ dư nợ</small>}</div>)}</div>}
        {remaining !== null && remaining > 0n && <TransactionLink className="loan-repay-link" to={`/transactions?action=new&kind=loan_principal_payment&loanId=${loan.id}`}><Plus size={17} aria-hidden="true"/>Trả nợ</TransactionLink>}
      </article>)}
      {sharedLoans.length > 0 && <div className="shared-loan-section">
        <div className="loan-history-heading"><div><span className="eyebrow">THEO DÕI CÙNG NGƯỜI KẾT NỐI</span><h2>Khoản vay chia sẻ</h2></div><p>Thông tin ví riêng chỉ bạn xem được.</p></div>
        {sharedLoans.map(loan => {
          const sourceLoan = rows.find(row => row.kind === 'borrowed_funds'
            && row.loan_connection_id === loan.connection_id
            && row.loan_counterparty_id === loan.counterparty_user_id
            && row.amount_bigint === loan.principal_bigint
            && row.accounting_date === loan.accounting_date
            && row.loan_lender_name === loan.lender_name
            && row.loan_purpose === loan.purpose)
          const payments = sharedPayments.filter(payment => payment.shared_loan_id === loan.id)
            .sort((a, b) => b.accounting_date.localeCompare(a.accounting_date))
          const paid = payments.filter(payment => payment.reduces_balance && payment.status === 'confirmed')
            .reduce((sum, payment) => sum + BigInt(payment.amount_bigint), 0n)
          const remaining = BigInt(loan.principal_bigint) > paid ? BigInt(loan.principal_bigint) - paid : 0n
          return <article className="loan-detail-card shared-loan-card" key={loan.id}>
            <header className="loan-detail-header"><span className="loan-row-icon borrowed_funds" aria-hidden="true"><ArrowDownLeft size={18}/></span><div className="loan-detail-title"><strong>{loan.purpose}</strong><small>Vay từ {loan.lender_name} · {formatDate(loan.accounting_date)}</small></div><b>{formatVnd(loan.principal_bigint)}</b></header>
            <span className="loan-history-badge shared">Hai người cùng theo dõi</span>
            <div className="loan-detail-metrics"><div><span>Đã vay</span><strong>{formatVnd(loan.principal_bigint)}</strong></div><div><span>Đã trả</span><strong>{formatVnd(paid.toString())}</strong></div><div><span>Còn nợ</span><strong>{formatVnd(remaining.toString())}</strong></div></div>
            {remaining > 0n && currentUserId === loan.borrower_user_id && sourceLoan && <TransactionLink className="loan-repay-link" to={`/transactions?action=new&kind=loan_principal_payment&loanId=${sourceLoan.id}`}><Plus size={17} aria-hidden="true"/> Trả nợ</TransactionLink>}
            {payments.length > 0 && <div className="loan-repayments"><h3>Lịch sử trả nợ</h3>{payments.map(payment => <div className="loan-repayment-row shared-payment-row" key={payment.id}><span><ArrowUpRight size={15} aria-hidden="true"/> {formatDate(payment.accounting_date)}</span><strong>{formatVnd(payment.amount_bigint)}</strong><small className={`shared-payment-status ${payment.status}`}>{payment.status === 'pending' ? 'Chờ xác nhận' : payment.status === 'confirmed' ? 'Đã xác nhận' : payment.status === 'rejected' ? 'Đã từ chối' : 'Đã hủy'}</small>
              {payment.status === 'pending' && currentUserId === loan.counterparty_user_id && <div className="shared-payment-actions"><Dropdown aria-label="Chọn ví nhận tiền" value={receiverWallets[payment.id] ?? ''} onChange={event => setReceiverWallets(current => ({ ...current, [payment.id]: event.target.value }))}><option value="">Chọn ví nhận tiền</option>{wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{wallet.display_name}</option>)}</Dropdown>{!wallets.length && <span>Bạn cần có ví đang hoạt động để xác nhận khoản nhận.</span>}<CommonButton type="button" className="primary-button" disabled={actionBusy === payment.id || !receiverWallets[payment.id]} onClick={() => void resolvePayment(payment, true)}>{actionBusy === payment.id ? 'Đang xác nhận…' : 'Xác nhận đã nhận'}</CommonButton><CommonButton type="button" className="secondary-button" disabled={actionBusy === payment.id} onClick={() => void resolvePayment(payment, false)}>Từ chối</CommonButton></div>}
              {payment.status === 'pending' && currentUserId === payment.created_by && <div className="shared-payment-actions"><span>Chờ bên cho vay xác nhận. Hai ví chưa được cập nhật.</span><CommonButton type="button" className="secondary-button" disabled={actionBusy === payment.id} onClick={() => void cancelPayment(payment)}>Hủy đề nghị</CommonButton></div>}
              {payment.evidence_url && <ImageViewer src={payment.evidence_url} alt="Ảnh minh chứng khoản trả nợ" label="Xem ảnh minh chứng khoản trả nợ" className="loan-payment-proof"><img src={payment.evidence_url} alt="" loading="lazy"/><span>Xem ảnh minh chứng</span></ImageViewer>}
            </div>)}</div>}
          </article>
        })}
      </div>}
      {!loading && !error && unlinkedRepayments.length > 0 && <div className="loan-unlinked-history"><h3>Khoản trả chưa gắn với khoản vay</h3>{unlinkedRepayments.map(row => <div className="loan-repayment-row" key={row.id}><span><ArrowUpRight size={15} aria-hidden="true"/> {row.loan_lender_name || 'Người cho vay'} · {row.loan_purpose || formatDate(row.accounting_date)}</span><strong>{formatVnd(row.amount_bigint)}</strong></div>)}</div>}
    </section>
  </div>
}

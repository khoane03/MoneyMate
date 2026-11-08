import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Plus, ReceiptText, WalletCards, X } from 'lucide-react'
import { useSearchParams, useLocation } from 'react-router-dom'
import { z } from 'zod'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { calculateLoanRemaining } from '../../shared/lib/loanBalances'
import { isSpendingKind } from '../../shared/lib/spending'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { createUuid } from '../../shared/lib/uuid'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { ReceiptAutofill } from '../../shared/ui/ReceiptAutofill'
import { ImageViewer } from '../../shared/ui/ImageViewer'

type Wallet = { id: string; display_name: string }
type Category = { id: string; name: string; kind: 'income' | 'expense' }
type LoanContact = { connection_id: string; user_id: string; display_name: string }
type Transaction = {
  id: string
  wallet_id: string | null
  kind: string
  amount_bigint: string
  occurred_at: string
  created_at: string
  accounting_date: string
  note: string
  category_id: string | null
  evidence_url?: string | null
}
type LoanLedgerRow = Pick<Transaction, 'id' | 'kind' | 'amount_bigint' | 'accounting_date' | 'note'> & {
  affects_outstanding: boolean
  affects_wallet: boolean
  loan_lender_name: string | null
  loan_purpose: string | null
  loan_origin_transaction_id: string | null
  loan_connection_id: string | null
  loan_counterparty_id: string | null
}

const schema = z.object({
  walletId: z.union([z.uuid(), z.literal('')]),
  kind: z.enum(['income', 'expense', 'borrowed_funds', 'loan_principal_payment']),
  amount: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  date: z.string().date(),
  categoryId: z.string(),
  note: z.string().max(1000)
})

const kindLabels: Record<string, string> = {
  income: 'Thu nhập',
  expense: 'Chi tiêu',
  borrowed_funds: 'Vay',
  loan_principal_payment: 'Trả nợ',
  loan_repayment_received: 'Nhận trả nợ',
  transfer_in: 'Nhận chuyển tiền',
  transfer_out: 'Chuyển tiền',
  settlement_payment: 'Trả công nợ'
}

type FilterTab = 'all' | 'expense' | 'income' | 'transfer'
const TRANSACTION_PAGE_SIZE = 50

export function TransactionsPage({ composerOnly = false, onClose, onSaved }: { composerOnly?: boolean; onClose?: () => void; onSaved?: (message: string) => void } = {}) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [idempotencyKey, setIdempotencyKey] = useState(() => createUuid())
  const [rows, setRows] = useState<Transaction[]>([])
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loanContacts, setLoanContacts] = useState<LoanContact[]>([])
  const [loanRows, setLoanRows] = useState<LoanLedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formMode, setFormMode] = useState<'transaction' | 'transfer'>('transaction')
  const [filterTab, setFilterTab] = useState<FilterTab>(() => searchParams.get('filter') === 'expense' ? 'expense' : 'all')

  const [walletId, setWalletId] = useState('')
  const [fromWalletId, setFromWalletId] = useState('')
  const [toWalletId, setToWalletId] = useState('')
  const [kind, setKind] = useState<'income' | 'expense' | 'borrowed_funds' | 'loan_principal_payment'>('expense')
  const [affectsOutstanding, setAffectsOutstanding] = useState(true)
  const [affectsWallet, setAffectsWallet] = useState(true)
  const [loanContact, setLoanContact] = useState('')
  const [loanOriginId, setLoanOriginId] = useState('')
  const [loanLender, setLoanLender] = useState('')
  const [loanPurpose, setLoanPurpose] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
  )
  const [categoryId, setCategoryId] = useState('')
  const [note, setNote] = useState('')
  const [evidenceImage, setEvidenceImage] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  useEffect(() => {
    if (!showForm) return
    const previous = document.activeElement as HTMLElement | null
    const sheet = sheetRef.current
    const focusable = () => Array.from(sheet?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="file"]), select:not(:disabled), a[href], textarea:not(:disabled)') ?? []).filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0)
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setShowForm(false); onClose?.() }
      if (event.key === 'Tab') {
        const nodes = focusable()
        const first = nodes[0], last = nodes.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    sheet?.addEventListener('keydown', onKey)
    return () => { sheet?.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [showForm, busy, onClose])

  const walletlessHistoryEntry = kind === 'borrowed_funds' && !affectsWallet
  const selectedRepaymentLoan = loanRows.find(row => row.id === loanOriginId && row.kind === 'borrowed_funds')
  const repaymentChoices = useMemo(() => loanRows
    .filter(row => row.kind === 'borrowed_funds' && row.affects_outstanding && row.loan_lender_name && row.loan_purpose)
    .map(loan => {
      return { ...loan, remaining: calculateLoanRemaining(loan.id, loan.amount_bigint, loanRows) }
    })
    .filter(loan => loan.remaining > 0n), [loanRows])

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    const client = supabase
    setLoading(true)
    const [tx, w, c, contacts, loanTransactions] = await Promise.all([
      client
        .from('transactions')
        .select('id,wallet_id,kind,amount_bigint,occurred_at,created_at,accounting_date,note,category_id,affects_outstanding,affects_wallet,loan_origin_transaction_id')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(0, TRANSACTION_PAGE_SIZE - 1),
      fetchAllPages((from, to) => client.from('wallets').select('id,display_name')
        .eq('status', 'active').order('display_name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('categories').select('id,name,kind')
        .order('kind').order('name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('connection_members').select('connection_id,user_id,display_name')
        .order('display_name').order('user_id').range(from, to)),
      fetchAllPages((from, to) => client.from('transactions')
        .select('id,kind,amount_bigint,accounting_date,note,affects_outstanding,affects_wallet,loan_lender_name,loan_purpose,loan_origin_transaction_id,loan_connection_id,loan_counterparty_id')
        .in('kind', ['borrowed_funds', 'loan_principal_payment'])
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to))
    ])
    if (tx.error || w.error || c.error || loanTransactions.error) {
      setError('Không tải được dữ liệu. Kiểm tra kết nối và thử lại.')
    } else {
      const transactionRows = (tx.data ?? []) as Transaction[]
      if (transactionRows.length) {
        const evidence = await client.from('transaction_evidence').select('transaction_id,storage_path').in('transaction_id', transactionRows.map(row => row.id))
        if (!evidence.error) await Promise.all((evidence.data ?? []).map(async item => {
          const { data: signed } = await client.storage.from('receipt-files').createSignedUrl(item.storage_path, 1800)
          const row = transactionRows.find(entry => entry.id === item.transaction_id)
          if (row) row.evidence_url = signed?.signedUrl ?? null
        }))
      }
      setRows(transactionRows)
      setHasMore((tx.data ?? []).length === TRANSACTION_PAGE_SIZE)
      const activeWallets = (w.data ?? []) as Wallet[]
      setWallets(activeWallets)
      setCategories((c.data ?? []) as Category[])
      setLoanRows((loanTransactions.data ?? []) as LoanLedgerRow[])
      const ownId = (await client.auth.getUser()).data.user?.id
      setLoanContacts(((contacts.data ?? []) as LoanContact[]).filter(contact => contact.user_id !== ownId))
      setWalletId(current => current || activeWallets[0]?.id || '')
    }
    setLoading(false)
  }, [])

  const loadMore = useCallback(async () => {
    if (!supabase || loadingMore || !hasMore) return
    const client = supabase
    setLoadingMore(true)
    const from = rows.length
    const { data, error: pageError } = await supabase
      .from('transactions')
      .select('id,wallet_id,kind,amount_bigint,occurred_at,created_at,accounting_date,note,category_id,affects_outstanding,affects_wallet,loan_origin_transaction_id')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + TRANSACTION_PAGE_SIZE - 1)
    if (pageError) setError('Không tải thêm được giao dịch. Hãy thử lại.')
    else {
      const page = (data ?? []) as Transaction[]
      if (page.length) {
        const evidence = await client.from('transaction_evidence').select('transaction_id,storage_path').in('transaction_id', page.map(row => row.id))
        if (!evidence.error) await Promise.all((evidence.data ?? []).map(async item => {
          const { data: signed } = await client.storage.from('receipt-files').createSignedUrl(item.storage_path, 1800)
          const row = page.find(entry => entry.id === item.transaction_id)
          if (row) row.evidence_url = signed?.signedUrl ?? null
        }))
      }
      setRows(current => [...current, ...page])
      setHasMore(page.length === TRANSACTION_PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [hasMore, loadingMore, rows.length])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openForm = useCallback(
    (mode: 'transaction' | 'transfer') => {
      setError('')
      setFormMode(mode)
      setIdempotencyKey(createUuid())
      setAffectsOutstanding(true)
      setAffectsWallet(true)
      setLoanOriginId('')
      setLoanLender('')
      setLoanPurpose('')
      setEvidenceImage(null)
      if (mode === 'transfer') {
        setFromWalletId(wallets[0]?.id ?? '')
        setToWalletId(wallets[1]?.id ?? '')
      }
      setShowForm(true)
    },
    [wallets]
  )

  // Handle URL query trigger (?action=new or ?action=transfer)
  useEffect(() => {
    const action = searchParams.get('action')
    const requestedKind = searchParams.get('kind')
    const isWalletlessHistoryEntry = requestedKind === 'borrowed_funds' && searchParams.get('historical') === '1'
    if (action === 'new' && (wallets.length > 0 || isWalletlessHistoryEntry)) {
      openForm('transaction')
      if (requestedKind === 'borrowed_funds' || requestedKind === 'loan_principal_payment') setKind(requestedKind)
      if (isWalletlessHistoryEntry) setAffectsWallet(false)
      const requestedLoanId = searchParams.get('loanId')
      if (requestedLoanId) setLoanOriginId(requestedLoanId)
      searchParams.delete('action')
      searchParams.delete('kind')
      searchParams.delete('historical')
      searchParams.delete('loanId')
      setSearchParams(searchParams, { replace: true, state: location.state })
    } else if (action === 'transfer' && wallets.length >= 2) {
      openForm('transfer')
      searchParams.delete('action')
      setSearchParams(searchParams, { replace: true, state: location.state })
    }
  }, [searchParams, wallets, openForm, setSearchParams, location.state])

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccessMessage('')
    const isLoan = ['borrowed_funds', 'loan_principal_payment'].includes(kind)
    const originLoan = loanRows.find(row => row.id === loanOriginId && row.kind === 'borrowed_funds')
    const normalizedLender = kind === 'loan_principal_payment' ? (originLoan?.loan_lender_name ?? '') : loanLender.trim()
    const normalizedPurpose = kind === 'loan_principal_payment' ? (originLoan?.loan_purpose ?? '') : loanPurpose.trim()
    const parsed = schema.safeParse({ walletId, kind, amount, date, categoryId, note })
    if (!parsed.success || (!walletlessHistoryEntry && !parsed.data?.walletId)) {
      setError('Kiểm tra ví, ngày và số tiền. Số tiền phải là số nguyên đồng dương.')
      return
    }
    try {
      if (parseVnd(parsed.data.amount) <= 0n) throw new Error()
    } catch {
      setError('Số tiền phải lớn hơn 0 và nằm trong giới hạn lưu trữ.')
      return
    }
    if (!supabase) {
      setError('Cần cấu hình dịch vụ để lưu giao dịch.')
      return
    }
    if (isLoan && (!normalizedLender || !normalizedPurpose)) {
      setError('Nhập người cho vay và khoản vay để dễ theo dõi.');
      return
    }
    if (kind === 'loan_principal_payment' && !originLoan) {
      setError('Chọn khoản vay cần thanh toán.');
      return
    }
    if (kind === 'loan_principal_payment' && affectsOutstanding && originLoan) {
      const remaining = calculateLoanRemaining(originLoan.id, originLoan.amount_bigint, loanRows)
      if (parseVnd(parsed.data.amount) > remaining) {
        setError('Số tiền trả vượt quá số dư còn lại của khoản vay này.')
        return
      }
    }
    if (evidenceImage && (!['image/jpeg', 'image/png', 'image/webp'].includes(evidenceImage.type) || evidenceImage.size > 15 * 1024 * 1024)) {
      setError('Ảnh minh chứng cần là JPG, PNG hoặc WebP và không quá 15 MB.')
      return
    }
    setBusy(true)
    const [loanConnectionId, loanCounterpartyId] = kind === 'loan_principal_payment'
      ? [originLoan?.loan_connection_id ?? null, originLoan?.loan_counterparty_id ?? null]
      : loanContact ? loanContact.split(':') : [null, null]
    const occurredAt = new Date(`${parsed.data.date}T12:00:00+07:00`).toISOString()
    const { data: savedEntry, error: saveError } = await supabase.rpc('create_personal_transaction', {
      p_wallet_id: walletlessHistoryEntry ? null : parsed.data.walletId || null,
      p_kind: parsed.data.kind,
      p_amount_bigint: parsed.data.amount,
      p_occurred_at: occurredAt,
      p_accounting_date: parsed.data.date,
      p_category_id: isLoan ? null : parsed.data.categoryId || null,
      p_note: parsed.data.note,
      p_idempotency_key: idempotencyKey,
      p_affects_outstanding: ['borrowed_funds', 'loan_principal_payment'].includes(parsed.data.kind) ? affectsOutstanding : false,
      p_loan_connection_id: isLoan ? loanConnectionId : null,
      p_loan_counterparty_id: isLoan ? loanCounterpartyId : null,
      p_loan_lender_name: isLoan ? normalizedLender : null,
      p_loan_purpose: isLoan ? normalizedPurpose : null,
      p_affects_wallet: isLoan ? (kind === 'borrowed_funds' ? affectsWallet : true) : true,
      p_loan_origin_transaction_id: kind === 'loan_principal_payment' ? loanOriginId : null,
      p_share_with_counterparty: isLoan && (kind === 'borrowed_funds' ? Boolean(loanContact) : Boolean(originLoan?.loan_connection_id))
    })
    if (saveError) {
      setError(saveError.message.includes('repayment exceeds remaining loan balance')
        ? 'Số tiền trả vượt dư nợ còn lại. Tải lại sổ vay để cập nhật số mới nhất.'
        : saveError.message.includes('loan unavailable for repayment')
          ? 'Khoản vay này không còn trong danh sách trả nợ. Tải lại rồi chọn khoản khác.'
          : 'Không thể lưu giao dịch. Kiểm tra ví, danh mục và quyền truy cập.')
    } else {
      let savedMessage = 'Đã lưu giao dịch.'
      const result = savedEntry as { id?: string; status?: string } | null
      if (evidenceImage && result?.id) {
        const userId = (await supabase.auth.getUser()).data.user?.id
        if (userId) {
          const ext = evidenceImage.type === 'image/png' ? 'png' : evidenceImage.type === 'image/webp' ? 'webp' : 'jpg'
          const path = `${userId}/${idempotencyKey}.${ext}`
          const { error: uploadError } = await supabase.storage.from('receipt-files').upload(path, evidenceImage, { contentType: evidenceImage.type, upsert: false })
          const evidenceResult = uploadError ? { error: uploadError } : result.status === 'pending'
            ? await supabase.from('shared_loan_payment_evidence').insert({ shared_payment_id: result.id, owner_id: userId, storage_path: path })
            : await supabase.from('transaction_evidence').insert({ transaction_id: result.id, owner_id: userId, storage_path: path })
          if (evidenceResult.error) {
            if (!uploadError) await supabase.storage.from('receipt-files').remove([path])
            savedMessage = 'Đã lưu giao dịch, nhưng ảnh minh chứng chưa tải lên được. Không tạo lại giao dịch để tránh ghi trùng khoản chi.'
          }
        }
      }
      if (kind === 'loan_principal_payment' && result?.status === 'pending') {
        savedMessage = `Đã gửi yêu cầu trả nợ. Hai ví sẽ cập nhật sau khi bên cho vay xác nhận.${savedMessage.includes('ảnh minh chứng') ? ' Ảnh minh chứng chưa tải lên được.' : ''}`
      }
      setIdempotencyKey(createUuid())
      setShowForm(false)
      setAmount('')
      setNote('')
      setEvidenceImage(null)
      setLoanLender('')
      setLoanPurpose('')
      setLoanOriginId('')
      setSuccessMessage(savedMessage)
      if (onSaved) onSaved(savedMessage)
      else await refresh()
    }
    setBusy(false)
  }

  async function transfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!fromWalletId || !toWalletId || fromWalletId === toWalletId) {
      setError('Chọn hai ví khác nhau để chuyển tiền.')
      return
    }
    try {
      if (parseVnd(amount) <= 0n) throw new Error()
    } catch {
      setError('Số tiền chuyển phải lớn hơn 0 và nằm trong giới hạn lưu trữ.')
      return
    }
    if (!supabase) {
      setError('Cần cấu hình dịch vụ để chuyển tiền.')
      return
    }
    setBusy(true)
    const occurredAt = new Date(`${date}T12:00:00+07:00`).toISOString()
    const { error: saveError } = await supabase.rpc('create_wallet_transfer', {
      p_from_wallet_id: fromWalletId,
      p_to_wallet_id: toWalletId,
      p_amount_bigint: amount,
      p_occurred_at: occurredAt,
      p_idempotency_key: idempotencyKey
    })
    if (saveError) {
      setError('Không thể chuyển tiền. Kiểm tra hai ví còn hoạt động và thử lại.')
    } else {
      setIdempotencyKey(createUuid())
      setShowForm(false)
      setAmount('')
      if (onSaved) onSaved('Đã lưu. Số liệu trên màn hình đang được cập nhật.')
      else await refresh()
    }
    setBusy(false)
  }

  const filteredRows = useMemo(() => {
    if (filterTab === 'all') return rows
    if (filterTab === 'expense') return rows.filter(r => isSpendingKind(r.kind))
    if (filterTab === 'income') return rows.filter(r => r.kind === 'income')
    if (filterTab === 'transfer')
      return rows.filter(r => r.kind === 'transfer_in' || r.kind === 'transfer_out')
    return rows
  }, [rows, filterTab])

  return (
    <section className={`transactions-page${composerOnly ? " transaction-composer-only" : ""}`} aria-labelledby="tx-page-title">
      <LoadingModal message="Đang tải dữ liệu giao dịch…" show={loading} />
      <header className="content-heading">
        <div>
          <p className="eyebrow">SỔ TAY TÀI CHÍNH</p>
          <h1 id="tx-page-title">Giao dịch</h1>
          <p className="subheading">Theo dõi thu, chi và chuyển tiền giữa các ví của bạn.</p>
        </div>
        <div className="transaction-actions">
          <CommonButton
            type="button"
            className="secondary-button"
            onClick={() => openForm('transfer')}
            disabled={wallets.length < 2}
          >
            <WalletCards size={17} />
            <span>Chuyển tiền</span>
          </CommonButton>
          <CommonButton
            type="button"
            className="primary-button mobile-plus-action"
            onClick={() => openForm('transaction')}
            disabled={wallets.length === 0}
            aria-label="Thêm giao dịch"
            title="Thêm giao dịch"
          >
            <Plus size={18} />
            <span className="mobile-plus-label">Thêm giao dịch</span>
          </CommonButton>
        </div>
      </header>

      {wallets.length === 0 && !loading && (
        <div className="notice">
          <strong>Cần có ví</strong>
          <span>Vui lòng tạo ví trong mục "Ví của tôi" trước khi ghi nhận giao dịch.</span>
        </div>
      )}

      {error && !showForm && (
        <div className="form-error" role="alert">
          <span>{error}</span>
          <CommonButton type="button" onClick={() => void refresh()}>
            Thử lại
          </CommonButton>
        </div>
      )}

      {composerOnly && !showForm && <CommonButton type="button" className="secondary-button composer-close" onClick={onClose}>Đóng biểu mẫu</CommonButton>}
      {/* Segmented Filter Control */}
      <div className="segmented-filter-bar" role="tablist" aria-label="Bộ lọc loại giao dịch">
        <CommonButton
          type="button"
          role="tab"
          aria-selected={filterTab === 'all'}
          className={`segment-btn ${filterTab === 'all' ? 'active' : ''}`}
          onClick={() => setFilterTab('all')}
        >
          Tất cả
        </CommonButton>
        <CommonButton
          type="button"
          role="tab"
          aria-selected={filterTab === 'expense'}
          className={`segment-btn ${filterTab === 'expense' ? 'active' : ''}`}
          onClick={() => setFilterTab('expense')}
        >
          Chi tiêu
        </CommonButton>
        <CommonButton
          type="button"
          role="tab"
          aria-selected={filterTab === 'income'}
          className={`segment-btn ${filterTab === 'income' ? 'active' : ''}`}
          onClick={() => setFilterTab('income')}
        >
          Thu nhập
        </CommonButton>
        <CommonButton
          type="button"
          role="tab"
          aria-selected={filterTab === 'transfer'}
          className={`segment-btn ${filterTab === 'transfer' ? 'active' : ''}`}
          onClick={() => setFilterTab('transfer')}
        >
          Chuyển khoản
        </CommonButton>
      </div>

      {/* Modal / Bottom Sheet Form */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => { if (!busy) { setShowForm(false); onClose?.() } }}>
          <div
            ref={sheetRef}
            className="bottom-sheet-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="form-sheet-title"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <h2 id="form-sheet-title">
                {formMode === 'transaction' ? 'Giao dịch mới' : 'Chuyển tiền giữa các ví'}
              </h2>
              <CommonButton
                type="button"
                className="sheet-close-btn"
                onClick={() => { if (!busy) { setShowForm(false); onClose?.() } }}
                aria-label="Đóng biểu mẫu"
              >
                <X size={20} />
              </CommonButton>
            </div>

            {formMode === 'transaction' ? (
              <form className="sheet-form" onSubmit={save}>
                <ReceiptAutofill label="Chụp ảnh để tự điền và đính kèm" onImageSelected={setEvidenceImage} onApply={(suggestion) => {
                  setIdempotencyKey(createUuid())
                  if (suggestion.merchant) {
                    if (kind === 'borrowed_funds') setLoanPurpose(suggestion.merchant)
                    else setNote(suggestion.merchant)
                  }
                  if (suggestion.total) setAmount(suggestion.total)
                  if (suggestion.accountingDate) setDate(suggestion.accountingDate)
                }} />
                <div className="form-kind-selector">
                  <CommonButton type="button" className={`kind-pill expense ${kind === 'expense' ? 'selected' : ''}`} onClick={() => { setIdempotencyKey(createUuid()); setKind('expense'); setAffectsWallet(true); setLoanOriginId(''); setLoanLender(''); setLoanPurpose('') }}>Chi tiêu</CommonButton>
                  <CommonButton type="button" className={`kind-pill income ${kind === 'income' ? 'selected' : ''}`} onClick={() => { setIdempotencyKey(createUuid()); setKind('income'); setAffectsWallet(true); setLoanOriginId(''); setLoanLender(''); setLoanPurpose('') }}>Thu nhập</CommonButton>
                  <CommonButton type="button" className={`kind-pill loan ${kind === 'borrowed_funds' ? 'selected' : ''}`} onClick={() => { setIdempotencyKey(createUuid()); setAffectsOutstanding(true); setAffectsWallet(true); setCategoryId(''); setKind('borrowed_funds'); setLoanContact(''); setLoanOriginId(''); setLoanLender(''); setLoanPurpose('') }}>Vay</CommonButton>
                  <CommonButton type="button" className={`kind-pill loan ${kind === 'loan_principal_payment' ? 'selected' : ''}`} onClick={() => { setIdempotencyKey(createUuid()); setAffectsOutstanding(true); setAffectsWallet(true); setCategoryId(''); setKind('loan_principal_payment'); setLoanContact(''); setLoanLender(''); setLoanPurpose('') }}>Trả nợ</CommonButton>
                </div>

                {kind === 'borrowed_funds' && <label className="loan-outstanding-toggle"><CommonInput type="checkbox" checked={!affectsWallet} onChange={event => { setIdempotencyKey(createUuid()); setAffectsWallet(!event.target.checked) }} />Khoản vay cũ — chỉ ghi nhận dư nợ, không cộng vào ví</label>}
                {(kind === 'borrowed_funds' || kind === 'loan_principal_payment') && <label className="loan-outstanding-toggle"><CommonInput type="checkbox" checked={affectsOutstanding} disabled={kind === 'borrowed_funds' && Boolean(loanContact)} onChange={event => { setIdempotencyKey(createUuid()); setAffectsOutstanding(event.target.checked) }} />{kind === 'borrowed_funds' ? 'Cộng khoản này vào tổng dư nợ' : 'Trừ khoản này khỏi tổng dư nợ'}</label>}
                {kind === 'borrowed_funds' && <div className="form-grid-2 loan-details-fields">
                  <div className="field-group"><label htmlFor="tx-loan-lender">Vay từ ai?</label><CommonInput id="tx-loan-lender" value={loanLender} onChange={event => { setIdempotencyKey(createUuid()); setLoanLender(event.target.value) }} placeholder="Ví dụ: Anh Minh" maxLength={120} required /></div>
                  <div className="field-group"><label htmlFor="tx-loan-purpose">Vay khoản gì?</label><CommonInput id="tx-loan-purpose" value={loanPurpose} onChange={event => { setIdempotencyKey(createUuid()); setLoanPurpose(event.target.value) }} placeholder="Ví dụ: Mua xe máy" maxLength={240} required /></div>
                </div>}
                {kind === 'loan_principal_payment' && <div className="field-group"><label htmlFor="tx-loan-origin">Khoản vay cần trả</label><CommonDropdown id="tx-loan-origin" value={loanOriginId} onChange={event => { setIdempotencyKey(createUuid()); setLoanOriginId(event.target.value) }} required><option value="">Chọn khoản vay</option>{repaymentChoices.map(loan => <option key={loan.id} value={loan.id}>{loan.loan_lender_name} · {loan.loan_purpose} · Còn {formatVnd(loan.remaining.toString())}</option>)}</CommonDropdown>{repaymentChoices.length === 0 ? <small>Chưa có khoản vay còn dư nợ. Thêm khoản vay trước để ghi nhận thanh toán.</small> : <small>Khoản trả được gắn vào đúng khoản vay để tính số dư còn lại.</small>}</div>}
                {kind === 'borrowed_funds' && loanContacts.length > 0 && <div className="field-group"><label htmlFor="tx-loan-contact">Chia sẻ khoản vay với</label><CommonDropdown id="tx-loan-contact" value={loanContact} onChange={event => { setIdempotencyKey(createUuid()); setLoanContact(event.target.value); if (event.target.value) setAffectsOutstanding(true) }}><option value="">Chỉ mình tôi</option>{loanContacts.map(contact => <option key={`${contact.connection_id}:${contact.user_id}`} value={`${contact.connection_id}:${contact.user_id}`}>{contact.display_name}</option>)}</CommonDropdown><small>{loanContact ? 'Người này sẽ thấy người cho vay, mục đích, số tiền và các lần trả của khoản vay. Ví và giao dịch riêng không được chia sẻ.' : 'Chọn một người để cùng theo dõi khoản vay và các lần trả.'}</small></div>}
                {kind === 'loan_principal_payment' && selectedRepaymentLoan?.loan_connection_id && <p className="loan-sharing-hint" role="status">Khoản trả này sẽ tiếp tục được chia sẻ với {loanContacts.find(contact => contact.connection_id === selectedRepaymentLoan.loan_connection_id && contact.user_id === selectedRepaymentLoan.loan_counterparty_id)?.display_name ?? 'người kết nối'}.</p>}

                <div className="field-group">
                  <label htmlFor="tx-amount">Số tiền (₫)</label>
                  <CommonInput
                    id="tx-amount"
                    className="big-amount-input"
                    inputMode="numeric"
                    placeholder="0 ₫"
                    value={amount}
                    onChange={event => {
                      setIdempotencyKey(createUuid())
                      setAmount(normalizeVndInput(event.target.value))
                    }}
                    required
                    autoFocus
                  />
                  {amount && (
                    <small className="amount-preview-label">{formatVnd(amount)}</small>
                  )}
                </div>

                <div className={`form-grid-2 ${walletlessHistoryEntry ? 'loan-date-only' : ''}`}>
                  {!walletlessHistoryEntry && <div className="field-group">
                    <label htmlFor="tx-wallet">Ví giao dịch</label>
                    <CommonDropdown
                      id="tx-wallet"
                      value={walletId}
                      onChange={event => {
                        setIdempotencyKey(createUuid())
                        setWalletId(event.target.value)
                      }}
                    >
                      {wallets.map(wallet => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.display_name}
                        </option>
                      ))}
                    </CommonDropdown>
                  </div>}

                  <div className="field-group">
                    <label htmlFor="tx-date">Ngày ghi sổ</label>
                    <CommonInput
                      id="tx-date"
                      type="date"
                      value={date}
                      onChange={event => {
                        setIdempotencyKey(createUuid())
                        setDate(event.target.value)
                      }}
                      required
                    />
                  </div>
                </div>

                {!['borrowed_funds', 'loan_principal_payment'].includes(kind) && <div className="field-group">
                  <label htmlFor="tx-category">Danh mục</label>
                  <CommonDropdown
                    id="tx-category"
                    value={categoryId}
                    onChange={event => {
                      setIdempotencyKey(createUuid())
                      setCategoryId(event.target.value)
                    }}
                  >
                    <option value="">Chưa phân loại</option>
                    {categories
                      .filter(category => category.kind === kind)
                      .map(category => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </CommonDropdown>
                </div>}

                <div className="field-group">
                  <label htmlFor="tx-note">Ghi chú hoặc tên món</label>
                  <CommonInput
                    id="tx-note"
                    placeholder="Ví dụ: Ăn trưa, Đổ xăng, Tiền lương..."
                    value={note}
                    onChange={event => {
                      setIdempotencyKey(createUuid())
                      setNote(event.target.value)
                    }}
                    maxLength={1000}
                  />
                </div>

                {error && <div className="form-error" role="alert">{error}</div>}
                <div className="sheet-form-actions">
                  <CommonButton
                    className="secondary-button"
                    type="button"
                    onClick={() => { if (!busy) { setShowForm(false); onClose?.() } }}
                  >
                    Hủy
                  </CommonButton>
                  <CommonButton className="primary-button" disabled={busy}>
                    Lưu giao dịch
                  </CommonButton>
                </div>
              </form>
            ) : (
              <form className="sheet-form" onSubmit={transfer}>
                <p className="field-help">
                  Khoản chuyển tiền giữa hai ví cá nhân tạo bút toán ghép cặp và không làm thay đổi tổng tài sản ròng.
                </p>

                <div className="field-group">
                  <label htmlFor="transfer-amount">Số tiền chuyển (₫)</label>
                  <CommonInput
                    id="transfer-amount"
                    className="big-amount-input"
                    inputMode="numeric"
                    placeholder="0 ₫"
                    value={amount}
                    onChange={event => {
                      setIdempotencyKey(createUuid())
                      setAmount(normalizeVndInput(event.target.value))
                    }}
                    required
                    autoFocus
                  />
                  {amount && (
                    <small className="amount-preview-label">{formatVnd(amount)}</small>
                  )}
                </div>

                <div className="form-grid-2">
                  <div className="field-group">
                    <label htmlFor="transfer-from">Chuyển từ ví</label>
                    <CommonDropdown
                      id="transfer-from"
                      value={fromWalletId}
                      onChange={event => {
                        setIdempotencyKey(createUuid())
                        setFromWalletId(event.target.value)
                        if (event.target.value === toWalletId) {
                          setToWalletId(
                            wallets.find(wallet => wallet.id !== event.target.value)?.id ?? ''
                          )
                        }
                      }}
                    >
                      {wallets.map(wallet => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.display_name}
                        </option>
                      ))}
                    </CommonDropdown>
                  </div>

                  <div className="field-group">
                    <label htmlFor="transfer-to">Chuyển đến ví</label>
                    <CommonDropdown
                      id="transfer-to"
                      value={toWalletId}
                      onChange={event => {
                        setIdempotencyKey(createUuid())
                        setToWalletId(event.target.value)
                      }}
                    >
                      {wallets
                        .filter(wallet => wallet.id !== fromWalletId)
                        .map(wallet => (
                          <option key={wallet.id} value={wallet.id}>
                            {wallet.display_name}
                          </option>
                        ))}
                    </CommonDropdown>
                  </div>
                </div>

                <div className="field-group">
                  <label htmlFor="transfer-date">Ngày chuyển tiền</label>
                  <CommonInput
                    id="transfer-date"
                    type="date"
                    value={date}
                    onChange={event => {
                      setIdempotencyKey(createUuid())
                      setDate(event.target.value)
                    }}
                    required
                  />
                </div>

                {error && <div className="form-error" role="alert">{error}</div>}
                <div className="sheet-form-actions">
                  <CommonButton
                    className="secondary-button"
                    type="button"
                    onClick={() => { if (!busy) { setShowForm(false); onClose?.() } }}
                  >
                    Hủy
                  </CommonButton>
                  <CommonButton className="primary-button" disabled={busy}>
                    Xác nhận chuyển
                  </CommonButton>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Transaction List */}
      {successMessage && <p className="data-status success" role="status">{successMessage}</p>}
      {loading && rows.length === 0 ? null : filteredRows.length === 0 ? (
        <div className="wallet-empty">
          <ReceiptText size={32} />
          <h2>Chưa có giao dịch phù hợp</h2>
          <p>
            {rows.length === 0
              ? 'Mọi thu chi sẽ được bảo vệ riêng tư theo tài khoản của bạn.'
              : 'Không có giao dịch nào trong bộ lọc này.'}
          </p>
          <CommonButton
            type="button"
            className="primary-button mobile-plus-action"
            onClick={() => openForm('transaction')}
            disabled={wallets.length === 0}
            style={{ marginTop: '12px' }}
            aria-label="Ghi giao dịch ngay"
            title="Ghi giao dịch ngay"
          >
            <Plus size={18} />
            <span className="mobile-plus-label">Ghi giao dịch ngay</span>
          </CommonButton>
        </div>
      ) : (
        <ul className="wallet-list">
          {filteredRows.map(row => {
            const isPositive = row.kind === 'income' || row.kind === 'transfer_in'
            const isTransfer = row.kind === 'transfer_in' || row.kind === 'transfer_out'
            const walletName =
              wallets.find(wallet => wallet.id === row.wallet_id)?.display_name ?? (row.wallet_id ? 'Ví' : 'Không ảnh hưởng ví')

            return (
              <li key={row.id} className="tx-list-row">
                <span
                  className={`wallet-icon ${
                    isTransfer
                      ? 'transfer-icon'
                      : isPositive
                      ? 'income-icon'
                      : 'expense-icon'
                  }`}
                >
                  {isTransfer ? (
                    <WalletCards size={18} />
                  ) : isPositive ? (
                    <ArrowDownLeft size={18} />
                  ) : (
                    <ArrowUpRight size={18} />
                  )}
                </span>
                <div className="wallet-info">
                  <strong>
                    {row.note.trim() || kindLabels[row.kind] || row.kind}
                  </strong>
                  <small>
                    {formatDate(row.accounting_date)} · {walletName}
                    {row.note ? ` · ${kindLabels[row.kind] ?? ''}` : ''}
                  </small>
                  {row.evidence_url && <ImageViewer src={row.evidence_url} alt={`Ảnh minh chứng: ${row.note.trim() || kindLabels[row.kind] || 'giao dịch'}`} label="Xem ảnh minh chứng" className="transaction-proof-link" />}
                </div>
                <b className={isPositive ? 'amount-in' : 'amount-out'}>
                  {isPositive ? '+' : '−'}
                  {formatVnd(row.amount_bigint)}
                </b>
              </li>
            )
          })}
        </ul>
      )}
      {!loading && rows.length > 0 && hasMore && (
        <div className="list-pagination">
          <CommonButton type="button" className="secondary-button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Đang tải thêm…' : 'Tải thêm giao dịch'}
          </CommonButton>
        </div>
      )}
    </section>
  )
}

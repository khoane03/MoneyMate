import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, CheckCircle2, CirclePlus, CloudOff, History, LoaderCircle, Pencil, RotateCcw, WalletCards, XCircle } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { Button, Dropdown, Input, Textarea } from '../../shared/ui/Controls'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { AmountInWords } from '../../shared/ui/AmountInWords'
import { useConfirm } from '../../shared/ui/useConfirm'
import { dueState, flushPlannedExpenseOutbox, getPendingPlannedExpenses, hcmDate, queuePlannedExpense, type PlannedExpense, type PlannedExpenseInput } from '../../shared/lib/plannedExpenses'

type Category = { id: string; name: string }
type Wallet = { id: string; display_name: string }
type FormState = { note: string; amount: string; expectedDate: string; categoryId: string; walletId: string; reminderDays: string }
const emptyForm = (): FormState => ({ note: '', amount: '', expectedDate: hcmDate(), categoryId: '', walletId: '', reminderDays: '1' })

export function PlannedExpensesPage() {
  const confirm = useConfirm()
  const [userId, setUserId] = useState('')
  const [rows, setRows] = useState<PlannedExpense[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editing, setEditing] = useState<PlannedExpense | null>(null)
  const [converting, setConverting] = useState<PlannedExpense | null>(null)
  const [actual, setActual] = useState<FormState>(emptyForm)
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); setError('Chưa cấu hình kết nối Supabase.'); return }
    setLoading(true); setError('')
    const client = supabase
    const auth = await client.auth.getUser()
    const ownerId = auth.data.user?.id ?? ''
    if (!ownerId) { setLoading(false); setError('Bạn cần đăng nhập để xem khoản chi dự kiến.'); return }
    if (!navigator.onLine) {
      setUserId(ownerId)
      setRows(await getPendingPlannedExpenses(ownerId))
      setLoading(false)
      return
    }
    await flushPlannedExpenseOutbox(ownerId)
    const [plans, categoryResult, walletResult, pending] = await Promise.all([
      client.from('planned_expenses').select('id,amount_bigint::text,expected_date,category_id,wallet_id,note,reminder_days,status,converted_transaction_id,version,created_at,updated_at').order('expected_date').order('id'),
      client.from('categories').select('id,name').eq('kind', 'expense').order('name'),
      client.from('wallets').select('id,display_name').eq('status', 'active').order('display_name'),
      getPendingPlannedExpenses(ownerId),
    ])
    if (plans.error || categoryResult.error || walletResult.error) setError('Không tải được dữ liệu dự kiến. Hãy kiểm tra kết nối và migration rồi thử lại.')
    else {
      const remote = (plans.data ?? []) as PlannedExpense[]
      setRows([...pending.filter(item => !remote.some(row => row.id === item.id)), ...remote])
      setCategories((categoryResult.data ?? []) as Category[])
      setWallets((walletResult.data ?? []) as Wallet[])
      setUserId(ownerId)
      const firstWallet = walletResult.data?.[0]
      if (firstWallet) setForm(current => current.walletId ? current : ({ ...current, walletId: firstWallet.id }))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { const online = () => void refresh(); window.addEventListener('online', online); return () => window.removeEventListener('online', online) }, [refresh])

  const visible = useMemo(() => rows.filter(row => tab === 'active' ? row.status === 'planned' : row.status !== 'planned'), [rows, tab])
  const activeTotal = useMemo(() => rows.reduce((sum, row) => row.status === 'planned' ? sum + BigInt(row.amount_bigint) : sum, 0n), [rows])

  function validate(state: FormState) {
    if (!state.note.trim() || state.note.trim().length > 240) throw new Error('Nội dung cần từ 1 đến 240 ký tự.')
    if (parseVnd(state.amount) <= 0n) throw new Error('Số tiền phải là số đồng nguyên dương.')
    if (!state.expectedDate) throw new Error('Hãy chọn ngày dự kiến.')
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    try { validate(form) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dữ liệu chưa hợp lệ.'); return }
    if (!supabase || !userId) { setError('Bạn cần đăng nhập để lưu.'); return }
    setBusy(true)
    const id = editing?.id ?? crypto.randomUUID()
    if (!editing && !navigator.onLine) {
      const input: PlannedExpenseInput = { id, amount_bigint: form.amount, expected_date: form.expectedDate, category_id: form.categoryId || null, wallet_id: form.walletId || null, note: form.note.trim(), reminder_days: Number(form.reminderDays), idempotency_key: crypto.randomUUID() }
      await queuePlannedExpense(userId, input)
      setNotice('Đã lưu trên thiết bị. Khoản dự kiến sẽ tự đồng bộ khi có mạng.')
      setForm({ ...emptyForm(), walletId: wallets[0]?.id ?? '' }); await refresh(); setBusy(false); return
    }
    let result
    try {
      result = editing
        ? await supabase.rpc('update_planned_expense', { p_id: editing.id, p_expected_version: editing.version, p_amount_bigint: form.amount, p_expected_date: form.expectedDate, p_category_id: form.categoryId || null, p_wallet_id: form.walletId || null, p_note: form.note.trim(), p_reminder_days: Number(form.reminderDays) })
        : await supabase.rpc('create_planned_expense', { p_id: id, p_amount_bigint: form.amount, p_expected_date: form.expectedDate, p_category_id: form.categoryId || null, p_wallet_id: form.walletId || null, p_note: form.note.trim(), p_reminder_days: Number(form.reminderDays), p_idempotency_key: crypto.randomUUID() })
    } catch {
      setError('Không lưu được khoản dự kiến. Hãy kiểm tra kết nối và thử lại.')
      setBusy(false)
      return
    }
    if (result.error) setError(result.error.code === '40001' ? 'Khoản dự kiến vừa được thay đổi ở thiết bị khác. Hãy tải lại.' : 'Không lưu được khoản dự kiến. Hãy kiểm tra dữ liệu và thử lại.')
    else { setNotice(editing ? 'Đã cập nhật khoản chi dự kiến.' : 'Đã thêm khoản chi dự kiến.'); setEditing(null); setForm({ ...emptyForm(), walletId: wallets[0]?.id ?? '' }); await refresh(); window.dispatchEvent(new Event('moneymate:financial-change')) }
    setBusy(false)
  }

  function edit(row: PlannedExpense) {
    setEditing(row); setConverting(null)
    setForm({ note: row.note, amount: row.amount_bigint, expectedDate: row.expected_date, categoryId: row.category_id ?? '', walletId: row.wallet_id ?? wallets[0]?.id ?? '', reminderDays: String(row.reminder_days) })
    document.getElementById('planned-form-title')?.scrollIntoView({ behavior: 'smooth' })
  }

  function openConversion(row: PlannedExpense) {
    setConverting(row); setEditing(null)
    setActual({ note: row.note, amount: row.amount_bigint, expectedDate: hcmDate(), categoryId: row.category_id ?? '', walletId: row.wallet_id ?? wallets[0]?.id ?? '', reminderDays: '0' })
  }

  async function convert(event: React.FormEvent) {
    event.preventDefault(); if (!converting || !supabase) return
    setError(''); setNotice('')
    try { validate(actual); if (!actual.walletId) throw new Error('Hãy chọn ví thực tế đã chi.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dữ liệu chưa hợp lệ.'); return }
    setBusy(true)
    const occurredAt = new Date(`${actual.expectedDate}T12:00:00+07:00`).toISOString()
    try {
      const result = await supabase.rpc('convert_planned_expense', { p_id: converting.id, p_expected_version: converting.version, p_wallet_id: actual.walletId, p_amount_bigint: actual.amount, p_occurred_at: occurredAt, p_accounting_date: actual.expectedDate, p_category_id: actual.categoryId || null, p_note: actual.note.trim(), p_idempotency_key: crypto.randomUUID() })
      if (result.error) setError('Không thể ghi khoản chi thực tế. Số dư ví chưa thay đổi; hãy tải lại và thử lại.')
      else { setConverting(null); setNotice('Đã ghi khoản chi thực tế và giữ lại kế hoạch để đối chiếu.'); await refresh(); window.dispatchEvent(new Event('moneymate:financial-change')) }
    } catch {
      setError('Không thể ghi khoản chi thực tế. Số dư ví chưa thay đổi; hãy tải lại và thử lại.')
    } finally { setBusy(false) }
  }

  async function changeStatus(row: PlannedExpense, status: 'planned' | 'skipped' | 'cancelled') {
    if (!supabase || row.pending) return
    const accepted = await confirm({ title: status === 'planned' ? 'Khôi phục khoản dự kiến?' : status === 'skipped' ? 'Đánh dấu bỏ qua?' : 'Hủy khoản dự kiến?', description: 'Thao tác này không tạo hoặc xóa giao dịch thực tế.', confirmLabel: status === 'planned' ? 'Khôi phục' : status === 'skipped' ? 'Bỏ qua' : 'Hủy khoản', tone: status === 'cancelled' ? 'danger' : 'neutral' })
    if (!accepted) return
    setBusy(true); setError('')
    const { error: rpcError } = await supabase.rpc('set_planned_expense_status', { p_id: row.id, p_expected_version: row.version, p_status: status })
    if (rpcError) setError('Không cập nhật được trạng thái. Hãy tải lại và thử lại.')
    else { setNotice(status === 'planned' ? 'Đã khôi phục khoản dự kiến.' : 'Đã cập nhật trạng thái.'); await refresh(); window.dispatchEvent(new Event('moneymate:financial-change')) }
    setBusy(false)
  }

  const categoryName = (id: string | null) => categories.find(item => item.id === id)?.name ?? 'Chưa phân loại'
  const walletName = (id: string | null) => wallets.find(item => item.id === id)?.display_name ?? 'Chưa chọn ví'

  return <section className="planned-page" aria-labelledby="planned-title">
    <LoadingModal show={loading} message="Đang tải khoản chi dự kiến…" />
    <header className="content-heading"><div><p className="eyebrow">CHỦ ĐỘNG TRƯỚC KHI CHI</p><h1 id="planned-title">Khoản chi dự kiến</h1><p className="subheading">Lên kế hoạch trước; ví và chi tiêu thực tế chỉ thay đổi khi bạn xác nhận đã chi.</p></div><div className="planned-total"><CalendarClock size={20}/><span>Đang dự kiến</span><strong>{formatVnd(activeTotal)}</strong></div></header>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="budget-success" role="status">{notice}</p>}
    <form className="planned-form" onSubmit={save}><div className="planned-form-heading"><div><span className="budget-form-kicker">{editing ? 'CHỈNH SỬA' : 'KẾ HOẠCH MỚI'}</span><h2 id="planned-form-title">{editing ? 'Cập nhật khoản dự kiến' : 'Thêm khoản dự kiến'}</h2></div>{editing && <Button type="button" variant="secondary" onClick={() => { setEditing(null); setForm({ ...emptyForm(), walletId: wallets[0]?.id ?? '' }) }}>Hủy sửa</Button>}</div><div className="planned-form-grid"><label>Nội dung<Input value={form.note} maxLength={240} onChange={event => setForm({ ...form, note: event.target.value })} placeholder="Ví dụ: Tiền điện tháng này" required/></label><label>Số tiền dự kiến (₫)<Input inputMode="numeric" value={form.amount} onChange={event => setForm({ ...form, amount: normalizeVndInput(event.target.value) })} required/><AmountInWords id="planned-amount" value={form.amount}/></label><label>Ngày dự kiến<Input type="date" value={form.expectedDate} onChange={event => setForm({ ...form, expectedDate: event.target.value })} required/></label><label>Nhắc trước<Dropdown value={form.reminderDays} onChange={event => setForm({ ...form, reminderDays: event.target.value })}>{[0,1,3,7,14,30].map(day => <option key={day} value={day}>{day === 0 ? 'Đúng ngày' : `${day} ngày`}</option>)}</Dropdown></label><label>Danh mục<Dropdown value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="">Chưa phân loại</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Dropdown></label><label>Ví dự kiến<Dropdown value={form.walletId} onChange={event => setForm({ ...form, walletId: event.target.value })}><option value="">Chọn sau</option>{wallets.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</Dropdown></label></div><Button variant="primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <CirclePlus size={18}/>} {editing ? 'Lưu thay đổi' : 'Thêm dự kiến'}</Button></form>
    <div className="planned-tabs" role="tablist" aria-label="Lọc khoản dự kiến"><Button role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')}><CalendarClock size={17}/> Đang dự kiến</Button><Button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}><History size={17}/> Lịch sử</Button></div>
    {!loading && visible.length === 0 ? <div className="wallet-empty"><CalendarClock size={30}/><h2>{tab === 'active' ? 'Chưa có khoản chi dự kiến' : 'Chưa có lịch sử'}</h2><p>{tab === 'active' ? 'Thêm khoản đầu tiên để thấy số tiền sắp cần chi.' : 'Khoản đã chi, bỏ qua hoặc hủy sẽ nằm ở đây.'}</p></div> : <ul className="planned-list">{visible.map(row => <li key={row.id} className={`planned-card ${row.status}`}><div className="planned-card-main"><span className={`planned-due ${row.status === 'planned' ? dueState(row.expected_date) : row.status}`}>{row.status === 'planned' ? dueState(row.expected_date) === 'overdue' ? 'Quá hạn' : dueState(row.expected_date) === 'today' ? 'Hôm nay' : formatDate(row.expected_date) : row.status === 'converted' ? 'Đã chi' : row.status === 'skipped' ? 'Đã bỏ qua' : 'Đã hủy'}</span><h3>{row.note}</h3><strong>{formatVnd(row.amount_bigint)}</strong><p>{categoryName(row.category_id)} · {walletName(row.wallet_id)}</p>{row.pending && <small className="planned-offline"><CloudOff size={14}/> Chờ đồng bộ</small>}</div><div className="planned-actions">{row.status === 'planned' ? <><Button variant="primary" onClick={() => openConversion(row)} disabled={row.pending || busy}><CheckCircle2 size={16}/> Đã chi</Button><Button variant="secondary" onClick={() => edit(row)} disabled={row.pending || busy}><Pencil size={16}/> Sửa</Button><Button variant="secondary" onClick={() => void changeStatus(row, 'skipped')} disabled={row.pending || busy}>Bỏ qua</Button><Button variant="danger" onClick={() => void changeStatus(row, 'cancelled')} disabled={row.pending || busy}><XCircle size={16}/> Hủy</Button></> : row.status !== 'converted' && <Button variant="secondary" onClick={() => void changeStatus(row, 'planned')} disabled={busy}><RotateCcw size={16}/> Khôi phục</Button>}</div>{converting?.id === row.id && <form className="planned-convert" onSubmit={convert}><h4><WalletCards size={17}/> Ghi khoản chi thực tế</h4><p>Bạn có thể sửa số tiền, ngày, ví và danh mục trước khi ghi sổ.</p><div className="planned-form-grid"><label>Số tiền thực tế (₫)<Input inputMode="numeric" value={actual.amount} onChange={event => setActual({ ...actual, amount: normalizeVndInput(event.target.value) })} required/><AmountInWords id="planned-actual-amount" value={actual.amount}/></label><label>Ngày chi<Input type="date" value={actual.expectedDate} onChange={event => setActual({ ...actual, expectedDate: event.target.value })} required/></label><label>Ví đã chi<Dropdown value={actual.walletId} onChange={event => setActual({ ...actual, walletId: event.target.value })} required><option value="">Chọn ví</option>{wallets.map(item => <option key={item.id} value={item.id}>{item.display_name}</option>)}</Dropdown></label><label>Danh mục<Dropdown value={actual.categoryId} onChange={event => setActual({ ...actual, categoryId: event.target.value })}><option value="">Chưa phân loại</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Dropdown></label><label className="planned-note-field">Ghi chú<Textarea value={actual.note} maxLength={240} onChange={event => setActual({ ...actual, note: event.target.value })}/></label></div><div className="planned-actions"><Button type="submit" variant="primary" disabled={busy}>Xác nhận đã chi</Button><Button type="button" variant="secondary" onClick={() => setConverting(null)}>Đóng</Button></div></form>}</li>)}</ul>}
  </section>
}

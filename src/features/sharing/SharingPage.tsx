import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clipboard, HandCoins, Link2, Plus, RefreshCw, ShieldCheck, Trash2, Users, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { formatDate, formatDateTime } from '../../shared/lib/dateFormat'
import { calculateLineTotal, parsePercentBasisPoints, splitAmongMembers, splitByPercentages, validateMemberAllocations } from '../../shared/lib/sharedSplits'
import { fetchAllPages } from '../../shared/lib/pagination'
import { createUuid } from '../../shared/lib/uuid'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { useConfirm } from '../../shared/ui/useConfirm'
import { ReceiptAutofill } from '../../shared/ui/ReceiptAutofill'

type Connection = { id: string; member_a_id: string; member_b_id: string; created_at: string }
type ConnectionMember = { connection_id: string; user_id: string; display_name: string; avatar_storage_path?: string | null; avatar_url?: string | null; role: 'owner'|'member'; joined_at: string }
type Balance = { connection_id: string; partner_id: string; amount_owed_by_me_bigint: string }
type Wallet = { id: string; display_name: string }
type Category = { id: string; name: string }
type Expense = { id: string; connection_id: string; payer_user_id: string; created_by: string; description: string; total_bigint: string; status: string; version: number; created_at: string; dispute_note: string; approved_by: string | null }
type ExpenseItem = { id: string; shared_expense_id: string; name: string; quantity: string; unit_price_bigint: string; final_total_bigint: string; position: number }
type Allocation = { shared_expense_id: string; expense_item_id: string; participant_id: string; split_mode: string; amount_bigint: string }
type ExpenseApproval = { expense_id: string; participant_id: string }
type Settlement = { id: string; connection_id: string; payer_id: string; receiver_id: string; amount_bigint: string; status: string; version: number; created_at: string }
type PaymentRequest = { id: string; connection_id: string; requester_id: string; payer_id: string; amount_bigint: string; note: string; due_date: string|null; status: 'pending'|'accepted'|'declined'|'cancelled'; version: number; created_at: string }
type SharedActivityRecord =
  | { type: 'expense'; id: string; created_at: string; record: Expense }
  | { type: 'settlement'; id: string; created_at: string; record: Settlement }
type BillItemDraft = { id: string; name: string; quantity: string; unitPrice: string; mode: 'equal'|'custom'|'percent'; participantIds: string[]|null; manualShares: Record<string,string> }
type SharingData = { connections: Connection[]; members: ConnectionMember[]; balances: Balance[]; expenses: Expense[]; items: ExpenseItem[]; allocations: Allocation[]; approvals: ExpenseApproval[]; settlements: Settlement[]; paymentRequests: PaymentRequest[]; wallets: Wallet[]; categories: Category[] }
const SHARED_ACTIVITY_PAGE_SIZE = 50

const todayHcm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
const newBillItem = (): BillItemDraft => ({ id: createUuid(), name: '', quantity: '1', unitPrice: '', mode: 'equal', participantIds: null, manualShares: {} })
const emptyData: SharingData = { connections: [], members: [], balances: [], expenses: [], items: [], allocations: [], approvals: [], settlements: [], paymentRequests: [], wallets: [], categories: [] }

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
function readToken(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try { return new URL(trimmed).searchParams.get('invite') ?? '' } catch { return '' }
  }
  return trimmed
}
function providerError(error: { code?: string; message?: string } | null) {
  if (!error) return ''
  const message = (error.message ?? '').toLowerCase()
  if (message.includes('invite is invalid or expired')) return 'Lời mời không hợp lệ, đã dùng hoặc đã hết hạn.'
  if (message.includes('cannot redeem your own invite')) return 'Bạn không thể chấp nhận lời mời do chính mình tạo.'
  if (message.includes('rate limit')) return 'Bạn đã tạo quá nhiều lời mời trong 24 giờ. Hãy thử lại sau.'
  if (message.includes('idempotency key reused')) return 'Dữ liệu gửi lại khác lần trước. Hãy chỉnh sửa rồi thử lại.'
  if (message.includes('proposal changed')) return 'Khoản chia đã thay đổi. Tải lại danh sách trước khi xác nhận.'
  if (message.includes('settlement exceeds')) return 'Số tiền vượt khoản nợ đã xác nhận còn lại.'
  if (message.includes('shared space member limit')) return 'Nhóm đã đủ 20 thành viên.'
  if (message.includes('already a member')) return 'Tài khoản này đã ở trong nhóm.'
  if (message.includes('payment request member unavailable')) return 'Người nhận đề nghị không thuộc nhóm hiện tại.'
  if (message.includes('no amount is allocated')) return 'Khoản chi này không có phần được chia cho bạn.'
  if (message.includes('only the group owner')) return 'Chỉ người tạo nhóm mới có thể đóng toàn bộ nhóm.'
  if (message.includes('active connection unavailable')) return 'Kết nối này không còn hoạt động. Hãy tải lại trang.'
  return 'Không hoàn tất được thao tác. Kiểm tra kết nối, quyền truy cập và thử lại.'
}

export function SharingPage() {
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()
  const [userId, setUserId] = useState('')
  const [data, setData] = useState<SharingData>(emptyData)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreActivity, setHasMoreActivity] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inviteInput, setInviteInput] = useState(searchParams.get('invite') ?? '')
  const [inviteUrl, setInviteUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const inviteLinkRef = useRef<HTMLInputElement>(null)
  const [showBillForm, setShowBillForm] = useState(false)
  const [description, setDescription] = useState('')
  const [walletId, setWalletId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [date, setDate] = useState(todayHcm())
  const [billItems, setBillItems] = useState<BillItemDraft[]>([newBillItem()])
  const [scannedBillTotal, setScannedBillTotal] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => createUuid())
  const [settlementAmount, setSettlementAmount] = useState('')
  const [settlementReceiverId, setSettlementReceiverId] = useState('')
  const [settlementWalletId, setSettlementWalletId] = useState('')
  const [settlementKey, setSettlementKey] = useState(() => createUuid())
  const [showPaymentRequestForm, setShowPaymentRequestForm] = useState(false)
  const [paymentRequestTarget, setPaymentRequestTarget] = useState('')
  const [paymentRequestAmount, setPaymentRequestAmount] = useState('')
  const [paymentRequestNote, setPaymentRequestNote] = useState('')
  const [paymentRequestDueDate, setPaymentRequestDueDate] = useState('')
  const [paymentRequestKey, setPaymentRequestKey] = useState(() => createUuid())

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true); setError('')
    const client = supabase
    const { data: userData, error: authError } = await client.auth.getUser()
    if (authError || !userData.user) { setError('Cần đăng nhập để sử dụng chia tiền.'); setLoading(false); return }
    setUserId(userData.user.id)
    const connectionResult = await fetchAllPages((from, to) => client.from('connections')
      .select('id,member_a_id,member_b_id,created_at').eq('status', 'active')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to), 50)
    if (connectionResult.error) { setError('Không tải được kết nối. Kiểm tra quyền RLS và thử tải lại.'); setLoading(false); return }
    const connections = (connectionResult.data ?? []) as Connection[]
    const connectionIds = connections.map(connection => connection.id)
    if (connectionIds.length === 0) {
      setData({ ...emptyData, connections })
      setSelectedId('')
      setLoading(false)
      return
    }
    const [memberResult, balanceResult, expenseResult, settlementResult, paymentRequestResult, walletResult, categoryResult] = await Promise.all([
      fetchAllPages((from, to) => client.from('connection_members').select('connection_id,user_id,display_name,avatar_storage_path,role,joined_at').in('connection_id', connectionIds).order('connection_id').order('joined_at').range(from, to)),
      fetchAllPages((from, to) => client.from('connection_balances')
        .select('connection_id,partner_id,amount_owed_by_me_bigint').in('connection_id', connectionIds)
        .order('connection_id').order('partner_id').range(from, to)),
      client.from('shared_expenses').select('id,connection_id,payer_user_id,created_by,description,total_bigint,status,version,created_at,dispute_note,approved_by').in('connection_id', connectionIds).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, SHARED_ACTIVITY_PAGE_SIZE - 1),
      client.from('settlements').select('id,connection_id,payer_id,receiver_id,amount_bigint,status,version,created_at').in('connection_id', connectionIds).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, SHARED_ACTIVITY_PAGE_SIZE - 1),
      fetchAllPages((from, to) => client.from('payment_requests').select('id,connection_id,requester_id,payer_id,amount_bigint,note,due_date,status,version,created_at').in('connection_id', connectionIds).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to), 50),
      fetchAllPages((from, to) => client.from('wallets').select('id,display_name')
        .eq('status', 'active').order('display_name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('categories').select('id,name').eq('kind', 'expense')
        .order('name').order('id').range(from, to))
    ])
    const expenses = (expenseResult.data ?? []) as Expense[]
    const expenseIds = expenses.map(expense => expense.id)
    const [itemResult, allocationResult, approvalResult] = expenseIds.length ? await Promise.all([
      fetchAllPages((from, to) => client.from('shared_expense_items')
        .select('id,shared_expense_id,name,quantity,unit_price_bigint,final_total_bigint,position')
        .in('shared_expense_id', expenseIds).order('position').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('expense_allocations')
        .select('shared_expense_id,expense_item_id,participant_id,split_mode,amount_bigint')
        .in('shared_expense_id', expenseIds).order('shared_expense_id').order('expense_item_id').order('participant_id').range(from, to)),
      fetchAllPages((from, to) => client.from('shared_expense_approvals').select('expense_id,participant_id').in('expense_id', expenseIds).order('expense_id').order('participant_id').range(from, to))
    ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
    if (memberResult.error || balanceResult.error || expenseResult.error || settlementResult.error || paymentRequestResult.error || walletResult.error || categoryResult.error || itemResult.error || allocationResult.error || approvalResult.error) {
      setError('Không tải đầy đủ được dữ liệu chia tiền. Kiểm tra migration/RLS và thử lại.')
    } else {
      const members = (memberResult.data ?? []) as ConnectionMember[]
      await Promise.all(members.map(async member => {
        if (!member.avatar_storage_path) return
        const { data: signed } = await client.storage.from('profile-avatars').createSignedUrl(member.avatar_storage_path, 3600)
        member.avatar_url = signed?.signedUrl ?? null
      }))
      setData({ connections, members, balances: (balanceResult.data ?? []) as Balance[], expenses, settlements: (settlementResult.data ?? []) as Settlement[], paymentRequests: (paymentRequestResult.data ?? []) as PaymentRequest[], wallets: (walletResult.data ?? []) as Wallet[], categories: (categoryResult.data ?? []) as Category[], items: (itemResult.data ?? []) as ExpenseItem[], allocations: (allocationResult.data ?? []) as Allocation[], approvals: (approvalResult.data ?? []) as ExpenseApproval[] })
      setHasMoreActivity(expenses.length === SHARED_ACTIVITY_PAGE_SIZE || (settlementResult.data ?? []).length === SHARED_ACTIVITY_PAGE_SIZE)
      setSelectedId(current => connectionIds.includes(current) ? current : connectionIds[0] ?? '')
      setWalletId(current => current || ((walletResult.data ?? [])[0]?.id ?? ''))
      setSettlementWalletId(current => current || ((walletResult.data ?? [])[0]?.id ?? ''))
      setSettlementReceiverId(current => current || ((balanceResult.data ?? []) as Balance[]).find(item => item.connection_id === connections[0]?.id && BigInt(item.amount_owed_by_me_bigint)>0n)?.partner_id || '')
    }
    setLoading(false)
  }, [])

  const loadMoreActivity = useCallback(async () => {
    if (!supabase || loadingMore || !hasMoreActivity || data.connections.length === 0) return
    setLoadingMore(true)
    const connectionIds = data.connections.map(item => item.id)
    const [expenseResult, settlementResult] = await Promise.all([
      supabase.from('shared_expenses').select('id,connection_id,payer_user_id,created_by,description,total_bigint,status,version,created_at,dispute_note,approved_by')
        .in('connection_id', connectionIds).order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(data.expenses.length, data.expenses.length + SHARED_ACTIVITY_PAGE_SIZE - 1),
      supabase.from('settlements').select('id,connection_id,payer_id,receiver_id,amount_bigint,status,version,created_at')
        .in('connection_id', connectionIds).order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(data.settlements.length, data.settlements.length + SHARED_ACTIVITY_PAGE_SIZE - 1),
    ])
    if (expenseResult.error || settlementResult.error) {
      setError('Không tải thêm được hoạt động chia tiền. Hãy thử lại.')
    } else {
      const expenses = (expenseResult.data ?? []) as Expense[]
      const settlements = (settlementResult.data ?? []) as Settlement[]
      const expenseIds = expenses.map(item => item.id)
      const client = supabase
      const [itemsResult, allocationResult] = expenseIds.length ? await Promise.all([
        fetchAllPages((from, to) => client.from('shared_expense_items')
          .select('id,shared_expense_id,name,quantity,unit_price_bigint,final_total_bigint,position')
          .in('shared_expense_id', expenseIds).order('position').order('id').range(from, to)),
        fetchAllPages((from, to) => client.from('expense_allocations')
          .select('shared_expense_id,expense_item_id,participant_id,split_mode,amount_bigint')
          .in('shared_expense_id', expenseIds).order('shared_expense_id').order('expense_item_id').order('participant_id').range(from, to)),
      ]) : [{ data: [], error: null }, { data: [], error: null }]
      if (itemsResult.error || allocationResult.error) {
        setError('Không tải đầy đủ chi tiết hoạt động chia tiền. Hãy thử lại.')
      } else {
        setData(current => ({
          ...current,
          expenses: [...current.expenses, ...expenses],
          settlements: [...current.settlements, ...settlements],
          items: [...current.items, ...(itemsResult.data ?? []) as ExpenseItem[]],
          allocations: [...current.allocations, ...(allocationResult.data ?? []) as Allocation[]],
        }))
        setHasMoreActivity(expenses.length === SHARED_ACTIVITY_PAGE_SIZE || settlements.length === SHARED_ACTIVITY_PAGE_SIZE)
        setError('')
      }
    }
    setLoadingMore(false)
  }, [data.connections, data.expenses.length, data.settlements.length, hasMoreActivity, loadingMore])

  useEffect(() => {
    const update = () => { void refresh() }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { const token = searchParams.get('invite'); if (token) setInviteInput(token) }, [searchParams])

  const connection = data.connections.find(item => item.id === selectedId)
  const connectionMembers = data.members.filter(member => member.connection_id === selectedId)
  const participantIds = connectionMembers.map(member => member.user_id)
  const balancesForConnection = data.balances.filter(item => item.connection_id === selectedId)
  const payableBalances = balancesForConnection.filter(item => BigInt(item.amount_owed_by_me_bigint)>0n)
  const totalPayable = payableBalances.reduce((sum,item)=>sum+BigInt(item.amount_owed_by_me_bigint),0n)
  const totalReceivable = balancesForConnection.filter(item=>BigInt(item.amount_owed_by_me_bigint)<0n).reduce((sum,item)=>sum-BigInt(item.amount_owed_by_me_bigint),0n)
  const settlementBalance = payableBalances.find(item => item.partner_id===settlementReceiverId) ?? payableBalances[0]
  const netAmount = settlementBalance ? BigInt(settlementBalance.amount_owed_by_me_bigint) : 0n
  useEffect(()=>{setSettlementReceiverId(data.balances.find(item=>item.connection_id===selectedId&&BigInt(item.amount_owed_by_me_bigint)>0n)?.partner_id??'')},[selectedId,data.balances])
  const expenses = useMemo(() => data.expenses.filter(expense => expense.connection_id === selectedId), [data.expenses, selectedId])
  const settlements = useMemo(() => data.settlements.filter(settlement => settlement.connection_id === selectedId), [data.settlements, selectedId])
  const activityRecords = useMemo<SharedActivityRecord[]>(() => [
    ...expenses.map(record => ({ type: 'expense' as const, id: record.id, created_at: record.created_at, record })),
    ...settlements.map(record => ({ type: 'settlement' as const, id: record.id, created_at: record.created_at, record })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)), [expenses, settlements])
  const pendingExpenses = expenses.filter(expense => expense.status === 'pending')
  const pendingSettlements = settlements.filter(settlement => settlement.status === 'pending')
  const pendingForMe = pendingExpenses.filter(expense => data.allocations.some(allocation => allocation.shared_expense_id===expense.id && allocation.participant_id===userId && !data.approvals.some(approval=>approval.expense_id===expense.id && approval.participant_id===userId))).length
  const calculatedItems = billItems.map(item => {
    try {
      const total = calculateLineTotal(item.quantity, item.unitPrice)
      const selected = item.participantIds ?? participantIds
      const allocations = item.mode === 'equal'
        ? splitAmongMembers(total, selected)
        : item.mode==='percent'
          ? splitByPercentages(total,selected.map(id=>({participantId:id,basisPoints:parsePercentBasisPoints(item.manualShares[id]||'0')})))
          : validateMemberAllocations(total, selected.map(id => ({ participantId: id, amount: parseVnd(item.manualShares[id] || '0') })))
      return { ...item, total, allocations }
    } catch { return { ...item, total: null as bigint | null, allocations: [] as Array<{ participantId: string; amount: bigint }> } }
  })
  const billTotal = calculatedItems.reduce((sum, item) => sum + (item.total ?? 0n), 0n)
  const partnerShareTotal = calculatedItems.reduce((sum, item) => sum + item.allocations.filter(share => share.participantId !== userId).reduce((sub, share) => sub + share.amount, 0n), 0n)

  async function createInvite(targetConnectionId?: string) {
    if (!supabase) return
    setBusy(true); setError(''); setNotice(''); setInviteUrl('')
    const token = createToken()
    const { error: createError } = targetConnectionId
      ? await supabase.rpc('create_connection_member_invite', { p_token: token, p_connection_id: targetConnectionId })
      : await supabase.rpc('create_connection_invite', { p_token: token })
    if (createError) setError(providerError(createError))
    else { setInviteUrl(`${window.location.origin}/sharing?invite=${encodeURIComponent(token)}`); setCopied(false); setNotice(targetConnectionId ? 'Đã tạo lời mời tham gia nhóm. Liên kết dùng một lần và hết hạn sau 48 giờ.' : 'Lời mời có hiệu lực trong 48 giờ và chỉ dùng được một lần. Gửi liên kết này cho đúng người nhận.') }
    setBusy(false)
  }

  async function redeemInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return
    const token = readToken(inviteInput)
    if (token.length < 40) { setError('Dán liên kết lời mời MoneyMate hợp lệ.'); return }
    setBusy(true); setError(''); setNotice('')
    const { error: redeemError } = await supabase.rpc('redeem_connection_invite', { p_token: token })
    if (redeemError) setError(providerError(redeemError))
    else { setInviteInput(''); setSearchParams({}, { replace: true }); setNotice('Đã kết nối. Hai tài khoản chỉ thấy sổ chia tiền, không thấy ví và giao dịch riêng của nhau.'); await refresh() }
    setBusy(false)
  }

  async function copyInvite() {
    if (!inviteUrl) return
    try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); setNotice('Đã sao chép liên kết mời.') }
    catch { inviteLinkRef.current?.focus(); inviteLinkRef.current?.select(); setNotice('Không thể sao chép tự động trên kết nối này. Liên kết đã được chọn để bạn sao chép thủ công.') }
  }

  function updateItem(id: string, update: Partial<BillItemDraft>) {
    setIdempotencyKey(createUuid())
    setBillItems(items => items.map(item => item.id === id ? { ...item, ...update } : item))
  }

  async function submitBill(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !connection) return
    setError(''); setNotice('')
    if (!walletId) { setError('Thêm ví của bạn trước khi ghi khoản chi chung.'); return }
    if (calculatedItems.some(item => !item.name.trim() || item.total === null || item.allocations.length === 0 || item.total <= 0n)) { setError('Kiểm tra tên món, số lượng, đơn giá và phần chia của từng món.'); return }
    try { parseVnd(billTotal.toString()); if (billTotal <= 0n) throw new Error() } catch { setError('Tổng hóa đơn phải là số nguyên đồng dương hợp lệ.'); return }
    setBusy(true)
    const occurredAt = new Date(`${date}T12:00:00+07:00`).toISOString()
    const rpcItems = calculatedItems.map(item => ({ name: item.name.trim(), quantity: item.quantity.replace(',', '.'), unit_price: item.unitPrice, allocations: item.allocations.map(share => ({ participant_id: share.participantId, amount: share.amount.toString() })) }))
    const { error: saveError } = await supabase.rpc('create_shared_group_expense', { p_connection_id: connection.id, p_wallet_id: walletId, p_description: description.trim(), p_occurred_at: occurredAt, p_accounting_date: date, p_category_id: categoryId || null, p_items: rpcItems, p_idempotency_key: idempotencyKey })
    if (saveError) setError(providerError(saveError))
    else { setShowBillForm(false); setDescription(''); setBillItems([newBillItem()]); setIdempotencyKey(createUuid()); setNotice('Đã ghi khoản chi vào ví của bạn. Các thành viên được chia tiền sẽ nhận yêu cầu xác nhận.'); await refresh() }
    setBusy(false)
  }

  async function resolveExpense(expense: Expense, action: 'approve' | 'dispute' | 'cancel') {
    if (!supabase) return
    setBusy(true); setError(''); setNotice('')
    const { error: actionError } = action === 'approve'
      ? await supabase.rpc('approve_shared_expense', { p_expense_id: expense.id, p_expected_version: expense.version })
      : action === 'dispute'
        ? await supabase.rpc('dispute_shared_expense', { p_expense_id: expense.id, p_expected_version: expense.version, p_note: '' })
        : await supabase.rpc('cancel_shared_expense', { p_expense_id: expense.id, p_expected_version: expense.version })
    if (actionError) setError(providerError(actionError))
    else { setNotice(action === 'approve' ? 'Đã xác nhận khoản chia. Công nợ đã được cập nhật.' : action === 'dispute' ? 'Đã đánh dấu khoản chia cần trao đổi.' : 'Đã hủy đề nghị chia; giao dịch chi của bạn vẫn được giữ trong ví riêng.'); await refresh() }
    setBusy(false)
  }

  async function createSettlement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !connection || !settlementBalance) return
    let amount: bigint
    try { amount = parseVnd(settlementAmount); if (amount <= 0n || amount > netAmount) throw new Error() }
    catch { setError('Số tiền phải lớn hơn 0 và không vượt khoản đang nợ.'); return }
    if (!settlementWalletId) { setError('Chọn ví dùng để thanh toán.'); return }
    setBusy(true); setError('')
    const { error: saveError } = await supabase.rpc('create_group_settlement', { p_connection_id: connection.id, p_receiver_id: settlementBalance.partner_id, p_wallet_id: settlementWalletId, p_amount_bigint: amount.toString(), p_occurred_at: new Date().toISOString(), p_accounting_date: todayHcm(), p_idempotency_key: settlementKey })
    if (saveError) setError(providerError(saveError))
    else { setSettlementAmount(''); setSettlementKey(createUuid()); setNotice('Đã gửi đề nghị thanh toán; số dư sẽ cập nhật khi người nhận xác nhận.'); await refresh() }
    setBusy(false)
  }

  async function resolveSettlement(settlement: Settlement, approve: boolean) {
    if (!supabase) return
    setBusy(true); setError('')
    const { error: actionError } = await supabase.rpc('resolve_group_settlement', { p_settlement_id: settlement.id, p_expected_version: settlement.version, p_approve: approve })
    if (actionError) setError(providerError(actionError))
    else { setNotice(approve ? 'Đã xác nhận khoản thanh toán.' : 'Đã từ chối đề nghị thanh toán.'); await refresh() }
    setBusy(false)
  }

  async function createPaymentRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase || !connection) return
    let amount: bigint
    try { amount = parseVnd(paymentRequestAmount); if (amount <= 0n) throw new Error() }
    catch { setError('Số tiền đề nghị phải lớn hơn 0.'); return }
    if (!paymentRequestTarget || !paymentRequestNote.trim()) { setError('Chọn người nhận và ghi nội dung đề nghị.'); return }
    setBusy(true); setError('')
    const { error: saveError } = await supabase.rpc('create_payment_request', { p_connection_id: connection.id, p_payer_id: paymentRequestTarget, p_amount: amount.toString(), p_note: paymentRequestNote.trim(), p_due_date: paymentRequestDueDate || null, p_idempotency_key: paymentRequestKey })
    if (saveError) setError(providerError(saveError))
    else { setPaymentRequestAmount(''); setPaymentRequestNote(''); setPaymentRequestDueDate(''); setPaymentRequestKey(createUuid()); setShowPaymentRequestForm(false); setNotice('Đã gửi đề nghị thanh toán.'); await refresh() }
    setBusy(false)
  }

  async function resolvePaymentRequest(request: PaymentRequest, action: 'accept' | 'decline' | 'cancel') {
    if (!supabase) return
    setBusy(true); setError('')
    const { error: actionError } = await supabase.rpc('resolve_payment_request', { p_request_id: request.id, p_expected_version: request.version, p_action: action })
    if (actionError) setError(providerError(actionError))
    else { setNotice(action === 'accept' ? 'Đã chấp nhận đề nghị.' : action === 'decline' ? 'Đã từ chối đề nghị.' : 'Đã hủy đề nghị.'); await refresh() }
    setBusy(false)
  }

  async function disconnect() {
    if (!supabase || !connection) return
    const isOwner = connectionMembers.find(member => member.user_id === userId)?.role === 'owner'
    const accepted = await confirm({ title: isOwner ? 'Đóng nhóm chia tiền?' : 'Rời nhóm chia tiền?', description: 'Lịch sử đã xác nhận được lưu lại; nhóm và dữ liệu tương lai tuân theo quyền thành viên.', confirmLabel: isOwner ? 'Đóng nhóm' : 'Rời nhóm', tone: 'warning' })
    if (!accepted) return
    setBusy(true); setError('')
    const { error: actionError } = await supabase.rpc('leave_connection', { p_connection_id: connection.id })
    if (actionError) setError(providerError(actionError))
    else { setNotice(isOwner ? 'Đã đóng nhóm.' : 'Đã rời nhóm.'); setSelectedId(''); await refresh() }
    setBusy(false)
  }

  function renderActivity(activity: SharedActivityRecord) {
    if (activity.type === 'expense') {
      const expense = activity.record
      const items = data.items.filter(item => item.shared_expense_id === expense.id)
      const approvedByMe = data.approvals.some(approval=>approval.expense_id===expense.id && approval.participant_id===userId)
      const myShare = data.allocations.filter(allocation=>allocation.shared_expense_id===expense.id && allocation.participant_id===userId).reduce((sum,allocation)=>sum+BigInt(allocation.amount_bigint),0n)
      return <article className="shared-record-card" key={expense.id}>
        <div className="shared-record-main"><span className={`shared-record-mark ${expense.status}`}><HandCoins size={18} /></span><div className="shared-record-copy"><div className="shared-record-title"><strong>{expense.description}</strong><span className={`shared-status ${expense.status}`}>{expense.status === 'pending' ? 'Chờ xác nhận' : expense.status === 'approved' ? 'Đã xác nhận' : expense.status === 'disputed' ? 'Cần trao đổi' : 'Đã hủy'}</span></div><small>{formatDateTime(expense.created_at)} · {expense.payer_user_id === userId ? 'Bạn đã thanh toán' : `${connectionMembers.find(member=>member.user_id===expense.payer_user_id)?.display_name??'Thành viên'} đã thanh toán`} · {items.length} món</small></div><b>{formatVnd(expense.total_bigint)}</b></div>
        {items.length > 0 && <ul className="shared-record-items">{items.map(item => { const shares = data.allocations.filter(allocation => allocation.expense_item_id === item.id); return <li key={item.id}><span>{item.name} · {item.quantity} × {formatVnd(item.unit_price_bigint)}</span><small>{shares.map(share=>`${connectionMembers.find(member=>member.user_id===share.participant_id)?.display_name??'Thành viên'} ${formatVnd(share.amount_bigint)}`).join(' · ')}</small></li> })}</ul>}
        {expense.dispute_note && <p className="dispute-note">Ghi chú trao đổi: {expense.dispute_note}</p>}
        {expense.status === 'pending' && <div className="shared-record-actions">{expense.created_by === userId ? <><span>Đang chờ các thành viên xác nhận phần của mình</span><CommonButton type="button" className="text-button" onClick={() => void resolveExpense(expense, 'cancel')} disabled={busy}>Hủy đề nghị</CommonButton></> : myShare===0n ? <span>Bạn không có phần trong khoản chi này.</span> : approvedByMe ? <span>Bạn đã xác nhận phần {formatVnd(myShare)} · đang chờ thành viên khác</span> : <><CommonButton type="button" className="secondary-button" onClick={() => void resolveExpense(expense, 'dispute')} disabled={busy}><X size={15} />Trao đổi</CommonButton><CommonButton type="button" className="primary-button" onClick={() => void resolveExpense(expense, 'approve')} disabled={busy}><Check size={15} />Xác nhận phần {formatVnd(myShare)}</CommonButton></>}</div>}
        {expense.status === 'approved' && <small className="confirmation-caption">Các phần đã được xác nhận · công nợ nhóm đã ghi một lần</small>}
      </article>
    }

    const settlement = activity.record
    return <article className="shared-record-card settlement-record" key={settlement.id}><div className="shared-record-main"><span className="shared-record-mark settlement"><Check size={18} /></span><div className="shared-record-copy"><div className="shared-record-title"><strong>Thanh toán công nợ</strong><span className={`shared-status ${settlement.status}`}>{settlement.status === 'pending' ? 'Chờ xác nhận' : settlement.status === 'confirmed' ? 'Đã xác nhận' : settlement.status === 'rejected' ? 'Đã từ chối' : 'Đã hủy'}</span></div><small>{settlement.payer_id === userId ? 'Bạn đề nghị trả' : 'Thành viên đề nghị trả'} · {formatDateTime(settlement.created_at)}</small></div><b>{formatVnd(settlement.amount_bigint)}</b></div>{settlement.status === 'pending' && settlement.receiver_id === userId && <div className="shared-record-actions"><span>Xác nhận sau khi nhận đủ tiền</span><CommonButton className="secondary-button" type="button" disabled={busy} onClick={() => void resolveSettlement(settlement, false)}>Từ chối</CommonButton><CommonButton className="primary-button" type="button" disabled={busy} onClick={() => void resolveSettlement(settlement, true)}><Check size={15} />Đã nhận tiền</CommonButton></div>}{settlement.status === 'pending' && settlement.payer_id === userId && <small className="confirmation-caption">Đang chờ người nhận xác nhận. Số dư chưa đổi.</small>}</article>
  }

  return <section className="sharing-page" aria-labelledby="sharing-title">
    <LoadingModal message="Đang tải không gian chia tiền…" show={loading} />
    <header className="content-heading"><div><p className="eyebrow">SỔ CHIA TIỀN NHÓM</p><h1 id="sharing-title">Chia tiền</h1><p className="subheading">Chia hóa đơn cho 2–20 thành viên; mỗi người xác nhận phần của mình trước khi ghi công nợ.</p></div><CommonButton type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading} aria-label="Làm mới kết nối"><RefreshCw className={loading ? 'spin' : ''} size={17} /></CommonButton></header>
    {error && <div className="form-error" role="alert">{error}<CommonButton type="button" onClick={() => void refresh()}>Thử lại</CommonButton></div>}{notice && <p className="sharing-notice" role="status">{notice}</p>}
    {loading && data.connections.length === 0 ? null : data.connections.length === 0 ? <div className="connection-start-grid">
      <section className="connection-card"><span className="connection-feature-icon"><Users size={21} /></span><h2>Tạo nhóm chia tiền</h2><p>Mời thành viên đầu tiên để bắt đầu nhóm 2–20 người và cùng ghi khoản chi đã chia. Ví riêng, số dư và giao dịch cá nhân vẫn được giữ riêng.</p><CommonButton type="button" className="primary-button" onClick={() => void createInvite()} disabled={busy}><Link2 size={17} />{busy ? 'Đang tạo…' : 'Tạo liên kết mời'}</CommonButton>{inviteUrl && <div className="invite-result"><label htmlFor="invite-link">Liên kết một lần · hết hạn sau 48 giờ</label><div className="invite-copy-row"><CommonInput id="invite-link" ref={inviteLinkRef} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} /><CommonButton type="button" className="secondary-button" onClick={() => void copyInvite()} aria-label="Sao chép liên kết mời">{copied ? <Check size={17} /> : <Clipboard size={17} />}</CommonButton></div><small>Token chỉ được lưu dạng hash trên máy chủ. Hãy gửi liên kết riêng cho đúng người nhận.</small></div>}</section>
      <section className="connection-card"><span className="connection-feature-icon muted"><ShieldCheck size={21} /></span><h2>Nhận lời mời</h2><p>Dán đường dẫn mà người kia gửi. Chỉ liên kết còn hạn và chưa sử dụng mới có thể được chấp nhận.</p><form className="redeem-form" onSubmit={redeemInvite}><label htmlFor="invite-input">Liên kết hoặc token lời mời</label><CommonInput id="invite-input" value={inviteInput} onChange={event => setInviteInput(event.target.value)} autoComplete="off" required /><CommonButton type="submit" className="primary-button" disabled={busy}><Check size={17} />{busy ? 'Đang kết nối…' : 'Chấp nhận lời mời'}</CommonButton></form></section>
    </div> : connection && <>
      <section className="shared-balance-card"><div className="shared-balance-top"><div><span className="balance-label">CÔNG NỢ CỦA BẠN TRONG NHÓM</span><strong>{totalPayable===0n?'Không còn khoản phải trả':formatVnd(totalPayable)}</strong><span>{totalReceivable>0n?`Bạn được hoàn lại ${formatVnd(totalReceivable)} từ các thành viên`:'Các khoản công nợ đã xác nhận'}</span></div><div className="connection-person"><Users size={20} /><span>Không gian chia tiền</span><small>{connectionMembers.length} thành viên</small></div></div>
        <div className="shared-balance-footer"><span>{pendingExpenses.length} đề nghị chia · {pendingSettlements.length} đề nghị thanh toán đang chờ</span><CommonButton type="button" className="text-button disconnect-button" onClick={() => void disconnect()} disabled={busy}>{connectionMembers.find(member=>member.user_id===userId)?.role==='owner'?'Đóng nhóm':'Rời nhóm'}</CommonButton></div>
      </section>
      <section className="shared-members-panel" aria-label="Thành viên nhóm">
        <div className="shared-members-heading"><div><p className="eyebrow">NHÓM CHIA TIỀN</p><h2>{connectionMembers.length} thành viên</h2><p>Không gian riêng cho các khoản đã được chia sẻ.</p></div><CommonButton type="button" className="secondary-button" onClick={() => void createInvite(connection?.id)} disabled={busy || !connection || connectionMembers.length >= 20}><Link2 size={16}/>{connectionMembers.length >= 20 ? 'Đã đủ 20 người' : 'Mời thành viên'}</CommonButton></div>
        <ul className="shared-member-list">{connectionMembers.map(member => {
          const balance=balancesForConnection.find(row=>row.partner_id===member.user_id)
          const amount=balance?BigInt(balance.amount_owed_by_me_bigint):0n
          const balanceLabel=member.user_id===userId?'Số dư đối soát cá nhân':amount>0n?`Bạn nợ ${formatVnd(amount)}`:amount<0n?`Được nhận ${formatVnd(-amount)}`:'Đã cân bằng'
          return <li key={member.user_id}><span className="member-avatar" aria-hidden="true">{member.avatar_url?<img src={member.avatar_url} alt=""/>:member.display_name.slice(0,1).toLocaleUpperCase('vi-VN')}</span><span><strong>{member.display_name}{member.user_id===userId?' · Bạn':''}</strong><small>{member.role==='owner'?'Người tạo nhóm':'Thành viên'} · {balanceLabel}</small></span></li>
        })}</ul>
        {inviteUrl && <div className="invite-result"><label htmlFor="invite-link">Liên kết mời nhóm · hết hạn sau 48 giờ</label><div className="invite-copy-row"><CommonInput id="invite-link" ref={inviteLinkRef} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} /><CommonButton type="button" className="secondary-button" onClick={() => void copyInvite()} aria-label="Sao chép liên kết mời nhóm">{copied ? <Check size={17}/> : <Clipboard size={17}/>}</CommonButton></div><small>Liên kết dùng một lần. Chỉ chia sẻ với đúng thành viên cần tham gia.</small></div>}
      </section>
      {data.connections.length > 1 && <div className="connection-picker"><label htmlFor="connection-select">Không gian chia tiền</label><CommonDropdown id="connection-select" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{data.connections.map(item => <option key={item.id} value={item.id}>Nhóm · {item.id.slice(0, 8).toUpperCase()}</option>)}</CommonDropdown></div>}
      <section className="payment-request-panel" aria-labelledby="payment-requests-title">
        <header className="payment-request-heading"><div><p className="eyebrow">THỎA THUẬN THANH TOÁN</p><h2 id="payment-requests-title">Nhắc thanh toán</h2><p>Nhắc một thành viên thanh toán. Đồng ý lời nhắc chưa có nghĩa là đã trả tiền.</p></div><CommonButton type="button" className="primary-button mobile-plus-action" aria-label={showPaymentRequestForm?'Đóng biểu mẫu nhắc thanh toán':'Tạo lời nhắc thanh toán'} title={showPaymentRequestForm?'Đóng biểu mẫu nhắc thanh toán':'Tạo lời nhắc thanh toán'} onClick={() => setShowPaymentRequestForm(value => !value)}>{showPaymentRequestForm?<X size={18} aria-hidden="true"/>:<Plus size={18} aria-hidden="true"/>}<span className="mobile-plus-label">{showPaymentRequestForm?'Đóng':'Tạo lời nhắc'}</span></CommonButton></header>
        {showPaymentRequestForm && <form className="payment-request-form" onSubmit={createPaymentRequest}>
          <ReceiptAutofill onApply={(suggestion) => {
            setPaymentRequestKey(createUuid())
            if (suggestion.total) setPaymentRequestAmount(suggestion.total)
            if (suggestion.merchant || suggestion.items.length) setPaymentRequestNote([suggestion.merchant, suggestion.items.map(item => item.name).join(', ')].filter(Boolean).join(' · '))
          }} />
          <div className="shared-field"><label htmlFor="payment-request-target">Gửi đến thành viên</label><CommonDropdown id="payment-request-target" value={paymentRequestTarget} onChange={event => { setPaymentRequestTarget(event.target.value); setPaymentRequestKey(createUuid()) }} required><option value="">Chọn người cần thanh toán</option>{connectionMembers.filter(member=>member.user_id!==userId).map(member=><option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</CommonDropdown></div>
          <div className="shared-field"><label htmlFor="payment-request-amount">Số tiền cần thanh toán (₫)</label><CommonInput id="payment-request-amount" inputMode="numeric" value={paymentRequestAmount} onChange={event=>{setPaymentRequestAmount(normalizeVndInput(event.target.value));setPaymentRequestKey(createUuid())}} required /></div>
          <div className="shared-field"><label htmlFor="payment-request-note">Nội dung</label><CommonInput id="payment-request-note" value={paymentRequestNote} maxLength={240} onChange={event=>{setPaymentRequestNote(event.target.value);setPaymentRequestKey(createUuid())}} placeholder="Ví dụ: Thanh toán tiền ăn tối" required /></div>
          <div className="shared-field"><label htmlFor="payment-request-due">Hạn thanh toán (không bắt buộc)</label><CommonInput id="payment-request-due" type="date" value={paymentRequestDueDate} onChange={event=>{setPaymentRequestDueDate(event.target.value);setPaymentRequestKey(createUuid())}} /></div>
          <div className="payment-request-form-footer"><small>Lời nhắc chưa ghi nhận tiền đã trả. Sau khi chuyển tiền, dùng mục “Ghi nhận trả tiền” bên dưới.</small><CommonButton type="submit" className="primary-button" disabled={busy}>Gửi lời nhắc</CommonButton></div>
        </form>}
        {data.paymentRequests.filter(request=>request.connection_id===selectedId).length===0 ? <div className="payment-request-empty"><HandCoins size={20}/><span>Chưa có lời nhắc thanh toán trong nhóm này.</span></div> : <ul className="payment-request-list">{data.paymentRequests.filter(request=>request.connection_id===selectedId).map(request=>{
          const requester=connectionMembers.find(member=>member.user_id===request.requester_id)?.display_name??'Thành viên'
          const payer=connectionMembers.find(member=>member.user_id===request.payer_id)?.display_name??'Thành viên'
          const pending=request.status==='pending'
          const statusLabel=request.status==='pending'?'Đang chờ':request.status==='accepted'?'Đã chấp nhận':request.status==='declined'?'Đã từ chối':'Đã hủy'
          return <li key={request.id} className="payment-request-card"><span className="payment-request-icon"><HandCoins size={19}/></span><div className="payment-request-copy"><strong>{formatVnd(BigInt(request.amount_bigint))}</strong><span>{request.note}</span><small>{requester} đề nghị {payer}{request.due_date?` · Hạn ${formatDate(request.due_date)}`:''}</small></div><span className={`payment-request-status ${pending?'pending':request.status}`}>{statusLabel}</span><div className="payment-request-actions">{pending&&request.payer_id===userId&&<><CommonButton type="button" className="secondary-button" disabled={busy} onClick={()=>void resolvePaymentRequest(request,'accept')}>Chấp nhận</CommonButton><CommonButton type="button" className="text-button" disabled={busy} onClick={()=>void resolvePaymentRequest(request,'decline')}>Từ chối</CommonButton></>}{pending&&request.requester_id===userId&&<CommonButton type="button" className="text-button" disabled={busy} onClick={()=>void resolvePaymentRequest(request,'cancel')}>Hủy lời nhắc</CommonButton>}</div></li>
        })}</ul>}
      </section>
      {payableBalances.length>0 && <form className="settlement-form" onSubmit={createSettlement}>
        <div><p className="eyebrow">ĐỐI SOÁT CÔNG NỢ</p><h2>Ghi nhận trả tiền</h2><p>Chọn người nhận và ví của bạn. Tiền chỉ được ghi nhận sau khi người nhận xác nhận.</p></div>
        <ReceiptAutofill onApply={(suggestion) => { setSettlementKey(createUuid()); if (suggestion.total) setSettlementAmount(suggestion.total) }} />
        <label htmlFor="settlement-member">Thanh toán cho</label><CommonDropdown id="settlement-member" value={settlementBalance?.partner_id??''} onChange={event=>{setSettlementReceiverId(event.target.value);setSettlementKey(createUuid());setSettlementAmount('')}} required>{payableBalances.map(balance=>{const member=connectionMembers.find(item=>item.user_id===balance.partner_id);return <option key={balance.partner_id} value={balance.partner_id}>{member?.display_name??'Thành viên'} · {formatVnd(BigInt(balance.amount_owed_by_me_bigint))}</option>})}</CommonDropdown>
        <label htmlFor="settlement-amount">Số tiền (tối đa {formatVnd(netAmount)})</label><CommonInput id="settlement-amount" inputMode="numeric" value={settlementAmount} onChange={event=>{setSettlementKey(createUuid());setSettlementAmount(normalizeVndInput(event.target.value))}} required />
        <label htmlFor="settlement-wallet">Ví thanh toán</label><CommonDropdown id="settlement-wallet" value={settlementWalletId} onChange={event=>{setSettlementKey(createUuid());setSettlementWalletId(event.target.value)}} required>{data.wallets.map(wallet=><option key={wallet.id} value={wallet.id}>{wallet.display_name}</option>)}</CommonDropdown>
        <CommonButton type="submit" className="primary-button" disabled={busy||data.wallets.length===0}>Gửi đề nghị</CommonButton>
      </form>}
      <section className="shared-composer shared-expense-composer"><header><div><p className="eyebrow">KHOẢN CHI CHUNG · KHÔNG GHI VÀO CHI TIÊU CÁ NHÂN</p><h2>Khoản chi chung</h2><p>Tạo bill nhóm; số tiền thực tế chỉ trừ từ ví người thanh toán.</p></div><CommonButton type="button" className="primary-button mobile-plus-action" aria-label={showBillForm?'Đóng biểu mẫu khoản chi':'Thêm khoản chi chung'} title={showBillForm?'Đóng biểu mẫu khoản chi':'Thêm khoản chi chung'} onClick={() => setShowBillForm(value => !value)} disabled={data.wallets.length === 0}>{showBillForm?<X size={18} aria-hidden="true"/>:<Plus size={18} aria-hidden="true"/>}<span className="mobile-plus-label">{showBillForm ? 'Đóng biểu mẫu' : 'Thêm khoản chi'}</span></CommonButton></header>
        {data.wallets.length === 0 && <p className="sharing-inline-warning">Tạo ví riêng trước để ghi nhận khoản tiền bạn đã thanh toán.</p>}
        {showBillForm && <form className="shared-bill-form" onSubmit={submitBill}><ReceiptAutofill onApply={(suggestion) => {
          setIdempotencyKey(createUuid())
          setScannedBillTotal(suggestion.total)
          if (suggestion.merchant) setDescription(suggestion.merchant)
          if (suggestion.accountingDate) setDate(suggestion.accountingDate)
          const suggestions = suggestion.items.length ? suggestion.items : suggestion.total ? [{ name: suggestion.merchant || 'Tổng hóa đơn', quantity: '1', unitPrice: suggestion.total, confidence: null }] : []
          if (suggestions.length) setBillItems(suggestions.map(item => ({ ...newBillItem(), name: item.name, quantity: item.quantity, unitPrice: item.unitPrice })))
        }} /><div className="shared-form-grid"><div className="shared-field"><label htmlFor="shared-description">Tên khoản chi</label><CommonInput id="shared-description" value={description} onChange={event => { setIdempotencyKey(createUuid()); setDescription(event.target.value) }} maxLength={200} required /></div><div className="shared-field"><label htmlFor="shared-wallet">Bạn đã trả từ ví</label><CommonDropdown id="shared-wallet" value={walletId} onChange={event => { setIdempotencyKey(createUuid()); setWalletId(event.target.value) }}>{data.wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{wallet.display_name}</option>)}</CommonDropdown></div><div className="shared-field"><label htmlFor="shared-date">Ngày ghi sổ</label><CommonInput id="shared-date" type="date" value={date} onChange={event => { setIdempotencyKey(createUuid()); setDate(event.target.value) }} required /></div><div className="shared-field"><label htmlFor="shared-category">Danh mục cá nhân</label><CommonDropdown id="shared-category" value={categoryId} onChange={event => { setIdempotencyKey(createUuid()); setCategoryId(event.target.value) }}><option value="">Không chọn</option>{data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</CommonDropdown></div></div>
          <div className="shared-items-heading"><div><h3>Các món trong hóa đơn</h3><p>Phần chia được xác nhận theo từng món; làm tròn dư 1 đồng theo ID thành viên ổn định.</p></div><CommonButton type="button" className="secondary-button mobile-plus-action" aria-label="Thêm món vào hóa đơn" title="Thêm món vào hóa đơn" onClick={() => { setIdempotencyKey(createUuid()); setBillItems(items => [...items, newBillItem()]) }}><Plus size={18} aria-hidden="true"/><span className="mobile-plus-label">Thêm món</span></CommonButton></div>
          <div className="shared-items-list">{calculatedItems.map((item, index) => {
            const selectedMembers = item.participantIds ?? participantIds
            const allocatedForOthers = item.allocations.filter(share => share.participantId !== userId).reduce((sum, share) => sum + share.amount, 0n)
            return <fieldset className="shared-item-card" key={item.id}>
              <legend>Món {index + 1}</legend>
              <div className="shared-item-fields">
                <div className="shared-field item-name"><label htmlFor={`item-name-${item.id}`}>Tên món</label><CommonInput id={`item-name-${item.id}`} value={item.name} onChange={event => updateItem(item.id, { name: event.target.value })} maxLength={120} required /></div>
                <div className="shared-field"><label htmlFor={`item-qty-${item.id}`}>Số lượng</label><CommonInput id={`item-qty-${item.id}`} inputMode="decimal" value={item.quantity} onChange={event => updateItem(item.id, { quantity: event.target.value.replace(/[^0-9.,]/g, '') })} required /></div>
                <div className="shared-field"><label htmlFor={`item-price-${item.id}`}>Đơn giá (₫)</label><CommonInput id={`item-price-${item.id}`} inputMode="numeric" value={item.unitPrice} onChange={event => updateItem(item.id, { unitPrice: normalizeVndInput(event.target.value) })} required /></div>
                <div className="shared-field"><label htmlFor={`item-split-${item.id}`}>Cách chia</label><CommonDropdown id={`item-split-${item.id}`} value={item.mode} onChange={event => updateItem(item.id, { mode: event.target.value as 'equal'|'custom'|'percent' })}><option value="equal">Chia đều</option><option value="percent">Theo tỷ lệ %</option><option value="custom">Nhập số tiền</option></CommonDropdown></div>
                <fieldset className="member-allocation-picker"><legend>Thành viên chịu món này</legend><div className="member-allocation-options">{connectionMembers.map(member => {
                  const checked = selectedMembers.includes(member.user_id)
                  return <label key={member.user_id} className="member-allocation-option"><CommonInput type="checkbox" checked={checked} onChange={event => {
                    const next = new Set(selectedMembers)
                    if (event.target.checked) next.add(member.user_id); else next.delete(member.user_id)
                    updateItem(item.id, { participantIds: [...next] })
                  }} /><span>{member.display_name}</span></label>
                })}</div></fieldset>
                {item.mode !== 'equal' && selectedMembers.map(memberId => {
                  const member = connectionMembers.find(entry => entry.user_id === memberId)
                  return <div className="shared-field" key={memberId}><label htmlFor={`item-share-${item.id}-${memberId}`}>{member?.display_name ?? 'Thành viên'} ({item.mode==='percent'?'%':'₫'})</label><CommonInput id={`item-share-${item.id}-${memberId}`} inputMode={item.mode==='percent'?'decimal':'numeric'} value={item.manualShares[memberId] ?? ''} onChange={event => updateItem(item.id, { manualShares: { ...item.manualShares, [memberId]: item.mode==='percent'?event.target.value.replace(/[^0-9.,]/g,'').replace(',','.'):normalizeVndInput(event.target.value) } })} required /></div>
                })}
                <div className="item-total-preview"><small>Thành tiền</small><strong>{item.total === null ? '—' : formatVnd(item.total)}</strong><small>Phần thành viên khác · {formatVnd(allocatedForOthers)}</small></div>
                {billItems.length > 1 && <CommonButton type="button" className="remove-item-button" onClick={() => { setIdempotencyKey(createUuid()); setBillItems(items => items.filter(current => current.id !== item.id)) }} aria-label={`Xóa món ${index + 1}`}><Trash2 size={16} /></CommonButton>}
              </div>
            </fieldset>
          })}</div>
          <div className="shared-bill-total"><span>Tổng hóa đơn</span><strong>{formatVnd(billTotal)}</strong><small>Phần các thành viên khác chịu · {formatVnd(partnerShareTotal)}</small>{scannedBillTotal && billTotal.toString() !== scannedBillTotal && <small role="status">Tổng dòng món đang khác tổng OCR đọc được ({formatVnd(scannedBillTotal)}). Đối chiếu hóa đơn rồi sửa hoặc thêm dòng.</small>}</div>
          <div className="shared-form-actions"><CommonButton type="button" className="secondary-button" onClick={() => setShowBillForm(false)}>Hủy</CommonButton><CommonButton type="submit" className="primary-button" disabled={busy}>{busy ? 'Đang ghi…' : 'Gửi để xác nhận chia tiền'}</CommonButton></div>
        </form>}
      </section>
      <section className="shared-ledger-section"><header className="shared-section-heading"><div><h2>Hoạt động chia tiền</h2><p>Đề nghị đang chờ không ảnh hưởng số dư công nợ.</p></div></header>
        {pendingForMe > 0 && <div className="pending-approval-banner"><HandCoins size={18} /><span>{pendingForMe} khoản chia đang chờ bạn xác nhận</span></div>}
        {activityRecords.length === 0 ? <div className="shared-empty"><HandCoins size={24} /><h3>Chưa có hoạt động</h3><p>Ghi hóa đơn đầu tiên để bắt đầu sổ chung.</p></div> : <div className="shared-record-list">{activityRecords.map(renderActivity)}</div>}
        {hasMoreActivity && <div className="list-pagination"><CommonButton type="button" className="secondary-button" onClick={() => void loadMoreActivity()} disabled={loadingMore}>{loadingMore ? 'Đang tải thêm…' : 'Tải thêm hoạt động'}</CommonButton></div>}
      </section>
    </>}
  </section>
}

import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import {
  Banknote,
  Building2,
  CreditCard,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Trash2,
  WalletCards,
  X
} from 'lucide-react'
import { z } from 'zod'
import { supabase } from '../../shared/lib/supabase'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { fetchAllPages } from '../../shared/lib/pagination'
import { createUuid } from '../../shared/lib/uuid'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { AmountInWords } from '../../shared/ui/AmountInWords'
import {
  reconcileWalletBalance,
  updateWallet,
  deleteWallet,
} from '../../shared/lib/walletReconciliation'

type Wallet = {
  id: string
  kind: 'cash' | 'bank' | 'ewallet' | 'credit'
  display_name: string
  opening_balance_bigint: string
  current_balance_bigint: string
  status: 'active' | 'archived'
  created_at: string
}

const walletSchema = z.object({
  kind: z.enum(['cash', 'bank', 'ewallet', 'credit']),
  name: z.string().trim().min(1).max(80),
  opening: z.string().regex(/^(0|[1-9]\d{0,18})$/)
})

const labels = {
  cash: 'Tiền mặt',
  bank: 'Tài khoản ngân hàng',
  ewallet: 'Ví điện tử',
  credit: 'Thẻ tín dụng'
}

const icons = {
  cash: Banknote,
  bank: Building2,
  ewallet: Smartphone,
  credit: CreditCard
}

export function WalletsPage() {
  const [idempotencyKey, setIdempotencyKey] = useState(() => createUuid())
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [kind, setKind] = useState<Wallet['kind']>('cash')
  const [name, setName] = useState('')
  const [opening, setOpening] = useState('0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reconcilingWallet, setReconcilingWallet] = useState<Wallet | null>(null)
  const [targetBalance, setTargetBalance] = useState('0')
  const [reconcileDate, setReconcileDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [reconcileNote, setReconcileNote] = useState('Điều chỉnh số dư ví')
  const [reconcileBusy, setReconcileBusy] = useState(false)
  const [reconcileError, setReconcileError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [editingWallet, setEditingWallet] = useState<Wallet | null>(null)
  const [editName, setEditName] = useState('')
  const [editKind, setEditKind] = useState<Wallet['kind']>('cash')
  const [editOpening, setEditOpening] = useState('0')
  const [editStatus, setEditStatus] = useState<'active' | 'archived'>('active')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  function openEdit(wallet: Wallet) {
    setEditingWallet(wallet)
    setEditName(wallet.display_name)
    setEditKind(wallet.kind)
    setEditOpening(wallet.opening_balance_bigint)
    setEditStatus(wallet.status)
    setEditError('')
    setConfirmDelete(false)
  }

  async function handleUpdateWallet(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingWallet) return
    const trimmed = editName.trim()
    if (!trimmed) {
      setEditError('Tên ví không được để trống.')
      return
    }
    const cleanOpening = editOpening.replace(/[^0-9]/g, '')
    const finalOpening = cleanOpening === '' ? '0' : cleanOpening
    try {
      parseVnd(finalOpening)
    } catch {
      setEditError('Số dư ban đầu không hợp lệ.')
      return
    }
    setEditBusy(true)
    setEditError('')
    try {
      await updateWallet({
        id: editingWallet.id,
        displayName: trimmed,
        kind: editKind,
        openingBalance: finalOpening,
        status: editStatus,
      })
      setSuccessMessage(`Đã cập nhật thông tin ví "${trimmed}".`)
      setEditingWallet(null)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || 'Không thể cập nhật ví.'
      setEditError(msg)
    } finally {
      setEditBusy(false)
    }
  }

  async function handleDeleteWallet() {
    if (!editingWallet) return
    setEditBusy(true)
    setEditError('')
    try {
      await deleteWallet(editingWallet.id)
      setSuccessMessage(`Đã xóa ví "${editingWallet.display_name}".`)
      setEditingWallet(null)
      await refresh()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Không thể xóa ví.')
    } finally {
      setEditBusy(false)
    }
  }

  function openReconcile(wallet: Wallet) {
    setReconcilingWallet(wallet)
    setTargetBalance(wallet.current_balance_bigint)
    setReconcileDate(new Date().toISOString().slice(0, 10))
    setReconcileNote('Điều chỉnh số dư ví')
    setReconcileError('')
  }

  async function handleReconcile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reconcilingWallet) return
    setReconcileError('')
    const cleanTarget = targetBalance.replace(/[^0-9]/g, '')
    const finalTarget = cleanTarget === '' ? '0' : cleanTarget
    try {
      parseVnd(finalTarget)
    } catch {
      setReconcileError('Số dư mục tiêu không hợp lệ.')
      return
    }
    setReconcileBusy(true)
    try {
      const result = await reconcileWalletBalance(
        reconcilingWallet.id,
        finalTarget,
        reconcileDate || new Date().toISOString().slice(0, 10),
        reconcileNote
      )
      const diffVal = BigInt(result.difference)
      const diffText = diffVal === 0n
        ? 'không thay đổi'
        : diffVal > 0n
        ? `tăng +${formatVnd(diffVal.toString())}`
        : `giảm -${formatVnd((-diffVal).toString())}`
      setSuccessMessage(`Đã cập nhật số dư ví ${reconcilingWallet.display_name} thành ${formatVnd(finalTarget)} (${diffText}).`)
      setReconcilingWallet(null)
      await refresh()
    } catch (err) {
      console.error('Lỗi khi đặt lại số dư ví:', err)
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message || 'Không thể điều chỉnh số dư ví.'
      setReconcileError(msg)
    } finally {
      setReconcileBusy(false)
    }
  }

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    const client = supabase
    setLoading(true)
    const [walletResult, balanceResult] = await Promise.all([
      fetchAllPages((from, to) => client.from('wallets')
        .select('id,kind,display_name,opening_balance_bigint,status,created_at')
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to), 50),
      fetchAllPages((from, to) => client.from('wallet_balances')
        .select('id,current_balance_bigint')
        .order('id', { ascending: false })
        .range(from, to), 50),
    ])
    if (walletResult.error || balanceResult.error) {
      setError('Không tải được danh sách ví. Kiểm tra kết nối rồi thử lại.')
    } else {
      const balances = new Map((balanceResult.data ?? []).map(row => [row.id, row.current_balance_bigint]))
      setWallets(((walletResult.data ?? []) as Omit<Wallet, 'current_balance_bigint'>[]).map(wallet => ({
        ...wallet,
        current_balance_bigint: String(balances.get(wallet.id) ?? wallet.opening_balance_bigint),
      })))
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

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const parsed = walletSchema.safeParse({ kind, name, opening })
    if (!parsed.success) {
      setError('Kiểm tra tên ví và số dư ban đầu. Số tiền cần là số nguyên đồng không âm.')
      return
    }
    if (!supabase) {
      setError('Cần cấu hình Supabase để lưu ví an toàn.')
      return
    }
    try {
      parseVnd(parsed.data.opening)
    } catch {
      setError('Số dư vượt giới hạn lưu trữ.')
      return
    }
    setBusy(true)
    const { error: saveError } = await supabase.rpc('create_wallet', {
      p_id: createUuid(),
      p_kind: parsed.data.kind,
      p_display_name: parsed.data.name,
      p_opening_balance: parsed.data.opening,
      p_idempotency_key: idempotencyKey
    })
    if (saveError) {
      setError('Không thể lưu ví. Kiểm tra quyền truy cập và thử lại.')
    } else {
      setIdempotencyKey(createUuid())
      setShowForm(false)
      setName('')
      setOpening('0')
      await refresh()
    }
    setBusy(false)
  }

  const totalBalance = wallets.reduce(
    (sum, wallet) => sum + BigInt(wallet.current_balance_bigint),
    0n
  )

  return (
    <section className="wallets-page" aria-labelledby="wallet-title">
      <LoadingModal message="Đang tải danh sách ví của bạn…" show={loading} />
      <header className="content-heading">
        <div>
          <p className="eyebrow">TÀI SẢN CÁ NHÂN</p>
          <h1 id="wallet-title">Ví của tôi</h1>
          <p className="subheading">
            Tên ví và số dư được phân quyền riêng tư, chỉ mình bạn xem và sử dụng được.
          </p>
        </div>
        <CommonButton
          type="button"
          className="primary-button mobile-plus-action"
          onClick={() => setShowForm(true)}
          aria-label="Thêm ví mới"
          title="Thêm ví mới"
        >
          <Plus size={18} />
          <span className="mobile-plus-label">Thêm ví mới</span>
        </CommonButton>
      </header>

      {error && (
        <div className="form-error" role="alert">
          <span>{error}</span>
          <CommonButton type="button" onClick={() => void refresh()}>
            Thử tải lại
          </CommonButton>
        </div>
      )}

      {successMessage && (
        <div className="profile-success" style={{ marginBottom: '14px' }} role="status">
          {successMessage}
        </div>
      )}

      {/* Total Balance Across Wallets Summary Banner */}
      {!loading && wallets.length > 0 && (
        <div className="budget-overview-card" style={{ marginBottom: '18px' }}>
          <div className="budget-overview-icon">
            <WalletCards size={20} />
          </div>
          <div>
            <span>Tổng tài sản các ví</span>
            <strong>{formatVnd(totalBalance)}</strong>
          </div>
          <small>{wallets.length} ví hoạt động</small>
        </div>
      )}

      {/* Bottom Sheet Modal for Wallet Creation */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div
            className="bottom-sheet-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-sheet-title"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <h2 id="wallet-sheet-title">Tạo ví tài chính mới</h2>
              <CommonButton
                type="button"
                className="sheet-close-btn"
                onClick={() => setShowForm(false)}
                aria-label="Đóng biểu mẫu"
              >
                <X size={20} />
              </CommonButton>
            </div>

            <form className="sheet-form" onSubmit={create}>
              <div className="field-group">
                <label htmlFor="wallet-name">Tên hiển thị của ví</label>
                <CommonInput
                  id="wallet-name"
                  placeholder="Ví dụ: Tiền mặt tiêu vặt, Vietcombank chính, MoMo..."
                  value={name}
                  onChange={event => {
                    setIdempotencyKey(createUuid())
                    setName(event.target.value)
                  }}
                  maxLength={80}
                  required
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="field-group">
                <label htmlFor="wallet-kind">Loại tài khoản ví</label>
                <CommonDropdown
                  id="wallet-kind"
                  value={kind}
                  onChange={event => {
                    setIdempotencyKey(createUuid())
                    setKind(event.target.value as Wallet['kind'])
                  }}
                >
                  <option value="cash">Tiền mặt</option>
                  <option value="bank">Ngân hàng</option>
                  <option value="ewallet">Ví điện tử</option>
                  <option value="credit">Thẻ tín dụng</option>
                </CommonDropdown>
              </div>

              <div className="field-group">
                <label htmlFor="wallet-opening">Số dư ban đầu (₫)</label>
                <CommonInput
                  id="wallet-opening"
                  className="big-amount-input"
                  inputMode="numeric"
                  placeholder="0 ₫"
                  value={opening}
                  onChange={event => {
                    setIdempotencyKey(createUuid())
                    setOpening(normalizeVndInput(event.target.value))
                  }}
                  required
                />
                {opening && (
                  <small className="amount-preview-label">{formatVnd(opening)}</small>
                )}
                <AmountInWords id="wallet-opening" value={opening} />
                <p className="field-help" style={{ marginTop: '4px', textAlign: 'center' }}>
                  Số tiền tính theo đồng Việt Nam (VND), không có phần thập phân.
                </p>
              </div>

              <div className="sheet-form-actions">
                <CommonButton
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowForm(false)}
                >
                  Hủy
                </CommonButton>
                <CommonButton className="primary-button" disabled={busy}>
                  {busy ? 'Đang lưu…' : 'Lưu ví'}
                </CommonButton>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Wallet List */}
      {loading ? null : wallets.length === 0 ? (
        <div className="wallet-empty">
          <WalletCards size={32} />
          <h2>Chưa có ví tài chính</h2>
          <p>Tạo ví đầu tiên để bắt đầu theo dõi thu chi và quản lý số dư.</p>
          <CommonButton
            type="button"
            className="primary-button mobile-plus-action"
            onClick={() => setShowForm(true)}
            aria-label="Tạo ví đầu tiên"
            title="Tạo ví đầu tiên"
            style={{ marginTop: '12px' }}
          >
            <Plus size={18} />
            <span className="mobile-plus-label">Tạo ví đầu tiên</span>
          </CommonButton>
        </div>
      ) : (
        <ul className="wallet-list">
          {wallets.map(wallet => {
            const Icon = icons[wallet.kind] ?? WalletCards
            return (
              <li key={wallet.id}>
                <span className="wallet-icon">
                  <Icon size={20} />
                </span>
                <div className="wallet-info">
                  <strong>{wallet.display_name}</strong>
                  <small>
                    {labels[wallet.kind]} ·{' '}
                    {wallet.status === 'active' ? (
                      <span style={{ color: '#15803d' }}>Đang sử dụng</span>
                    ) : (
                      'Đã lưu trữ'
                    )}
                  </small>
                </div>
                <div className="wallet-row-actions">
                  <b>{formatVnd(wallet.current_balance_bigint)}</b>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <CommonButton
                      type="button"
                      className="secondary-button wallet-reset-btn"
                      onClick={() => openEdit(wallet)}
                      aria-label={`Sửa ví ${wallet.display_name}`}
                      title="Sửa ví"
                    >
                      <Pencil size={13} aria-hidden="true" />
                      <span>Sửa</span>
                    </CommonButton>
                    <CommonButton
                      type="button"
                      className="secondary-button wallet-reset-btn"
                      onClick={() => openReconcile(wallet)}
                      aria-label={`Đặt lại số dư ví ${wallet.display_name}`}
                      title="Đặt lại số dư ví"
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      <span>Reset</span>
                    </CommonButton>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Bottom Sheet Modal for Wallet Reconciliation / Reset */}
      {reconcilingWallet && (
        <div className="modal-backdrop" onClick={() => setReconcilingWallet(null)}>
          <div
            className="bottom-sheet-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reconcile-sheet-title"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <h2 id="reconcile-sheet-title">Đặt lại số dư: {reconcilingWallet.display_name}</h2>
              <CommonButton
                type="button"
                className="sheet-close-btn"
                onClick={() => setReconcilingWallet(null)}
                aria-label="Đóng biểu mẫu"
              >
                <X size={20} />
              </CommonButton>
            </div>

            <form className="sheet-form" onSubmit={event => void handleReconcile(event)}>
              <div className="reconcile-diff-box">
                <div>
                  <span>Số dư hiện tại trên app:</span>
                  <strong>{formatVnd(reconcilingWallet.current_balance_bigint)}</strong>
                </div>
                <div>
                  <span>Số dư ban đầu khi tạo ví:</span>
                  <span>{formatVnd(reconcilingWallet.opening_balance_bigint)}</span>
                </div>
                {(() => {
                  const current = BigInt(reconcilingWallet.current_balance_bigint)
                  const target = BigInt(targetBalance || '0')
                  const diff = target - current
                  return (
                    <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed var(--border)' }}>
                      <span>Bút toán điều chỉnh dự kiến:</span>
                      <strong className={diff > 0n ? 'amount-in' : diff < 0n ? 'amount-out' : ''}>
                        {diff > 0n ? `+${formatVnd(diff.toString())} (Thu nhập)` : diff < 0n ? `-${formatVnd((-diff).toString())} (Chi phí)` : 'Số dư không đổi'}
                      </strong>
                    </div>
                  )
                })()}
              </div>

              <div className="field-group">
                <label htmlFor="target-balance">Số dư thực tế mới (₫)</label>
                <CommonInput
                  id="target-balance"
                  className="big-amount-input"
                  inputMode="numeric"
                  placeholder="0 ₫"
                  value={targetBalance}
                  onChange={event => setTargetBalance(normalizeVndInput(event.target.value))}
                  autoFocus
                />
                <small className="amount-preview-label">{formatVnd(targetBalance || '0')}</small>
                <AmountInWords id="target-balance" value={targetBalance || '0'} />
                <div className="reconcile-quick-buttons">
                  <button
                    type="button"
                    className={`reconcile-quick-btn ${targetBalance === '0' ? 'active' : ''}`}
                    onClick={() => setTargetBalance('0')}
                  >
                    Đặt về 0 ₫
                  </button>
                  <button
                    type="button"
                    className={`reconcile-quick-btn ${targetBalance === reconcilingWallet.opening_balance_bigint ? 'active' : ''}`}
                    onClick={() => setTargetBalance(reconcilingWallet.opening_balance_bigint)}
                  >
                    Về số dư ban đầu ({formatVnd(reconcilingWallet.opening_balance_bigint)})
                  </button>
                </div>
                <p className="field-help" style={{ marginTop: '6px' }}>
                  💡 Bấm nút <strong>&quot;Đặt về 0 ₫&quot;</strong>, sau đó bấm <strong>&quot;Xác nhận đặt lại số dư&quot;</strong> bên dưới để hoàn tất.
                </p>
              </div>

              <div className="field-group">
                <label htmlFor="reconcile-date">Ngày ghi nhận</label>
                <CommonInput
                  id="reconcile-date"
                  type="date"
                  value={reconcileDate}
                  onChange={event => setReconcileDate(event.target.value)}
                />
              </div>

              <div className="field-group">
                <label htmlFor="reconcile-note">Ghi chú điều chỉnh</label>
                <CommonInput
                  id="reconcile-note"
                  value={reconcileNote}
                  onChange={event => setReconcileNote(event.target.value)}
                  placeholder="Ví dụ: Điều chỉnh số dư thực tế, Reset ví..."
                  maxLength={120}
                />
                <p className="field-help" style={{ marginTop: '4px' }}>
                  Hệ thống sẽ tạo một giao dịch điều chỉnh để số dư ví khớp chính xác với số tiền bạn đặt.
                </p>
              </div>

              {reconcileError && <div className="form-error" role="alert">{reconcileError}</div>}

              <div className="sheet-form-actions">
                <CommonButton
                  type="button"
                  className="secondary-button"
                  onClick={() => setReconcilingWallet(null)}
                  disabled={reconcileBusy}
                >
                  Hủy
                </CommonButton>
                <CommonButton type="submit" className="primary-button" disabled={reconcileBusy}>
                  {reconcileBusy ? 'Đang điều chỉnh…' : 'Xác nhận đặt lại số dư'}
                </CommonButton>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bottom Sheet Modal for Editing Wallet */}
      {editingWallet && (
        <div className="modal-backdrop" onClick={() => { if (!editBusy) setEditingWallet(null) }}>
          <div
            className="bottom-sheet-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-wallet-sheet-title"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <h2 id="edit-wallet-sheet-title">Chỉnh sửa ví: {editingWallet.display_name}</h2>
              <CommonButton
                type="button"
                className="sheet-close-btn"
                onClick={() => { if (!editBusy) setEditingWallet(null) }}
                aria-label="Đóng biểu mẫu"
              >
                <X size={20} />
              </CommonButton>
            </div>

            {confirmDelete ? (
              <div className="confirm-delete-box" style={{ padding: '16px 0', textAlign: 'center' }}>
                <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--expense)' }}>
                  Xác nhận xóa ví này?
                </p>
                <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '8px 0 16px' }}>
                  Hành động này chỉ thực hiện được nếu ví chưa có giao dịch nào. Nếu ví đã có giao dịch phát sinh, bạn nên chọn &quot;Lưu trữ ví&quot; để bảo toàn lịch sử kế toán.
                </p>
                {editError && <div className="form-error" role="alert" style={{ marginBottom: '12px' }}>{editError}</div>}
                <div className="sheet-form-actions" style={{ justifyContent: 'center' }}>
                  <CommonButton
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={editBusy}
                  >
                    Hủy
                  </CommonButton>
                  <CommonButton
                    type="button"
                    className="modal-danger-btn primary-button"
                    onClick={() => void handleDeleteWallet()}
                    disabled={editBusy}
                  >
                    {editBusy ? 'Đang xóa…' : 'Xóa ví'}
                  </CommonButton>
                </div>
              </div>
            ) : (
              <form className="sheet-form" onSubmit={event => void handleUpdateWallet(event)}>
                <div className="field-group">
                  <label htmlFor="edit-wallet-name">Tên ví</label>
                  <CommonInput
                    id="edit-wallet-name"
                    value={editName}
                    onChange={event => setEditName(event.target.value)}
                    placeholder="Ví dụ: Tiền mặt, Techcombank, MoMo..."
                    maxLength={80}
                    required
                    autoFocus
                  />
                </div>

                <div className="field-group">
                  <label htmlFor="edit-wallet-opening">Số dư ban đầu khi tạo ví (₫)</label>
                  <CommonInput
                    id="edit-wallet-opening"
                    inputMode="numeric"
                    value={editOpening}
                    onChange={event => setEditOpening(normalizeVndInput(event.target.value))}
                    placeholder="0 ₫"
                  />
                  <small className="amount-preview-label">{formatVnd(editOpening || '0')}</small>
                  <AmountInWords id="edit-wallet-opening" value={editOpening || '0'} />
                  <p className="field-help" style={{ marginTop: '4px' }}>
                    Nếu muốn số dư ban đầu khi tạo ví là 0, bạn có thể chỉnh sửa trực tiếp tại đây.
                  </p>
                </div>

                <div className="form-grid-2">
                  <div className="field-group">
                    <label htmlFor="edit-wallet-kind">Loại ví</label>
                    <CommonDropdown
                      id="edit-wallet-kind"
                      value={editKind}
                      onChange={event => setEditKind(event.target.value as Wallet['kind'])}
                    >
                      <option value="cash">Tiền mặt</option>
                      <option value="bank">Tài khoản ngân hàng</option>
                      <option value="ewallet">Ví điện tử</option>
                      <option value="credit">Thẻ tín dụng</option>
                    </CommonDropdown>
                  </div>

                  <div className="field-group">
                    <label htmlFor="edit-wallet-status">Trạng thái sử dụng</label>
                    <CommonDropdown
                      id="edit-wallet-status"
                      value={editStatus}
                      onChange={event => setEditStatus(event.target.value as 'active' | 'archived')}
                    >
                      <option value="active">Đang sử dụng</option>
                      <option value="archived">Lưu trữ (Ẩn khỏi hoạt động)</option>
                    </CommonDropdown>
                  </div>
                </div>

                {editError && <div className="form-error" role="alert">{editError}</div>}

                <div className="sheet-form-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <CommonButton
                    type="button"
                    className="secondary-button"
                    style={{ color: 'var(--expense)' }}
                    onClick={() => setConfirmDelete(true)}
                    disabled={editBusy}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    <span>Xóa ví</span>
                  </CommonButton>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <CommonButton
                      type="button"
                      className="secondary-button"
                      onClick={() => setEditingWallet(null)}
                      disabled={editBusy}
                    >
                      Hủy
                    </CommonButton>
                    <CommonButton className="primary-button" disabled={editBusy}>
                      {editBusy ? 'Đang lưu…' : 'Lưu thay đổi'}
                    </CommonButton>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      <footer className="menu-footer-note" style={{ marginTop: '20px' }}>
        <p>
          <ShieldCheck size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
          Bảo mật cấp tài khoản
        </p>
        <small>Dữ liệu số dư ví hoàn toàn độc lập, đối tác chia tiền không thể xem được.</small>
      </footer>
    </section>
  )
}

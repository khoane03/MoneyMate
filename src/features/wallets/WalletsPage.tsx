import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import {
  Banknote,
  Building2,
  CreditCard,
  Plus,
  ShieldCheck,
  Smartphone,
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
                <b>{formatVnd(wallet.current_balance_bigint)}</b>
              </li>
            )
          })}
        </ul>
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

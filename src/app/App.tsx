import { Link, NavLink, Route, Routes, useLocation, useNavigate, type Location } from 'react-router-dom'
import { lazy, Suspense, useState } from 'react'
import {
  BarChart3,
  HandCoins,
  Home,
  Menu,
  Plus,
  ReceiptText,
  Settings2,
} from 'lucide-react'
import { TransactionLink } from '../shared/ui/TransactionLink'
import { NotificationLink } from '../features/notifications/NotificationLink'
import { GlassSurface } from '../shared/ui/GlassSurface'
import { PageContainer } from '../shared/ui/PageContainer'
import { ErrorScreen } from '../shared/ui/ErrorScreen'
import { UsageTracker } from '../shared/lib/UsageTracker'

const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage').then(module => ({ default: module.DashboardPage })))
const TransactionsPage = lazy(() => import('../features/transactions/TransactionsPage').then(module => ({ default: module.TransactionsPage })))
const SharingPage = lazy(() => import('../features/sharing/SharingPage').then(module => ({ default: module.SharingPage })))
const ReceiptsPage = lazy(() => import('../features/receipts/ReceiptsPage').then(module => ({ default: module.ReceiptsPage })))
const BillCheckinPage = lazy(() => import('../features/receipts/BillCheckinPage').then(module => ({ default: module.BillCheckinPage })))
const AdminPage = lazy(() => import('../features/admin/AdminPage').then(module => ({ default: module.AdminPage })))
const ReportsPage = lazy(() => import('../features/reports/ReportsPage').then(module => ({ default: module.ReportsPage })))
const WalletsPage = lazy(() => import('../features/wallets/WalletsPage').then(module => ({ default: module.WalletsPage })))
const LoansPage = lazy(() => import('../features/loans/LoansPage').then(module => ({ default: module.LoansPage })))
const BudgetsPage = lazy(() => import('../features/budgets/BudgetsPage').then(module => ({ default: module.BudgetsPage })))
const CategoriesPage = lazy(() => import('../features/categories/CategoriesPage').then(module => ({ default: module.CategoriesPage })))
const MoreMenuPage = lazy(() => import('../features/more/MoreMenuPage').then(module => ({ default: module.MoreMenuPage })))
const SettingsPage = lazy(() => import('../features/auth/SettingsPage').then(module => ({ default: module.SettingsPage })))
const NotificationsPage = lazy(() => import('../features/notifications/NotificationsPage').then(module => ({ default: module.NotificationsPage })))

const destinations = [
  { to: '/', label: 'Tổng quan', icon: Home },
  { to: '/transactions', label: 'Giao dịch', icon: ReceiptText },
  { to: '/sharing', label: 'Chia tiền', icon: HandCoins },
  { to: '/reports', label: 'Báo cáo', icon: BarChart3 },
  { to: '/more', label: 'Khác', icon: Menu },
]

const titleMap: Record<string, string> = {
  '/': 'Tổng quan',
  '/transactions': 'Giao dịch',
  '/sharing': 'Chia tiền nhóm',
  '/reports': 'Báo cáo dòng tiền',
  '/wallets': 'Ví của tôi',
  '/loans': 'Vay & Trả nợ',
  '/budgets': 'Ngân sách tháng',
  '/categories': 'Danh mục chi tiêu',
  '/receipts': 'Hóa đơn & OCR',
  '/bill-checkin': 'Check-in chi tiêu',
  '/admin': 'Quản trị hệ thống',
  '/notifications': 'Thông báo',
  '/settings': 'Cài đặt tài khoản',
  '/more': 'Menu chức năng',
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [saveNotice, setSaveNotice] = useState('')
  const background = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation
  const composing = location.pathname === '/transactions' && background && background.pathname !== '/transactions'
  const displayedLocation = composing ? background : location
  const currentTitle = titleMap[displayedLocation.pathname] ?? 'MoneyMate'

  return (
    <div className="app-shell">
      <UsageTracker />
      <a className="skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>

      {/* Mobile Sticky App Bar */}
      <GlassSurface
        as="header"
        className="mobile-app-bar"
        aria-label="Thanh điều hướng ứng dụng di động"
      >
        <Link to="/" className="mobile-brand" aria-label="Về trang tổng quan">
          <span className="brand-mark">M</span>
          <div className="mobile-brand-text">
            <span className="mobile-brand-name">MoneyMate</span>
            <span className="mobile-sync-badge">
              <span className="live-dot" aria-hidden="true" />
              Sẵn sàng
            </span>
          </div>
        </Link>
        <span className="mobile-view-title">{currentTitle}</span>
        <div className="mobile-app-bar-actions">
          <TransactionLink
            to="/transactions?action=new"
            className="mobile-action-pill"
            aria-label="Mở ghi chép"
          >
            <Plus size={16} aria-hidden="true" />
            <span>Ghi chép</span>
          </TransactionLink>
          <NotificationLink />
          <Link to="/settings" className="mobile-icon-btn" aria-label="Cài đặt">
            <Settings2 size={18} aria-hidden="true" />
          </Link>
        </div>
      </GlassSurface>

      {/* Desktop Persistent Sidebar */}
      <GlassSurface as="aside" className="sidebar">
        <NavLink to="/" className="brand">
          <span className="brand-mark">M</span>
          <span>MoneyMate</span>
        </NavLink>
        <p className="nav-caption">KHÔNG GIAN CỦA BẠN</p>
        <nav aria-label="Điều hướng chính" className="desktop-nav">
          {destinations.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon size={19} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <NotificationLink className="sidebar-notification-link" />
          <NavLink to="/settings" className="sidebar-settings-link">
            <Settings2 size={19} aria-hidden="true" />
            Cài đặt
          </NavLink>
          <small>Riêng tư theo thiết kế • vi-VN</small>
        </div>
      </GlassSurface>

      {/* Main Content Area */}
      <main id="main-content" className="main-content" tabIndex={-1}>
        <PageContainer>
          <Suspense fallback={<p className="data-status" role="status">Đang mở màn hình…</p>}>
          <div inert={Boolean(composing)}><Routes location={displayedLocation}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/sharing" element={<SharingPage />} />
            <Route path="/receipts" element={<ReceiptsPage />} />
            <Route path="/bill-checkin" element={<BillCheckinPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/wallets" element={<WalletsPage />} />
            <Route path="/loans" element={<LoansPage />} />
            <Route path="/budgets" element={<BudgetsPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/more" element={<MoreMenuPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="*" element={<ErrorScreen kind="not-found" />} />
          </Routes></div>
          </Suspense>
          {saveNotice && <p className="save-toast" role="status">{saveNotice}<button type="button" aria-label="Đóng thông báo" onClick={() => setSaveNotice('')}>×</button></p>}
          {composing && <Suspense fallback={<p className="data-status" role="status">Đang mở biểu mẫu…</p>}>
            <TransactionsPage composerOnly onClose={() => navigate(-1)} onSaved={message => {
              setSaveNotice(message)
              navigate(-1)
              window.dispatchEvent(new Event('moneymate:financial-change'))
            }} />
          </Suspense>}
        </PageContainer>
      </main>

      {!composing && displayedLocation.pathname !== '/bill-checkin' && <TransactionLink to="/transactions?action=new" className="quick-entry-fab" aria-label="Ghi giao dịch nhanh"><Plus size={22} aria-hidden="true"/><span>Ghi chép</span></TransactionLink>}
      {/* Mobile Bottom Navigation Bar */}
      <GlassSurface
        as="nav"
        className="bottom-nav"
        aria-label="Điều hướng chính trên điện thoại"
      >
        {destinations.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <div className="bottom-nav-icon-wrap">
              <Icon size={20} aria-hidden="true" />
            </div>
            <span>{label}</span>
          </NavLink>
        ))}
      </GlassSurface>
    </div>
  )
}

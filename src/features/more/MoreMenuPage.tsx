import { useEffect, useState } from 'react'
import {
  BarChart3, Bell, BookOpen, CalendarClock, Camera, FolderTree, HandCoins, Landmark, ScanLine, Settings2,
  ShieldCheck, Target, User, WalletCards,
} from 'lucide-react'
import { useNotifications } from '../notifications/notificationContext'
import { profileInitial, useAccountProfile } from '../auth/accountProfile'
import { MenuLink } from '../../shared/ui/Controls'
import { hasAdminAccess } from '../../shared/lib/adminAccess'

const menuGroups = [
  {
    title: 'QUẢN LÝ TÀI CHÍNH',
    items: [
      { to: '/wallets', tone: 'wallet', icon: WalletCards, title: 'Ví của tôi', description: 'Quản lý tiền mặt, thẻ ngân hàng, ví điện tử' },
      { to: '/loans', tone: 'loan', icon: Landmark, title: 'Vay & Trả nợ', description: 'Xem đã vay, đã trả và còn nợ theo từng khoản' },
      { to: '/budgets', tone: 'budget', icon: Target, title: 'Hạn mức & Ngân sách', description: 'Kiểm soát chi tiêu tháng theo danh mục' },
      { to: '/planned-expenses', tone: 'budget', icon: CalendarClock, title: 'Khoản chi dự kiến', description: 'Lên kế hoạch khoản sắp chi và xác nhận khi đã chi' },
      { to: '/categories', tone: 'category', icon: FolderTree, title: 'Danh mục chi tiêu', description: 'Tùy chỉnh nhóm thu nhập và khoản chi' },
    ],
  },
  {
    title: 'CÔNG CỤ THÔNG MINH & CHIA SẺ',
    items: [
      { to: '/bill-checkin', tone: 'receipt', icon: Camera, title: 'Check-in chi tiêu', description: 'Chụp sản phẩm, món ăn hoặc bill rồi lưu thành khoản chi' },
      { to: '/receipts', tone: 'receipt', icon: ScanLine, title: 'Hóa đơn & Quét Bill', description: 'Đọc ảnh hóa đơn và kiểm tra thông tin trước khi lưu' },
      { to: '/sharing', tone: 'sharing', icon: HandCoins, title: 'Chia tiền nhóm', description: 'Chia từng món và theo dõi ai cần trả bao nhiêu' },
      { to: '/reports', tone: 'report', icon: BarChart3, title: 'Báo cáo dòng tiền', description: 'Thống kê thu chi và phân tích định kỳ' },
    ],
  },
  {
    title: 'HỆ THỐNG & BẢO MẬT',
    items: [
      { to: '/guide', tone: 'settings', icon: BookOpen, title: 'Hướng dẫn sử dụng', description: 'Cách ghi chép, chia tiền và theo dõi tài chính' },
      { to: '/notifications', tone: 'notification', icon: Bell, title: 'Thông báo', description: 'Cập nhật từ sổ chia tiền, công nợ và quản trị', unread: true },
      { to: '/settings', tone: 'settings', icon: Settings2, title: 'Cài đặt & Phiên đăng nhập', description: 'Quản lý tài khoản, đồng bộ và đăng xuất' },
      { to: '/admin', tone: 'admin', icon: ShieldCheck, title: 'Khu vực quản trị', description: 'Cấu hình hệ thống và danh mục mặc định' },
    ],
  },
]

export function MoreMenuPage() {
  const { unreadCount } = useNotifications()
  const { profile } = useAccountProfile()
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => { let active = true; void hasAdminAccess().then(value => { if (active) setIsAdmin(value) }); return () => { active = false } }, [])
  const visibleGroups = menuGroups.map(group => ({
    ...group,
    items: group.items.filter(item => item.to !== '/admin' || isAdmin),
  })).filter(group => group.items.length > 0)
  return (
    <div className="more-menu-page" aria-labelledby="more-menu-title">
      <header className="mobile-only-header">
        <h1 id="more-menu-title">Menu & Tiện ích</h1>
        <p className="subheading">Truy cập nhanh mọi công cụ quản lý tài chính và cấu hình.</p>
      </header>
      <section className="menu-profile-card">
        <div className="menu-avatar">
          {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : profile?.displayName ? <span>{profileInitial(profile.displayName)}</span> : <User size={24} aria-hidden="true" />}
        </div>
        <div className="menu-profile-info">
          <strong>{profile?.displayName || 'Tài khoản MoneyMate'}</strong>
          <span className="menu-profile-badge"><span className="live-dot" /> Thông tin cá nhân chỉ bạn xem</span>
        </div>
      </section>
      {visibleGroups.map(group => (
        <section className="menu-group" key={group.title}>
          <h2 className="menu-group-title">{group.title}</h2>
          <nav className="menu-list" aria-label={group.title}>
            {group.items.map(item => {
              const Icon = item.icon
              const title = item.unread && unreadCount > 0 ? `${item.title} · ${unreadCount} chưa đọc` : item.title
              return <MenuLink key={item.to} to={item.to} tone={item.tone} icon={<Icon size={20} aria-hidden="true" />} title={title} description={item.description} />
            })}
          </nav>
        </section>
      ))}
      <footer className="menu-footer-note">
        <p>MoneyMate PWA • Chuẩn tài chính VND vi-VN</p>
        <small>Bảo mật riêng tư & Sẵn sàng hoạt động ngoại tuyến</small>
      </footer>
    </div>
  )
}

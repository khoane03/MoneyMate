import { Bell } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useNotifications } from './notificationContext'

export function NotificationLink({ className = 'mobile-icon-btn' }: { className?: string }) {
  const { unreadCount } = useNotifications()
  const label = unreadCount > 0 ? `Thông báo, ${unreadCount} chưa đọc` : 'Thông báo'
  return (
    <Link to="/notifications" className={`notification-link ${className}`} aria-label={label}>
      <Bell size={18} aria-hidden="true" />
      {className.includes('sidebar') && <span className="notification-link-label">Thông báo</span>}
      {unreadCount > 0 && <span className="notification-count" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}
    </Link>
  )
}

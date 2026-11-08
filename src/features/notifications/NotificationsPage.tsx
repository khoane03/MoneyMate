import { Button as CommonButton } from '../../shared/ui/Controls'
import { Bell, CheckCheck, CircleAlert, HandCoins, Info, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useNotifications } from './notificationContext'
import { formatDateTime } from '../../shared/lib/dateFormat'

export function NotificationsPage() {
  const { notifications, unreadCount, loading, loadingMore, hasMore, error, realtime, refresh, loadMore, markRead, markAllRead } = useNotifications()

  return (
    <section className="notifications-page" aria-labelledby="notifications-title">
      <p className="eyebrow">CẬP NHẬT TỪ MONEY MATE</p>
      <header className="notifications-heading">
        <div><h1 id="notifications-title">Thông báo</h1><p>Tin từ quản trị viên và cập nhật chia sẻ với người kết nối.</p></div>
        <div className="notifications-heading-actions">
          <CommonButton type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />Tải lại
          </CommonButton>
          <CommonButton type="button" className="secondary-button" onClick={() => void markAllRead()} disabled={loading || unreadCount === 0}>
            <CheckCheck size={16} aria-hidden="true" />Đánh dấu đã đọc
          </CommonButton>
        </div>
      </header>

      {realtime === 'offline' && <p className="notification-connectivity" role="status"><CircleAlert size={17} aria-hidden="true"/>Kết nối realtime đang gián đoạn. Thông báo vẫn được lưu và sẽ đồng bộ lại khi kết nối phục hồi.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading && notifications.length === 0 ? null : error && notifications.length === 0 ? null : notifications.length === 0 ? (
      <div className="notifications-empty"><span><Bell size={22} aria-hidden="true"/></span><h2>Chưa có thông báo</h2><p>Khi quản trị viên đăng tin hoặc thành viên trong nhóm gửi khoản chia, đề nghị thanh toán hay nhắc đến hạn, thông báo sẽ xuất hiện tại đây.</p><Link className="secondary-button" to="/sharing">Mở mục Chia tiền</Link></div>
      ) : (
        <ul className="notification-list" aria-label={`${notifications.length} thông báo gần đây`}>
          {notifications.map(item => (
            <li key={item.id} className={item.read_at ? 'notification-item' : 'notification-item unread'}>
              <Link to={item.entity_type === 'admin_notice' ? '/' : '/sharing'} onClick={() => { if (!item.read_at) void markRead(item.id) }}>
                <span className="notification-icon">{item.entity_type === 'admin_notice' ? <Info size={19} aria-hidden="true"/> : <HandCoins size={19} aria-hidden="true"/>}</span>
                <span className="notification-copy"><strong>{item.title}</strong><span>{item.body}</span><time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time></span>
                {!item.read_at && <span className="notification-unread-dot"><span className="visually-hidden">Chưa đọc</span></span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!loading && notifications.length > 0 && <><div className="notifications-pagination-meta">Đang hiển thị {notifications.length} thông báo gần đây</div>{hasMore&&<div className="list-pagination"><CommonButton type="button" className="secondary-button" onClick={()=>void loadMore()} disabled={loadingMore}>{loadingMore?'Đang tải thêm…':'Tải thêm thông báo'}</CommonButton></div>}<p className="notifications-footnote">{realtime === 'connected' ? 'Đang nhận cập nhật trực tiếp' : 'Thông báo được lưu trên máy chủ và tải lại khi kết nối phục hồi'}</p></>}
    </section>
  )
}

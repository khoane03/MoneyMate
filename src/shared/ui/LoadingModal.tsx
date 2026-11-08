import { CircleDollarSign } from 'lucide-react'

/** One consistent full-screen loading state for each screen. */
export function LoadingModal({ message = 'Đang cập nhật dữ liệu…', show = true }: { message?: string; show?: boolean }) {
  if (!show) return null
  return <div className="data-loading-status" role="status" aria-live="polite" aria-atomic="true">
    <div className="data-loading-content">
      <span className="data-loading-mark" aria-hidden="true"><CircleDollarSign size={30} /></span>
      <strong>MoneyMate</strong>
      <span className="data-loading-message">{message}</span>
    </div>
  </div>
}

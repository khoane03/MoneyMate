import { Button as CommonButton } from './Controls'
import { AlertTriangle, ArrowLeft, Home, SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'

type ErrorScreenProps = { kind: 'not-found' | 'unexpected' }

export function ErrorScreen({ kind }: ErrorScreenProps) {
  const notFound = kind === 'not-found'
  const Icon = notFound ? SearchX : AlertTriangle

  return (
    <section className="app-error-screen" aria-labelledby="app-error-title" role="alert">
      <span className="app-error-mark"><Icon size={28} aria-hidden="true" /></span>
      <p className="eyebrow">MONEYMATE · {notFound ? '404' : 'CÓ LỖI'}</p>
      <h1 id="app-error-title">{notFound ? 'Không tìm thấy trang này' : 'Đã có lỗi xảy ra'}</h1>
      <p>{notFound ? 'Đường dẫn có thể đã thay đổi hoặc trang không còn tồn tại.' : 'Ứng dụng gặp sự cố khi hiển thị trang. Bạn có thể thử tải lại hoặc quay về tổng quan.'}</p>
      <div className="app-error-actions">
        <Link className="primary-button" to="/"><Home size={17} aria-hidden="true" />Về tổng quan</Link>
        <CommonButton className="secondary-button" type="button" onClick={() => window.location.reload()}><ArrowLeft size={17} aria-hidden="true" />Tải lại trang</CommonButton>
      </div>
    </section>
  )
}

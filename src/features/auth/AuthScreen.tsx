import { Button as CommonButton, Input as CommonInput } from '../../shared/ui/Controls'
import { useEffect, useState } from 'react'
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, WalletCards } from 'lucide-react'
import { Link } from 'react-router-dom'
import { z } from 'zod'
import { backendConfigurationError, supabase } from '../../shared/lib/supabase'

const credentialsSchema = z.object({ email: z.email(), password: z.string().min(8).max(128) })
type AuthMode = 'sign-in' | 'sign-up' | 'reset'

function authErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('email address not authorized') || message.includes('email_address_not_authorized')) return 'Supabase chưa được phép gửi email đến địa chỉ này. Hãy cấu hình SMTP riêng trong Authentication → SMTP Settings.'
  if (message.includes('email rate limit') || message.includes('over_email_send_rate_limit')) return 'Supabase đang giới hạn số email xác nhận. Chờ rồi thử lại, hoặc cấu hình SMTP riêng.'
  if (message.includes('user already registered') || message.includes('already been registered')) return 'Email này đã có tài khoản. Hãy đăng nhập hoặc chọn “Quên mật khẩu?”.'
  if (message.includes('email not confirmed')) return 'Email chưa được xác nhận. Mở thư xác nhận trong hộp thư hoặc thư rác rồi thử đăng nhập lại.'
  if (message.includes('password should be at least') || message.includes('weak_password')) return 'Mật khẩu cần dài ít nhất 8 ký tự và đáp ứng yêu cầu bảo mật của Supabase.'
  if (message.includes('invalid login credentials')) return 'Email hoặc mật khẩu chưa đúng. Kiểm tra lại hoặc đặt lại mật khẩu.'
  if (message.includes('failed to fetch') || message.includes('network')) return 'Không kết nối được Supabase. Kiểm tra Wi-Fi và thử lại.'
  return 'Không thể hoàn tất yêu cầu. Kiểm tra cài đặt Auth/SMTP trong Supabase rồi thử lại.'
}

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 6000)
    return () => window.clearTimeout(timer)
  }, [message])

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode)
    setMessage('')
    setShowPassword(false)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    const parsed = credentialsSchema.safeParse({ email, password: mode === 'reset' ? 'reset-password-value' : password })
    if (!parsed.success) {
      setMessage(mode === 'reset' ? 'Vui lòng nhập email hợp lệ.' : 'Email hoặc mật khẩu chưa hợp lệ. Mật khẩu cần ít nhất 8 ký tự.')
      return
    }
    if (!supabase) return setMessage(backendConfigurationError ?? 'Chưa kết nối được dịch vụ.')
    setBusy(true)
    try {
      if (mode === 'sign-in') {
        const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password })
        if (error) throw error
      } else if (mode === 'sign-up') {
        const { error } = await supabase.auth.signUp({ email: parsed.data.email, password, options: { emailRedirectTo: window.location.origin } })
        if (error) throw error
        setMessage('Kiểm tra email để xác nhận tài khoản trước khi đăng nhập.')
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: window.location.origin })
        if (error) throw error
        setMessage('Nếu email đã đăng ký, hướng dẫn đặt lại mật khẩu sẽ được gửi đến hộp thư của bạn.')
      }
    } catch (error) {
      setMessage(authErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'sign-in' ? 'Chào mừng trở lại' : mode === 'sign-up' ? 'Bắt đầu hành trình' : 'Khôi phục mật khẩu'
  const description = mode === 'sign-in'
    ? 'Đăng nhập để xem dòng tiền và tiếp tục quản lý tài chính của bạn.'
    : mode === 'sign-up'
      ? 'Tạo tài khoản riêng tư để bắt đầu ghi chép và theo dõi dòng tiền.'
      : 'Nhập email đã đăng ký. Chúng tôi sẽ gửi hướng dẫn khôi phục cho bạn.'

  return (
    <main className="auth-page">
      <div className="auth-layout">
        <aside className="auth-story" aria-label="Giới thiệu MoneyMate">
          <Link className="auth-brand" to="/" aria-label="MoneyMate">
            <span className="auth-brand-mark">M</span>
            <span>MoneyMate</span>
          </Link>
          <div className="auth-story-copy">
            <span className="auth-story-kicker"><span /> TÀI CHÍNH RÕ RÀNG, MỖI NGÀY</span>
            <h2>Hiểu dòng tiền.<br /><em>An tâm từng khoản.</em></h2>
            <p>Gom thu chi, ngân sách và khoản chia sẻ vào một nơi riêng tư, dễ theo dõi.</p>
            <div className="auth-benefits">
              <span><WalletCards size={17} /> Sổ thu chi của riêng bạn</span>
              <span><ShieldCheck size={17} /> Dữ liệu được bảo vệ theo tài khoản</span>
            </div>
          </div>
          <span className="auth-story-foot">Một cái nhìn rõ ràng hơn về tiền bạc.</span>
        </aside>

        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-card-brand">
            <span className="auth-brand-mark">M</span>
            <span>MoneyMate</span>
          </div>
          <div className="auth-card-heading">
            <p className="eyebrow">{mode === 'sign-in' ? 'KHÔNG GIAN TÀI CHÍNH CỦA BẠN' : mode === 'sign-up' ? 'TẠO KHÔNG GIAN RIÊNG' : 'HỖ TRỢ TÀI KHOẢN'}</p>
            <h1 id="auth-title">{title}</h1>
            <p>{description}</p>
          </div>

          <form onSubmit={submit} noValidate>
            <div className="auth-field">
              <label htmlFor="email">Email</label>
              <div className="auth-input-wrap">
                <Mail size={18} aria-hidden="true" />
                <CommonInput id="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} inputMode="email" placeholder="ten@email.com" required value={email} onChange={event => setEmail(event.target.value)} />
              </div>
            </div>
            {mode !== 'reset' && <div className="auth-field">
              <div className="auth-label-row"><label htmlFor="password">Mật khẩu</label>{mode === 'sign-in' && <CommonButton className="auth-inline-link" type="button" onClick={() => changeMode('reset')}>Quên mật khẩu?</CommonButton>}</div>
              <div className="auth-input-wrap">
                <LockKeyhole size={18} aria-hidden="true" />
                <CommonInput id="password" type={showPassword ? 'text' : 'password'} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} minLength={8} maxLength={128} placeholder="Ít nhất 8 ký tự" required value={password} onChange={event => setPassword(event.target.value)} />
                <CommonButton className="auth-password-toggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</CommonButton>
              </div>
              {mode === 'sign-up' && <span className="auth-field-hint">Dùng ít nhất 8 ký tự để bảo vệ tài khoản.</span>}
            </div>}
            {mode === 'reset' && <p className="auth-reset-note">Đường dẫn khôi phục sẽ được gửi đến email của bạn nếu tài khoản tồn tại.</p>}
            <CommonButton className="auth-submit" type="submit" disabled={busy || !supabase}>
              <span>{busy ? 'Đang xử lý…' : mode === 'sign-in' ? 'Đăng nhập' : mode === 'sign-up' ? 'Tạo tài khoản' : 'Gửi hướng dẫn'}</span>
              {!busy && <ArrowRight size={18} aria-hidden="true" />}
            </CommonButton>
          </form>

          {!supabase && <p className="auth-feedback error" role="status">{backendConfigurationError}</p>}
          {message && <p className={`auth-feedback ${message.startsWith('Kiểm tra email') || message.startsWith('Nếu email') ? 'success' : 'error'}`} role="status">{message}</p>}

          <div className="auth-switch">
            {mode === 'sign-in' ? <><span>Chưa có tài khoản?</span><CommonButton type="button" onClick={() => changeMode('sign-up')}>Tạo tài khoản mới <ArrowRight size={15} /></CommonButton></> : <><span>{mode === 'sign-up' ? 'Đã có tài khoản?' : 'Bạn nhớ mật khẩu rồi?'}</span><CommonButton type="button" onClick={() => changeMode('sign-in')}>Quay lại đăng nhập</CommonButton></>}
          </div>
          <div className="auth-privacy"><ShieldCheck size={15} /><span>Thông tin đăng nhập được truyền trực tiếp qua Supabase Auth.</span></div>
        </section>
      </div>
    </main>
  )
}

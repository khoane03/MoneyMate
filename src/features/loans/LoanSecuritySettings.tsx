import { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, ShieldOff } from 'lucide-react'
import { Button, IconButton, Input } from '../../shared/ui/Controls'
import { supabase } from '../../shared/lib/supabase'
import {
  disableLoanSecurity,
  getLoanSecurityStatus,
  isPlatformAuthenticatorAvailable,
  reauthenticateWithPassword,
  registerLoanPasskey,
  setLoanPin,
  type LoanSecurityStatus,
} from './loanSecurity'

function parseSecurityError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes('invalid login credentials') || lower.includes('invalid_credentials')) {
    return 'Mật khẩu tài khoản chưa đúng. Hãy nhập mật khẩu bạn dùng khi đăng nhập vào MoneyMate (không phải PIN hay mật khẩu thiết bị).'
  }
  if (lower.includes('recent password authentication required')) {
    return 'Cần nhập mật khẩu tài khoản để xác nhận trước khi thực hiện thao tác bảo mật này.'
  }
  if (lower.includes('the operation either timed out or was not allowed') || lower.includes('cancelled') || lower.includes('canceled')) {
    return 'Thao tác passkey bị hủy hoặc đã quá thời gian xác thực.'
  }
  if (lower.includes('functions_fetch_error') || lower.includes('not found') || lower.includes('failed to send a request to the edge function')) {
    return 'Dịch vụ xác thực passkey chưa được triển khai hoặc không phản hồi. Kiểm tra Edge Function loan-security.'
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return 'Không kết nối được dịch vụ. Vui lòng kiểm tra kết nối mạng và thử lại.'
  }
  return message || fallback
}

export function LoanSecuritySettings() {
  const [status, setStatus] = useState<LoanSecurityStatus | null>(null)
  const [platformAvailable, setPlatformAvailable] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await getLoanSecurityStatus())
      setError('')
    } catch {
      setError('Không tải được trạng thái khóa sổ vay. Kiểm tra kết nối và migration bảo mật.')
    }
  }, [])

  useEffect(() => {
    void refresh()
    void isPlatformAuthenticatorAvailable().then(setPlatformAvailable)
  }, [refresh])

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  async function savePin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    if (!/^\d{6}$/.test(pin)) {
      setError('PIN cần đúng 6 chữ số.')
      return
    }
    if (!password) {
      setError('Nhập mật khẩu tài khoản để xác nhận cài đặt PIN.')
      return
    }
    setBusy(true)
    try {
      await reauthenticateWithPassword(password)
      await setLoanPin(pin)
      setPassword('')
      setPin('')
      setNotice('Đã bật khóa sổ vay và cập nhật PIN.')
      await refresh()
    } catch (err) {
      setError(parseSecurityError(err, 'Không lưu được PIN. Kiểm tra mật khẩu, kết nối và thử lại.'))
    } finally {
      setBusy(false)
    }
  }

  async function addPasskey() {
    setError('')
    setNotice('')
    if (!platformAvailable) {
      setError('Thiết bị hoặc trình duyệt chưa hỗ trợ xác thực sinh trắc học an toàn.')
      return
    }
    if (!password) {
      setError('Nhập mật khẩu tài khoản MoneyMate ở trên để xác nhận đăng ký passkey.')
      return
    }
    setBusy(true)
    try {
      await reauthenticateWithPassword(password)
      await registerLoanPasskey('MoneyMate')
      setPassword('')
      setNotice('Đã bật khóa sổ vay và đăng ký passkey trên thiết bị.')
      await refresh()
    } catch (err) {
      setError(parseSecurityError(err, 'Không đăng ký được passkey. Kiểm tra mật khẩu, cấu hình tên miền và thử lại.'))
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setError('')
    setNotice('')
    if (!password) {
      setError('Nhập mật khẩu tài khoản MoneyMate ở trên để tắt khóa sổ vay.')
      return
    }
    setBusy(true)
    try {
      await disableLoanSecurity(password)
      setPassword('')
      setNotice('Đã tắt khóa sổ vay trên tài khoản. PIN và passkey đã đăng ký được giữ lại.')
      await refresh()
    } catch (err) {
      setError(parseSecurityError(err, 'Không tắt được khóa. Kiểm tra lại mật khẩu và kết nối.'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="settings-panel loan-security-settings" aria-labelledby="loan-security-title">
    <div className="loan-security-heading">
      <span className="loan-security-icon" aria-hidden="true"><LockKeyhole size={20}/></span>
      <div><h2 id="loan-security-title">Khóa sổ Vay & Trả nợ</h2><p>Thêm một bước xác thực trước khi xem khoản vay riêng và khoản vay chia sẻ.</p></div>
    </div>
    {!supabase && <p className="form-error" role="alert">Cần kết nối tài khoản để cài đặt bảo mật.</p>}
    {!online && <p className="form-error" role="alert">Cần kết nối mạng để thay đổi cài đặt bảo mật.</p>}
    {!status && !error && <p className="data-status" role="status">Đang tải trạng thái bảo mật…</p>}
    {!status && error && <><p className="form-error" role="alert">{error}</p><Button className="secondary-button" type="button" onClick={() => void refresh()}>Thử tải lại</Button></>}
    {status && <>
      <p className={`loan-security-state ${status.enabled ? 'enabled' : ''}`} role="status">
        {status.enabled ? 'Đang bật' : 'Đang tắt'} · {status.pinConfigured ? 'Đã cài PIN' : 'Chưa cài PIN'} · {status.passkeyCount} passkey
      </p>
      {status.pinLocked && <p className="form-error" role="alert">PIN đang bị tạm khóa sau 5 lần nhập sai. Bạn có thể mở khóa bằng mật khẩu/passkey hoặc đổi PIN mới bằng mật khẩu xác thực lại.</p>}
      <p className="loan-security-explainer">PIN được xác minh trên máy chủ, giới hạn thử sai và tự khóa tạm thời. Touch ID, Face ID hoặc Windows Hello được xử lý bởi passkey của hệ điều hành; MoneyMate không nhận hay lưu dữ liệu sinh trắc học.</p>
      <div className="field-group">
        <label htmlFor="loan-security-password">Mật khẩu đăng nhập MoneyMate (để xác nhận danh tính)</label>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Input id="loan-security-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy || !online} placeholder="Nhập mật khẩu tài khoản" style={{ paddingRight: '44px' }}/>
          <IconButton type="button" label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShowPassword(value => !value)} aria-pressed={showPassword} disabled={busy || !online} style={{ position: 'absolute', right: '4px', width: '36px', height: '36px' }}>
            {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </IconButton>
        </div>
        <small>Nhập mật khẩu bạn dùng khi đăng nhập vào MoneyMate (không phải PIN sổ vay hay mật khẩu thiết bị).</small>
      </div>
      <form className="loan-security-pin-form" onSubmit={event => void savePin(event)}>
        <div className="field-group">
          <label htmlFor="loan-security-pin">{status.pinConfigured ? 'Đổi PIN 6 số' : 'Tạo PIN 6 số'}</label>
          <Input id="loan-security-pin" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" minLength={6} maxLength={6} required disabled={busy || !online}/>
        </div>
        <Button className="secondary-button" type="submit" disabled={busy || !supabase || !online}><KeyRound size={17} aria-hidden="true"/>{status.pinConfigured ? 'Cập nhật PIN' : 'Bật bằng PIN'}</Button>
      </form>
      <div className="loan-security-passkey-row">
        <div><strong>Passkey thiết bị</strong><small>{platformAvailable ? 'Dùng xác thực thiết bị như Touch ID, Face ID hoặc Windows Hello.' : 'Thiết bị hiện không báo hỗ trợ authenticator sinh trắc học.'}</small></div>
        <Button className="secondary-button" type="button" onClick={() => void addPasskey()} disabled={busy || !supabase || !platformAvailable || !online}><Fingerprint size={17} aria-hidden="true"/>Đăng ký passkey</Button>
      </div>
      {status.enabled && <div className="loan-security-disable">
        <p>Để tắt, xác nhận lại mật khẩu tài khoản. Các PIN/passkey đã đăng ký được giữ lại để có thể bật lại sau.</p>
        <Button className="secondary-button" type="button" onClick={() => void turnOff()} disabled={busy || !supabase || !online}><ShieldOff size={17} aria-hidden="true"/>Tắt khóa</Button>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="profile-success" role="status">{notice}</p>}
    </>}
  </section>
}

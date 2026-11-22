import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Fingerprint, KeyRound, LockKeyhole } from 'lucide-react'
import { Button, Input } from '../../shared/ui/Controls'
import { supabase } from '../../shared/lib/supabase'
import {
  getLoanSecurityStatus,
  isPlatformAuthenticatorAvailable,
  lockLoansNow,
  unlockLoansWithPasskey,
  unlockLoansWithPassword,
  unlockLoansWithPin,
  type LoanSecurityStatus,
} from './loanSecurity'
import { LoanSecurityContext } from './loanSecurityContext'

const IDLE_TIMEOUT_MS = 2 * 60 * 1000
const GRANT_RENEWAL_INTERVAL_MS = 45 * 1000

export function LoanSecurityGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoanSecurityStatus | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const [platformAvailable, setPlatformAvailable] = useState(false)
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState(false)

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    setStatusError(false)
    try {
      const currentStatus = await getLoanSecurityStatus()
      setStatus(currentStatus)
      setError('')
    } catch {
      setStatusError(true)
      setError('Không thể kiểm tra trạng thái bảo mật. Cần kết nối mạng và migration khóa sổ vay đã được áp dụng.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    void isPlatformAuthenticatorAvailable().then(setPlatformAvailable)
  }, [refreshStatus])

  useEffect(() => {
    const onlineAgain = () => setOnline(true)
    const offline = () => setOnline(false)
    window.addEventListener('online', onlineAgain)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', onlineAgain)
      window.removeEventListener('offline', offline)
    }
  }, [])

  const lock = useCallback(async () => {
    setUnlocked(false)
    setPin('')
    setPassword('')
    try {
      await lockLoansNow()
    } catch {
      setError('Đã ẩn sổ vay trên thiết bị; quyền mở khóa máy chủ sẽ tự hết hạn trong tối đa 2 phút.')
    }
  }, [])

  useEffect(() => {
    if (!unlocked || !status?.enabled) return
    let timer = 0
    let lastRenewedAt = Date.now()
    let renewing = false
    const expire = () => { void lock() }
    const resetIdleTimer = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(expire, IDLE_TIMEOUT_MS)
      if (Date.now() - lastRenewedAt < GRANT_RENEWAL_INTERVAL_MS || renewing || !supabase) return
      renewing = true
      void (async () => {
        try {
          const { data, error: renewError } = await supabase.rpc('extend_loan_step_up')
          if (renewError || data !== true) expire()
          else lastRenewedAt = Date.now()
        } catch {
          expire()
        } finally {
          renewing = false
        }
      })()
    }
    const onVisibilityChange = () => { if (document.visibilityState !== 'visible') expire() }
    window.addEventListener('pointerdown', resetIdleTimer)
    window.addEventListener('keydown', resetIdleTimer)
    window.addEventListener('touchstart', resetIdleTimer)
    window.addEventListener('scroll', resetIdleTimer, { passive: true })
    window.addEventListener('offline', expire)
    document.addEventListener('visibilitychange', onVisibilityChange)
    resetIdleTimer()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', resetIdleTimer)
      window.removeEventListener('keydown', resetIdleTimer)
      window.removeEventListener('touchstart', resetIdleTimer)
      window.removeEventListener('scroll', resetIdleTimer)
      window.removeEventListener('offline', expire)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      void lockLoansNow().catch(() => undefined)
    }
  }, [lock, status?.enabled, unlocked])

  async function completeUnlock(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await operation()
      setPin('')
      setPassword('')
      setUnlocked(true)
    } catch {
      setError('Xác thực chưa thành công. Kiểm tra thông tin, kết nối hoặc thử phương thức khác.')
    } finally {
      setBusy(false)
    }
  }

  async function submitPin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await unlockLoansWithPin(pin)
      if (result.unlocked) {
        setPin('')
        setUnlocked(true)
      } else {
        setError(result.locked
          ? 'PIN bị tạm khóa sau nhiều lần thử. Chờ 5 phút hoặc dùng mật khẩu/passkey.'
          : 'PIN chưa đúng. Thử lại hoặc dùng mật khẩu/passkey.')
      }
    } catch {
      setError('Không xác thực được PIN. Kiểm tra kết nối hoặc dùng mật khẩu/passkey.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <section className="loan-security-gate" aria-busy="true"><p role="status">Đang kiểm tra khóa sổ vay…</p></section>
  if (statusError || !status) return <section className="loan-security-gate" aria-labelledby="loan-gate-title">
    <LockKeyhole size={28} aria-hidden="true"/><h1 id="loan-gate-title">Không mở được sổ vay</h1>
    <p className="form-error" role="alert">{error}</p>
    <Button className="secondary-button" type="button" onClick={() => void refreshStatus()}>Thử lại</Button>
  </section>
  if (!status.enabled || unlocked) {
    return (
      <LoanSecurityContext.Provider value={{ status, unlocked, lock }}>
        {children}
      </LoanSecurityContext.Provider>
    )
  }

  return <section className="loan-security-gate" aria-labelledby="loan-gate-title">
    <span className="loan-security-icon" aria-hidden="true"><LockKeyhole size={22}/></span>
    <h1 id="loan-gate-title">Sổ vay đang được khóa</h1>
    <p>Xác thực để xem khoản vay riêng và khoản vay chia sẻ. Cần kết nối mạng để mở khóa.</p>
    {!online && <p className="form-error" role="alert">Đang ngoại tuyến. Sổ vay vẫn khóa cho đến khi có mạng.</p>}
    {status.pinConfigured && <form className="loan-security-unlock-form" onSubmit={event => void submitPin(event)}>
      <label htmlFor="loan-unlock-pin">PIN 6 số</label>
      <Input id="loan-unlock-pin" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} maxLength={6} pattern="[0-9]{6}" required disabled={busy || !online}/>
      <Button className="primary-button" type="submit" disabled={busy || pin.length !== 6 || !online}><KeyRound size={17} aria-hidden="true"/>Mở khóa bằng PIN</Button>
    </form>}
    {status.passkeyCount > 0 && <Button className="secondary-button loan-security-method" type="button" disabled={busy || !platformAvailable || !online} onClick={() => void completeUnlock(unlockLoansWithPasskey)}>
      <Fingerprint size={18} aria-hidden="true"/>Mở bằng Touch ID, Face ID hoặc passkey
    </Button>}
    {!platformAvailable && status.passkeyCount > 0 && <small>Thiết bị chưa hỗ trợ passkey xác thực sinh trắc học. Dùng PIN hoặc mật khẩu.</small>}
    <form className="loan-security-unlock-form" onSubmit={event => { event.preventDefault(); void completeUnlock(() => unlockLoansWithPassword(password)) }}>
      <label htmlFor="loan-unlock-password">Hoặc xác thực lại bằng mật khẩu tài khoản</label>
      <Input id="loan-unlock-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy || !online}/>
      <Button className="secondary-button" type="submit" disabled={busy || !password || !online}>Xác thực bằng mật khẩu</Button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}

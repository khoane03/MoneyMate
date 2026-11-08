import { Button as CommonButton, Input as CommonInput } from '../../shared/ui/Controls'
import { useRef, useState } from 'react'
import { Camera, LogOut, Moon, Save, Sun, Trash2 } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { clearUserPartition } from '../../data/local/database'
import { useTheme } from '../../shared/lib/themeContext'
import { prepareAvatar, profileInitial, useAccountProfile } from './accountProfile'

export function SettingsPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const { theme, toggleTheme } = useTheme()
  const { profile, loading, error: profileError, refresh } = useAccountProfile()
  const displayName = name ?? profile?.displayName ?? ''
  const currentAvatar = avatarPreview ?? profile?.avatarUrl ?? null

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('')
    const normalizedName = displayName.trim()
    if (!normalizedName || normalizedName.length > 100) { setError('Tên cần có từ 1 đến 100 ký tự.'); return }
    if (!supabase || !profile) { setError('Không kết nối được tài khoản. Vui lòng tải lại trang.'); return }
    setBusy(true)
    let uploadedPath: string | null = null
    try {
      if (avatarFile) {
        const image = await prepareAvatar(avatarFile)
        uploadedPath = `${profile.userId}/${crypto.randomUUID()}.jpg`
        const { error: uploadError } = await supabase.storage.from('profile-avatars').upload(uploadedPath, image, { contentType: 'image/jpeg', upsert: false })
        if (uploadError) throw uploadError
      }
      const nextPath = uploadedPath ?? profile.avatarPath
      const { error: updateError } = await supabase.from('profiles').update({ display_name: normalizedName, avatar_storage_path: nextPath }).eq('user_id', profile.userId)
      if (updateError) throw updateError
      if (avatarFile && profile.avatarPath) {
        const { error: removeError } = await supabase.storage.from('profile-avatars').remove([profile.avatarPath])
        if (removeError) console.warn('Old private avatar cleanup failed')
      }
      setName(null); setAvatarFile(null); setAvatarPreview(null); setNotice('Đã cập nhật hồ sơ tài khoản.')
      await refresh()
    } catch (cause) {
      if (uploadedPath) await supabase.storage.from('profile-avatars').remove([uploadedPath])
      setError(cause instanceof Error && cause.message.startsWith('Ảnh') || cause instanceof Error && cause.message.startsWith('Chỉ') || cause instanceof Error && cause.message.startsWith('Không')
        ? cause.message : 'Không lưu được hồ sơ. Kiểm tra kết nối rồi thử lại.')
    } finally { setBusy(false) }
  }

  async function removeAvatar() {
    if (!supabase || !profile?.avatarPath) return
    setBusy(true); setError(''); setNotice('')
    const { error: updateError } = await supabase.from('profiles').update({ avatar_storage_path: null }).eq('user_id', profile.userId)
    if (updateError) { setError('Không thể gỡ ảnh đại diện. Vui lòng thử lại.'); setBusy(false); return }
    await supabase.storage.from('profile-avatars').remove([profile.avatarPath])
    setAvatarFile(null); setAvatarPreview(null); setName(null); setNotice('Đã gỡ ảnh đại diện.'); await refresh(); setBusy(false)
  }

  async function signOut() {
    if (!supabase) return
    setBusy(true); setError('')
    const { data } = await supabase.auth.getUser()
    const userId = data.user?.id
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) { setError('Không thể đăng xuất. Kiểm tra kết nối và thử lại.'); setBusy(false); return }
    if (userId) await clearUserPartition(userId)
    setBusy(false)
  }

  function chooseAvatar(file?: File) {
    if (!file) return
    setError(''); setNotice('')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setError(file.size > 8 * 1024 * 1024 ? 'Ảnh cần nhỏ hơn 8 MB.' : 'Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.'); return
    }
    if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    setAvatarFile(file); setAvatarPreview(URL.createObjectURL(file))
  }

  function clearAvatarDraft() {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    setAvatarPreview(null); setAvatarFile(null)
  }

  return <section aria-labelledby="settings-title"><p className="eyebrow">TÀI KHOẢN & RIÊNG TƯ</p><h1 id="settings-title">Cài đặt</h1>
    <form className="settings-panel profile-settings-panel" onSubmit={saveProfile}>
      <div><h2>Hồ sơ tài khoản</h2><p>Tên và ảnh đại diện sẽ hiển thị trong danh sách thành viên của nhóm chia sẻ.</p></div>
      {loading ? <p role="status">Đang tải hồ sơ…</p> : profileError ? <p className="form-error" role="alert">{profileError}</p> : <>
        <div className="profile-editor">
          <div className="profile-photo" aria-label="Ảnh đại diện xem trước">{currentAvatar ? <img src={currentAvatar} alt="Ảnh đại diện"/> : <span>{profileInitial(displayName)}</span>}</div>
          <div className="profile-photo-actions"><CommonButton className="secondary-button" type="button" onClick={() => fileInput.current?.click()} disabled={busy}><Camera size={17}/>Chọn ảnh</CommonButton>{(avatarFile || profile?.avatarPath) && <CommonButton className="profile-remove-button" type="button" onClick={() => avatarFile ? clearAvatarDraft() : void removeAvatar()} disabled={busy}><Trash2 size={16}/>{avatarFile?'Bỏ ảnh đã chọn':'Gỡ ảnh'}</CommonButton>}<small>JPG, PNG hoặc WebP · tối đa 8 MB. Ảnh được thu gọn còn tối đa 512 px.</small></div>
          <CommonInput ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Chọn ảnh đại diện" onChange={event => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = '' }}/>
        </div>
        <div className="profile-name-field"><label htmlFor="account-display-name">Tên hiển thị</label><CommonInput id="account-display-name" value={displayName} onChange={event => setName(event.target.value)} maxLength={100} autoComplete="name" required placeholder="Ví dụ: Minh Anh"/><small>{displayName.length}/100 ký tự</small></div>
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="profile-success" role="status">{notice}</p>}
        <CommonButton className="primary-button profile-save-button" type="submit" disabled={busy || (!avatarFile && displayName.trim() === (profile?.displayName ?? ''))}><Save size={17}/>{busy ? 'Đang lưu…' : 'Lưu hồ sơ'}</CommonButton>
      </>}
    </form>
    <div className="settings-panel theme-settings-panel"><div><h2>Giao diện</h2><p>Chọn chế độ sáng hoặc tối. Lựa chọn được lưu trên thiết bị này.</p></div><CommonButton className="secondary-button theme-toggle" type="button" onClick={toggleTheme} aria-label={`Chuyển sang giao diện ${theme === 'dark' ? 'sáng' : 'tối'}`}><span className="theme-toggle-icon">{theme === 'dark' ? <Sun size={18} aria-hidden="true"/> : <Moon size={18} aria-hidden="true"/>}</span>{theme === 'dark' ? 'Bật giao diện sáng' : 'Bật giao diện tối'}</CommonButton><p className="theme-current" role="status">Đang dùng giao diện {theme === 'dark' ? 'tối' : 'sáng'}</p></div>
    <div className="settings-panel"><h2>Phiên đăng nhập</h2><p>Đăng xuất sẽ xóa dữ liệu đang lưu cục bộ của tài khoản này trên thiết bị.</p>{error && <p className="form-error" role="alert">{error}</p>}<CommonButton className="secondary-button" onClick={()=>void signOut()} disabled={busy || !supabase}><LogOut size={18}/>{busy?'Đang đăng xuất…':'Đăng xuất'}</CommonButton></div>
  </section>
}

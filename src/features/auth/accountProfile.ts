import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'

export type AccountProfile = { userId: string; displayName: string; avatarPath: string | null; avatarUrl: string | null }

export function useAccountProfile() {
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); setError('Chưa kết nối Supabase.'); return }
    setLoading(true); setError('')
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!auth.user) { setProfile(null); return }
      const { data, error: profileError } = await supabase.from('profiles')
        .select('user_id,display_name,avatar_storage_path').eq('user_id', auth.user.id).maybeSingle()
      if (profileError) throw profileError
      let avatarUrl: string | null = null
      if (data?.avatar_storage_path) {
        const { data: signed, error: signedError } = await supabase.storage.from('profile-avatars').createSignedUrl(data.avatar_storage_path, 3600)
        if (!signedError) avatarUrl = signed.signedUrl
      }
      setProfile({ userId: auth.user.id, displayName: data?.display_name ?? '', avatarPath: data?.avatar_storage_path ?? null, avatarUrl })
    } catch {
      setError('Không tải được thông tin tài khoản. Vui lòng thử lại.')
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  return { profile, setProfile, loading, error, refresh }
}

export function profileInitial(name: string) {
  return name.trim().split(/\s+/).at(-1)?.slice(0, 1).toLocaleUpperCase('vi-VN') || 'M'
}

export async function prepareAvatar(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.')
  if (file.size > 8 * 1024 * 1024) throw new Error('Ảnh cần nhỏ hơn 8 MB.')
  const image = new Image()
  const source = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Không đọc được ảnh này.')); image.src = source })
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Trình duyệt không thể xử lý ảnh.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    if (!blob) throw new Error('Không thể chuẩn bị ảnh đại diện.')
    if (blob.size > 3 * 1024 * 1024) throw new Error('Ảnh sau xử lý vẫn lớn hơn 3 MB.')
    return blob
  } finally { URL.revokeObjectURL(source) }
}

import { supabase } from './supabase'

export type MediaPurpose = 'receipt' | 'transaction-evidence' | 'loan-evidence' | 'bill-checkin' | 'avatar'

type UploadTicket = {
  cloud_name: string
  api_key: string
  public_id: string
  timestamp: number
  signature: string
  type: 'authenticated'
  overwrite: 'false'
}

type CloudinaryUpload = {
  asset_id?: string
  public_id?: string
  version?: number
  format?: string
  bytes?: number
  resource_type?: string
  signature?: string
  error?: { message?: string }
}

async function invokeMedia<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('Chưa kết nối được dịch vụ ảnh riêng tư.')
  const { data, error } = await supabase.functions.invoke('media', { body })
  if (error) throw new Error('Dịch vụ ảnh riêng tư chưa sẵn sàng. Vui lòng thử lại.')
  if (!data || typeof data !== 'object') throw new Error('Dịch vụ ảnh trả về dữ liệu không hợp lệ.')
  if ('error' in data) throw new Error('Không thể xử lý ảnh riêng tư. Vui lòng thử lại.')
  return data as T
}

export async function uploadPrivateImage(file: Blob, purpose: MediaPurpose, checksum?: string): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.')
  const ticket = await invokeMedia<UploadTicket>({ action: 'prepare_upload', purpose, checksum: checksum ?? null, byte_size: file.size })
  const form = new FormData()
  form.set('file', file)
  form.set('api_key', ticket.api_key)
  form.set('timestamp', String(ticket.timestamp))
  form.set('public_id', ticket.public_id)
  form.set('type', ticket.type)
  form.set('overwrite', ticket.overwrite)
  form.set('signature', ticket.signature)
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(ticket.cloud_name)}/image/upload`, { method: 'POST', body: form })
  const uploaded = await response.json() as CloudinaryUpload
  if (!response.ok || uploaded.error || !uploaded.asset_id || !uploaded.public_id || !uploaded.version || !uploaded.format || !uploaded.signature) {
    await invokeMedia({ action: 'cancel_upload', public_id: ticket.public_id }).catch(() => undefined)
    throw new Error('Không tải được ảnh lên Cloudinary. Kiểm tra kết nối và thử lại.')
  }
  try {
    await invokeMedia({
      action: 'complete_upload', public_id: uploaded.public_id, asset_id: uploaded.asset_id,
      version: uploaded.version, format: uploaded.format, byte_size: uploaded.bytes,
      resource_type: uploaded.resource_type, response_signature: uploaded.signature,
    })
    return uploaded.public_id
  } catch (error) {
    await invokeMedia({ action: 'cancel_upload', public_id: ticket.public_id }).catch(() => undefined)
    throw error
  }
}

export async function getPrivateImageUrl(publicId: string, expiresIn = 1800): Promise<string> {
  const result = await invokeMedia<{ url: string }>({ action: 'view', public_id: publicId, expires_in: expiresIn })
  if (!result.url) throw new Error('Không tạo được liên kết xem ảnh.')
  return result.url
}

export async function deletePrivateImage(publicId: string): Promise<void> {
  await invokeMedia({ action: 'delete', public_id: publicId })
}

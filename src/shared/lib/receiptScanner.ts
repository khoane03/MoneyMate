import { createWorker } from 'tesseract.js'
import { parseReceiptText, type OcrSuggestion } from './receiptOcr'

export type ReceiptScanResult = {
  suggestion: OcrSuggestion
  confidence: number
  rawText: string
}

export type ReceiptScanProgress = { percent: number; message: string }

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export type ReceiptOcrWorker = Awaited<ReturnType<typeof createWorker>>

async function prepareImage(file: File): Promise<Blob> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('Chọn ảnh JPG, PNG hoặc WebP để đọc hóa đơn.')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Ảnh quá lớn. Chọn ảnh dưới 15 MB.')
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) { bitmap.close(); throw new Error('Trình duyệt không thể xử lý ảnh này.') }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Không thể chuẩn bị ảnh để đọc hóa đơn.')), 'image/jpeg', 0.9))
}

export async function scanReceiptImage(
  file: File,
  onProgress?: (progress: ReceiptScanProgress) => void,
  onWorker?: (worker: ReceiptOcrWorker | null) => void,
): Promise<ReceiptScanResult> {
  const image = await prepareImage(file)
  const worker = await createWorker('vie', 1, {
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    cacheMethod: 'write',
    logger: message => {
      if (message.status) onProgress?.({
        percent: message.status === 'recognizing text' ? Math.round(message.progress * 100) : 0,
        message: message.status === 'recognizing text' ? 'Đang đọc nội dung hóa đơn…' : 'Đang tải bộ đọc tiếng Việt…',
      })
    },
  })
  onWorker?.(worker)
  try {
    const result = await worker.recognize(image, { rotateAuto: true })
    return { suggestion: parseReceiptText(result.data.text), confidence: result.data.confidence, rawText: result.data.text }
  } finally {
    onWorker?.(null)
    await worker.terminate().catch(() => undefined)
  }
}

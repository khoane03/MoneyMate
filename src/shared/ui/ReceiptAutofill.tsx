import { useEffect, useRef, useState } from 'react'
import { Camera, FileImage, LoaderCircle, ReceiptText, X } from 'lucide-react'
import { scanReceiptImage, type ReceiptOcrWorker, type ReceiptScanProgress } from '../lib/receiptScanner'
import type { OcrSuggestion } from '../lib/receiptOcr'
import { Button } from './Controls'

type Props = {
  onApply: (suggestion: OcrSuggestion, confidence: number, rawText: string) => void
  label?: string
  onImageSelected?: (file: File | null) => void
}

export function ReceiptAutofill({ onApply, label = 'Quét hóa đơn để tự điền', onImageSelected }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<ReceiptOcrWorker | null>(null)
  const cancelledRef = useRef(false)
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState(false)
  const [progress, setProgress] = useState<ReceiptScanProgress>({ percent: 0, message: '' })
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [rawText, setRawText] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => () => { void workerRef.current?.terminate() }, [])
  useEffect(() => {
    if (!file) { setPreviewUrl(''); return }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function read() {
    if (!file || reading) return
    setError(''); setStatus(''); setReading(true)
    cancelledRef.current = false
    try {
      const result = await scanReceiptImage(file, setProgress, worker => { workerRef.current = worker })
      onApply(result.suggestion, result.confidence, result.rawText)
      setRawText(result.rawText)
      setStatus(result.suggestion.total
        ? `Đã điền gợi ý · độ tin cậy ${Math.round(result.confidence)}%. Hãy đối chiếu ảnh và chỉnh các trường.`
        : 'Đã đọc ảnh nhưng chưa nhận ra tổng tiền. Hãy kiểm tra và nhập các trường thủ công.')
      setProgress({ percent: 100, message: 'Đọc xong.' })
    } catch (cause) {
      if (!cancelledRef.current) setError(cause instanceof Error ? cause.message : 'Không đọc được ảnh. Hãy thử ảnh rõ hơn hoặc nhập thủ công.')
    } finally { workerRef.current = null; setReading(false) }
  }

  async function cancel() {
    cancelledRef.current = true
    const worker = workerRef.current
    workerRef.current = null
    if (worker) await worker.terminate().catch(() => undefined)
    setReading(false); setProgress({ percent: 0, message: 'Đã hủy đọc ảnh.' })
  }

  return <section className="receipt-autofill" aria-label="Quét hóa đơn">
    <div className="receipt-autofill-actions">
      <input ref={inputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Chọn ảnh hóa đơn để tự điền" onChange={event => { const selected = event.target.files?.[0] ?? null; setFile(selected); onImageSelected?.(selected); setError(''); setStatus(''); setRawText(''); setProgress({ percent: 0, message: '' }); event.currentTarget.value = '' }} />
      <Button type="button" className="secondary-button" onClick={() => inputRef.current?.click()} disabled={reading}><Camera size={16}/>{file ? 'Chọn ảnh khác' : label}</Button>
      {file && !reading && <><span className="receipt-autofill-file"><FileImage size={14}/>{file.name}</span><Button type="button" className="text-button" aria-label="Bỏ ảnh hóa đơn" onClick={() => { setFile(null); onImageSelected?.(null); setStatus(''); setError(''); setRawText('') }}><X size={15}/></Button><Button type="button" className="secondary-button" onClick={() => void read()}><ReceiptText size={16}/>Đọc và điền</Button></>}
      {reading && <><span className="receipt-autofill-progress"><LoaderCircle size={15} className="spin"/>{progress.message} {progress.percent}%</span><Button type="button" className="secondary-button" onClick={() => void cancel()}><X size={15}/>Hủy</Button></>}
    </div>
    {file && previewUrl && <details className="receipt-autofill-preview"><summary>Xem ảnh hóa đơn để đối chiếu</summary><img src={previewUrl} alt={`Ảnh hóa đơn ${file.name}`} /></details>}
    {reading && <progress value={progress.percent} max={100} aria-label="Tiến độ đọc hóa đơn"/>}
    {status && <p className="receipt-autofill-status" role="status">{status}</p>}
    {error && <p className="receipt-autofill-error" role="alert">{error}</p>}
    {rawText && <details className="receipt-autofill-raw"><summary>Văn bản đọc được để đối chiếu</summary><pre>{rawText}</pre></details>}
    <small>Ảnh được đọc trên thiết bị. Dữ liệu chỉ là gợi ý, bạn kiểm tra và xác nhận trước khi lưu.</small>
  </section>
}

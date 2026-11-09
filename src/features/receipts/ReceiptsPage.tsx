import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'
import { Camera, Check, FileImage, LoaderCircle, Plus, ReceiptText, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { calculateLineTotal } from '../../shared/lib/sharedSplits'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { parseReceiptText } from '../../shared/lib/receiptOcr'
import { createUuid } from '../../shared/lib/uuid'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { ImageViewer } from '../../shared/ui/ImageViewer'
import { AmountInWords } from '../../shared/ui/AmountInWords'
import { useConfirm } from '../../shared/ui/useConfirm'
import { deletePrivateImage, getPrivateImageUrl, uploadPrivateImage } from '../../shared/lib/privateMedia'

type Wallet = { id: string; display_name: string }
type Category = { id: string; name: string }
type ReceiptItemDraft = { id: string; name: string; quantity: string; unitPrice: string; confidence: number | null }
type ReceiptRecord = { id: string; storage_path: string | null; merchant: string; accounting_date: string; total_bigint: string; original_name: string; ocr_confidence: number | null; created_at: string }
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const RECEIPT_PAGE_SIZE = 30
const todayHcm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
const newItem = (): ReceiptItemDraft => ({ id: createUuid(), name: '', quantity: '1', unitPrice: '', confidence: null })

function sha256(blob: Blob) {
  return blob.arrayBuffer().then(buffer => crypto.subtle.digest('SHA-256', buffer)).then(hash =>
    [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''))
}

async function prepareOcrImage(file: File): Promise<Blob> {
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

export function ReceiptsPage() {
  const confirm = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null)
  const [userId, setUserId] = useState('')
  const [receiptId, setReceiptId] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => createUuid())
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [records, setRecords] = useState<ReceiptRecord[]>([])
  const [walletId, setWalletId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [merchant, setMerchant] = useState('')
  const [accountingDate, setAccountingDate] = useState(todayHcm())
  const [total, setTotal] = useState('')
  const [items, setItems] = useState<ReceiptItemDraft[]>([])
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null)
  const [rawOcrText, setRawOcrText] = useState('')
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrStatus, setOcrStatus] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreRecords, setHasMoreRecords] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    const client = supabase
    setLoading(true); setError('')
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError || !authData.user) { setError('Hãy đăng nhập để lưu hóa đơn vào sổ riêng.'); setLoading(false); return }
    setUserId(authData.user.id)
    const [walletResult, categoryResult, receiptResult] = await Promise.all([
      fetchAllPages((from, to) => client.from('wallets').select('id,display_name')
        .eq('status','active').order('display_name').order('id').range(from, to)),
      fetchAllPages((from, to) => client.from('categories').select('id,name').eq('kind','expense')
        .order('name').order('id').range(from, to)),
      client.from('receipts').select('id,storage_path,merchant,accounting_date,total_bigint,original_name,ocr_confidence,created_at').order('created_at',{ascending:false}).order('id',{ascending:false}).range(0,RECEIPT_PAGE_SIZE-1)
    ])
    if (walletResult.error || categoryResult.error || receiptResult.error) {
      setError('Chưa tải được hóa đơn. Kiểm tra migration 202611070004_receipts và quyền RLS trên Supabase.')
    } else {
      setWallets((walletResult.data ?? []) as Wallet[])
      setCategories((categoryResult.data ?? []) as Category[])
      setRecords((receiptResult.data ?? []) as ReceiptRecord[])
      setHasMoreRecords((receiptResult.data ?? []).length === RECEIPT_PAGE_SIZE)
      setWalletId(current => current || walletResult.data?.[0]?.id || '')
    }
    setLoading(false)
  }, [])

  const loadMoreRecords = useCallback(async () => {
    if (!supabase || loadingMore || !hasMoreRecords) return
    setLoadingMore(true)
    const from = records.length
    const { data, error: pageError } = await supabase.from('receipts')
      .select('id,storage_path,merchant,accounting_date,total_bigint,original_name,ocr_confidence,created_at')
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + RECEIPT_PAGE_SIZE - 1)
    if (pageError) setError('Không tải thêm được hóa đơn. Hãy thử lại.')
    else {
      const page = (data ?? []) as ReceiptRecord[]
      setRecords(current => [...current, ...page])
      setHasMoreRecords(page.length === RECEIPT_PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [hasMoreRecords, loadingMore, records.length])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!file) { setPreviewUrl(''); return }
    const url = URL.createObjectURL(file); setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  useEffect(() => () => { void workerRef.current?.terminate() }, [])

  const itemTotals = items.map(item => {
    try { return calculateLineTotal(item.quantity, item.unitPrice) } catch { return null }
  })
  const calculatedTotal = itemTotals.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n)
  let parsedTotal = 0n
  try { if (total) parsedTotal = parseVnd(total) } catch { /* shown as a validation error on submit */ }
  const totalMatches = parsedTotal > 0n && calculatedTotal === parsedTotal && itemTotals.every(value => value !== null)
  const canRead = Boolean(file && !reading && file.type.startsWith('image/'))

  function selectImage(selected: File | undefined) {
    if (!selected) return
    setError(''); setNotice(''); setOcrConfidence(null); setRawOcrText(''); setItems([]); setTotal(''); setMerchant('')
    if (!['image/jpeg','image/png','image/webp'].includes(selected.type)) {
      setFile(null); setError('Chọn ảnh JPG, PNG hoặc WebP. Hóa đơn PDF cần xuất thành ảnh trước khi đọc.'); return
    }
    if (selected.size > MAX_IMAGE_BYTES) { setFile(null); setError('Ảnh quá lớn. Chọn ảnh dưới 15 MB để giữ trang luôn phản hồi tốt.'); return }
    setFile(selected); setReceiptId(createUuid()); setIdempotencyKey(createUuid()); setAccountingDate(todayHcm())
  }

  async function runOcr() {
    if (!file) return
    setError(''); setNotice(''); setReading(true); setOcrProgress(0); setOcrStatus('Đang chuẩn bị bộ đọc tiếng Việt…')
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null
    try {
      const image = await prepareOcrImage(file)
      worker = await createWorker('vie', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        cacheMethod: 'write',
        logger: message => {
          if (message.status) setOcrStatus(message.status === 'recognizing text' ? 'Đang đọc nội dung hóa đơn…' : 'Đang tải bộ đọc tiếng Việt…')
          if (message.status === 'recognizing text') setOcrProgress(Math.round(message.progress * 100))
        }
      })
      workerRef.current = worker
      const result = await worker.recognize(image, { rotateAuto: true })
      const suggestion = parseReceiptText(result.data.text)
      setIdempotencyKey(createUuid())
      setRawOcrText(result.data.text)
      setMerchant(current => current || suggestion.merchant)
      setAccountingDate(suggestion.accountingDate || todayHcm())
      setOcrConfidence(result.data.confidence)
      setItems(suggestion.items.length ? suggestion.items.map(item => ({ id: createUuid(), name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, confidence: result.data.confidence })) : [])
      setTotal(suggestion.total)
      setOcrStatus('Đã đọc xong. Hãy so sánh từng dòng với ảnh trước khi lưu.')
      if (!suggestion.total) setNotice('Chưa nhận diện được tổng tiền. Nhập tổng hóa đơn và các món thủ công để xác nhận.')
      else if (!suggestion.items.length) setNotice('Chưa tách được món hàng. Thêm các dòng hoặc xác nhận một dòng tổng trước khi lưu.')
      setOcrProgress(100)
    } catch (cause) {
      setError(cause instanceof Error ? `Không đọc được ảnh: ${cause.message}` : 'Không đọc được ảnh. Kiểm tra kết nối để tải bộ OCR tiếng Việt rồi thử lại.')
      setOcrStatus('OCR chưa hoàn tất.')
    } finally {
      workerRef.current = null
      if (worker) await worker.terminate().catch(() => undefined)
      setReading(false)
    }
  }

  async function cancelOcr() {
    const worker = workerRef.current
    workerRef.current = null
    if (worker) await worker.terminate().catch(() => undefined)
    setReading(false); setOcrStatus('Đã hủy đọc hóa đơn. Ảnh vẫn giữ nguyên.')
  }

  function updateItem(id: string, update: Partial<ReceiptItemDraft>) {
    setIdempotencyKey(createUuid())
    setItems(current => current.map(item => item.id === id ? { ...item, ...update } : item))
  }

  async function saveReceipt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('')
    if (!supabase || !file || !userId) { setError('Cần đăng nhập và chọn ảnh hóa đơn trước khi lưu.'); return }
    if (!walletId) { setError('Tạo ví riêng trước khi lưu hóa đơn thành giao dịch.'); return }
    if (!totalMatches) { setError('Tổng các dòng món hàng phải bằng đúng tổng hóa đơn. Hãy đối chiếu ảnh và chỉnh số tiền trước khi xác nhận.'); return }
    if (items.length === 0) { setError('Thêm ít nhất một dòng món hàng.'); return }
    if (ocrConfidence !== null && ocrConfidence < 55) {
      const accepted = await confirm({ title: 'Độ tin cậy OCR thấp', description: 'Hãy đối chiếu ảnh và kiểm tra lại toàn bộ tên món, số lượng và giá trước khi lưu giao dịch.', confirmLabel: 'Tôi đã kiểm tra', tone: 'warning' })
      if (!accepted) return
    }
    let amount: bigint
    try { amount = parseVnd(total); if (amount <= 0n) throw new Error() } catch { setError('Tổng hóa đơn cần là số nguyên đồng dương.'); return }
    setSaving(true)
    let storagePath: string | null = null
    try {
      const checksum = await sha256(file)
      storagePath = await uploadPrivateImage(file, 'receipt', checksum)
      const occurredAt = new Date(`${accountingDate}T12:00:00+07:00`).toISOString()
      const rpcItems = items.map((item, index) => ({ name: item.name.trim(), quantity: item.quantity.replace(',','.'), unit_price: item.unitPrice, confidence: item.confidence, position: index }))
      const { error: saveError } = await supabase.rpc('create_receipt_expense', {
        p_receipt_id: receiptId, p_wallet_id: walletId, p_category_id: categoryId || null,
        p_merchant: merchant.trim(), p_occurred_at: occurredAt, p_accounting_date: accountingDate,
        p_total_bigint: amount.toString(), p_storage_path: storagePath, p_checksum: checksum,
        p_original_name: file.name.slice(0,255), p_ocr_confidence: ocrConfidence,
        p_items: rpcItems, p_idempotency_key: idempotencyKey
      })
      if (saveError) throw new Error(saveError.message.includes('does not exist') ? 'Cơ sở dữ liệu chưa có bảng hóa đơn. Hãy áp dụng migration 202611070004_receipts trước.' : 'Không thể xác nhận hóa đơn. Kiểm tra ví, tổng các món và quyền truy cập rồi thử lại.')
      setNotice('Đã lưu hóa đơn riêng tư và ghi đúng một giao dịch chi vào ví của bạn.')
      setFile(null); setReceiptId(''); setIdempotencyKey(createUuid()); setItems([]); setTotal(''); setMerchant(''); setOcrConfidence(null); setOcrProgress(0)
      await refresh()
    } catch (cause) {
      if (storagePath) await deletePrivateImage(storagePath).catch(() => undefined)
      setError(cause instanceof Error ? cause.message : 'Không thể lưu hóa đơn. Dữ liệu vẫn còn trên biểu mẫu để thử lại.')
    }
    setSaving(false)
  }

  const confidenceLabel = useMemo(() => ocrConfidence === null ? '' : ocrConfidence >= 80 ? 'Khá rõ' : ocrConfidence >= 55 ? 'Cần kiểm tra' : 'Độ tin cậy thấp', [ocrConfidence])

  return <section className="receipts-page" aria-labelledby="receipts-title">
    <LoadingModal message={reading ? (ocrStatus || 'Đang bóc tách nội dung hóa đơn…') : 'Đang tải danh sách hóa đơn…'} show={loading || reading} />
    <header className="content-heading"><div><p className="eyebrow">ẢNH XỬ LÝ TRÊN THIẾT BỊ</p><h1 id="receipts-title">Hóa đơn & OCR</h1><p className="subheading">Đọc hóa đơn tiếng Việt, kiểm tra từng con số rồi mới ghi thành giao dịch chi.</p></div><CommonButton className="secondary-button" type="button" onClick={()=>void refresh()} disabled={loading} aria-label="Tải lại hóa đơn"><RotateCcw size={17}/></CommonButton></header>
    <div className="receipt-privacy-note"><FileImage size={18}/><span>Ảnh được đọc ngay trên trình duyệt. Chỉ tải lên kho riêng tư của tài khoản này sau khi bạn xác nhận lưu.</span></div>
    {error&&<div className="form-error" role="alert">{error}<CommonButton type="button" onClick={()=>void refresh()}>Tải lại</CommonButton></div>}
    {notice&&<p className="receipt-notice" role="status">{notice}</p>}
    {!file?<div className="receipt-capture-card"><div className="receipt-capture-icon"><Camera size={25}/></div><h2>Chụp hoặc chọn ảnh hóa đơn</h2><p>JPG, PNG hoặc WebP · tối đa 15 MB. Tải bộ OCR tiếng Việt lần đầu cần có mạng; ảnh không được gửi đến nhà cung cấp OCR.</p><CommonButton type="button" className="primary-button" onClick={()=>inputRef.current?.click()}><Camera size={17}/>Chụp ảnh hoặc chọn tệp</CommonButton></div>:<>
      <div className="receipt-workspace"><section className="receipt-photo-panel"><div className="receipt-photo-heading"><div><h2>Ảnh gốc</h2><p>{file.name} · {(file.size/1024/1024).toFixed(1)} MB</p></div><CommonButton type="button" className="text-button" onClick={()=>{setFile(null);setError('');setNotice('')}} disabled={saving||reading} aria-label="Bỏ ảnh hóa đơn"><X size={17}/></CommonButton></div><div className="receipt-preview">{previewUrl&&<img src={previewUrl} alt={`Xem trước ảnh hóa đơn ${file.name}`}/>}</div><div className="receipt-ocr-controls">{reading?<><div className="receipt-progress-label"><LoaderCircle size={16} className="spin"/><span>{ocrStatus}</span><strong>{ocrProgress}%</strong></div><progress value={ocrProgress} max={100} aria-label="Tiến độ đọc hóa đơn"/><CommonButton type="button" className="secondary-button" onClick={()=>void cancelOcr()}><X size={16}/>Hủy đọc</CommonButton></>:<CommonButton type="button" className="secondary-button" onClick={()=>void runOcr()} disabled={!canRead}><ReceiptText size={17}/>{ocrConfidence===null?'Đọc hóa đơn bằng OCR': 'Đọc lại ảnh'}</CommonButton>}</div></section>
        <form className="receipt-review-form" onSubmit={saveReceipt}><div className="receipt-review-heading"><div><p className="eyebrow">BƯỚC 2 · ĐỐI CHIẾU VÀ XÁC NHẬN</p><h2>Kiểm tra nội dung</h2><p>OCR chỉ đưa ra gợi ý. Số tiền chưa được ghi vào sổ cho đến khi bạn xác nhận.</p></div>{ocrConfidence!==null&&<span className={`ocr-confidence ${ocrConfidence<55?'low':''}`}>{confidenceLabel} · {Math.round(ocrConfidence)}%</span>}</div>
          {ocrStatus&&<p className="ocr-status" aria-live="polite">{ocrStatus}</p>}{rawOcrText&&<details className="receipt-raw-text"><summary>Văn bản OCR gốc để đối chiếu</summary><pre>{rawOcrText}</pre></details>}
          <div className="receipt-field-grid"><div className="receipt-field"><label htmlFor="receipt-merchant">Cửa hàng</label><CommonInput id="receipt-merchant" value={merchant} onChange={event=>{setIdempotencyKey(createUuid());setMerchant(event.target.value)}} maxLength={160}/></div><div className="receipt-field"><label htmlFor="receipt-date">Ngày trên hóa đơn</label><CommonInput id="receipt-date" type="date" value={accountingDate} onChange={event=>{setIdempotencyKey(createUuid());setAccountingDate(event.target.value)}} required/></div><div className="receipt-field"><label htmlFor="receipt-wallet">Ghi chi từ ví</label><CommonDropdown id="receipt-wallet" value={walletId} onChange={event=>{setIdempotencyKey(createUuid());setWalletId(event.target.value)}} required><option value="">Chọn ví</option>{wallets.map(wallet=><option value={wallet.id} key={wallet.id}>{wallet.display_name}</option>)}</CommonDropdown></div><div className="receipt-field"><label htmlFor="receipt-category">Danh mục chi</label><CommonDropdown id="receipt-category" value={categoryId} onChange={event=>{setIdempotencyKey(createUuid());setCategoryId(event.target.value)}}><option value="">Không chọn</option>{categories.map(category=><option value={category.id} key={category.id}>{category.name}</option>)}</CommonDropdown></div><div className="receipt-field receipt-total-field"><label htmlFor="receipt-total">Tổng hóa đơn (₫)</label><CommonInput id="receipt-total" inputMode="numeric" value={total} onChange={event=>{setIdempotencyKey(createUuid());setTotal(normalizeVndInput(event.target.value))}} required/><AmountInWords id="receipt-total" value={total}/></div></div>
          <div className="receipt-items-heading"><div><h3>Các món hàng</h3><p>Kiểm tra số lượng, đơn giá và thành tiền; tổng phải khớp với hóa đơn.</p></div><CommonButton type="button" className="secondary-button mobile-plus-action" aria-label="Thêm dòng món hàng" title="Thêm dòng món hàng" onClick={()=>{setIdempotencyKey(createUuid());setItems(current=>[...current,newItem()])}}><Plus size={18} aria-hidden="true"/><span className="mobile-plus-label">Thêm dòng</span></CommonButton></div>
          {items.length===0?<div className="receipt-items-empty"><p>Chưa tách được món. Bạn có thể nhập thủ công hoặc thêm một dòng tổng hóa đơn.</p><CommonButton type="button" className="text-button" onClick={()=>{setIdempotencyKey(createUuid());setItems([{...newItem(),name:'Tổng hóa đơn',unitPrice:total}])}} disabled={!total}>Tạo dòng tổng</CommonButton></div>:<div className="receipt-items-list">{items.map((item,index)=>{let lineTotal:bigint|null=null;try{lineTotal=calculateLineTotal(item.quantity,item.unitPrice)}catch{/* incomplete field */}return <fieldset className="receipt-item-row" key={item.id}><legend>Món {index+1}{item.confidence!==null&&item.confidence<55?' · cần kiểm tra':''}</legend><div className="receipt-item-inputs"><div className="receipt-field item-name-field"><label htmlFor={`receipt-item-name-${item.id}`}>Tên món</label><CommonInput id={`receipt-item-name-${item.id}`} value={item.name} onChange={event=>updateItem(item.id,{name:event.target.value})} maxLength={120} required/></div><div className="receipt-field"><label htmlFor={`receipt-item-qty-${item.id}`}>Số lượng</label><CommonInput id={`receipt-item-qty-${item.id}`} inputMode="decimal" value={item.quantity} onChange={event=>updateItem(item.id,{quantity:event.target.value.replace(/[^0-9.,]/g,'')})} required/></div><div className="receipt-field"><label htmlFor={`receipt-item-price-${item.id}`}>Đơn giá</label><CommonInput id={`receipt-item-price-${item.id}`} inputMode="numeric" value={item.unitPrice} onChange={event=>updateItem(item.id,{unitPrice:normalizeVndInput(event.target.value)})} required/><AmountInWords id={`receipt-item-price-${item.id}`} value={item.unitPrice}/></div><div className="receipt-line-total"><small>Thành tiền</small><strong>{lineTotal===null?'—':formatVnd(lineTotal)}</strong></div><CommonButton type="button" className="receipt-remove-item" onClick={()=>{setIdempotencyKey(createUuid());setItems(current=>current.filter(row=>row.id!==item.id))}} aria-label={`Xóa món ${index+1}`}><Trash2 size={16}/></CommonButton></div></fieldset>})}</div>}
          <div className={`receipt-total-check ${totalMatches?'matched':'mismatch'}`}><span>Tổng các dòng món</span><strong>{formatVnd(calculatedTotal)}</strong><span>Tổng hóa đơn đã nhập</span><strong>{parsedTotal>0n?formatVnd(parsedTotal):'Chưa nhập'}</strong><p>{totalMatches?<><Check size={15}/> Hai tổng đang khớp</>:'Cần đối chiếu và làm cho hai tổng khớp nhau'}</p></div>
          <div className="receipt-save-actions"><CommonButton type="button" className="secondary-button" onClick={()=>inputRef.current?.click()} disabled={saving||reading}><Upload size={16}/>Chọn ảnh khác</CommonButton><CommonButton type="submit" className="primary-button" disabled={saving||reading||!totalMatches||items.length===0||wallets.length===0}>Xác nhận và ghi chi</CommonButton></div>
          {wallets.length===0&&<p className="receipt-inline-warning">Tạo ví trước để ghi nhận giao dịch chi.</p>}
        </form>
      </div>
    </>}
    <section className="receipt-history"><header><div><p className="eyebrow">SỔ RIÊNG CỦA BẠN</p><h2>Hóa đơn đã lưu</h2><p>Ảnh chỉ tài khoản của bạn xem được.</p></div></header>{loading&&records.length===0?null:records.length===0?<div className="receipt-history-empty"><ReceiptText size={21}/><span>Hóa đơn bạn xác nhận sẽ xuất hiện ở đây.</span></div>:<><ul className="receipt-history-list">{records.map(record=><ReceiptHistoryRow key={record.id} receipt={record}/>)}</ul>{hasMoreRecords&&<div className="list-pagination"><CommonButton type="button" className="secondary-button" onClick={()=>void loadMoreRecords()} disabled={loadingMore}>{loadingMore?'Đang tải thêm…':'Tải thêm hóa đơn'}</CommonButton></div>}</>}</section>
    <CommonInput ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="visually-hidden" aria-label="Chọn ảnh hóa đơn" tabIndex={-1} onChange={event=>{selectImage(event.target.files?.[0]);event.currentTarget.value=''}}/>
  </section>
}

function ReceiptHistoryRow({receipt}:{receipt:ReceiptRecord}) {
  async function loadImage() {
    if(!receipt.storage_path) throw new Error('Ảnh hóa đơn cũ đã được xóa.')
    return getPrivateImageUrl(receipt.storage_path,300)
  }
  return <li><div><strong>{receipt.merchant||'Hóa đơn'}</strong><small>{formatDate(receipt.accounting_date)} · {receipt.original_name}</small></div><b>{formatVnd(receipt.total_bigint)}</b>{receipt.storage_path&&<ImageViewer loadSrc={loadImage} alt={`Ảnh hóa đơn ${receipt.merchant||receipt.accounting_date}`} label={`Xem ảnh hóa đơn ${receipt.merchant||receipt.accounting_date}`} className="secondary-button"><FileImage size={16}/>Xem ảnh</ImageViewer>}</li>
}

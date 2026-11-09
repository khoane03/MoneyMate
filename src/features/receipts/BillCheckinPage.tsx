import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, ReceiptText, Share2, Sparkles, Users, WalletCards, X } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { createUuid } from '../../shared/lib/uuid'
import { formatVnd, normalizeVndInput, parseVnd } from '../../shared/lib/money'
import { formatDate } from '../../shared/lib/dateFormat'
import { fetchAllPages } from '../../shared/lib/pagination'
import { scanReceiptImage, type ReceiptOcrWorker, type ReceiptScanProgress } from '../../shared/lib/receiptScanner'
import { Button, Dropdown, Input } from '../../shared/ui/Controls'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { AmountInWords } from '../../shared/ui/AmountInWords'
import { ImageViewer } from '../../shared/ui/ImageViewer'
import { deletePrivateImage, getPrivateImageUrl, uploadPrivateImage } from '../../shared/lib/privateMedia'

type Wallet = { id: string; display_name: string }
type Category = { id: string; name: string }
type Checkin = { id: string; transaction_id?: string; owner_id?: string; owner_display_name?: string; caption: string; storage_path: string | null; created_at: string; amount_bigint: string; accounting_date: string; image_url: string | null }
type Group = { id: string; label: string }
type GroupMember = { connection_id: string; user_id: string; display_name: string }

const todayHcm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
const maxImageBytes = 15 * 1024 * 1024
const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp']

export function BillCheckinPage() {
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<ReceiptOcrWorker | null>(null)
  const [userId, setUserId] = useState('')
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [recent, setRecent] = useState<Checkin[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [shareConnectionId, setShareConnectionId] = useState('')
  const [feedConnectionId, setFeedConnectionId] = useState('')
  const [sharedFeed, setSharedFeed] = useState<Checkin[]>([])
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedRefreshKey, setFeedRefreshKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [cameraStarting, setCameraStarting] = useState(false)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayHcm())
  const [walletId, setWalletId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [checkinId, setCheckinId] = useState(() => createUuid())
  const [idempotencyKey, setIdempotencyKey] = useState(() => createUuid())
  const [progress, setProgress] = useState<ReceiptScanProgress>({ percent: 0, message: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)
    const client = supabase
    const [userResult, walletResult, categoryResult, checkinResult, memberResult] = await Promise.all([
      client.auth.getUser(),
      fetchAllPages((from, to) => client.from('wallets').select('id,display_name').eq('status', 'active').order('display_name').range(from, to)),
      fetchAllPages((from, to) => client.from('categories').select('id,name').eq('kind', 'expense').order('name').range(from, to)),
      client.from('personal_bill_checkins').select('id,transaction_id,caption,storage_path,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(30),
      fetchAllPages((from, to) => client.from('connection_members').select('connection_id,user_id,display_name').order('joined_at').range(from, to)),
    ])
    if (userResult.error || !userResult.data.user || walletResult.error || categoryResult.error || checkinResult.error || memberResult.error) {
      setError(checkinResult.error?.message.includes('personal_bill_checkins') ? 'Cần áp dụng migration 202611080007_personal_bill_checkins trước khi dùng Check-in bill.' : 'Chưa tải được dữ liệu check-in. Kiểm tra kết nối rồi thử lại.')
      setLoading(false)
      return
    }
    const ownerId = userResult.data.user.id
    const rows = (checkinResult.data ?? []) as Array<Omit<Checkin, 'amount_bigint' | 'accounting_date' | 'image_url'>>
    const txIds = rows.map(row => row.transaction_id)
    const txResult = txIds.length ? await client.from('transactions').select('id,amount_bigint,accounting_date').in('id', txIds) : { data: [], error: null }
    const transactions = new Map((txResult.data ?? []).map(row => [row.id, row]))
    const hydrated = await Promise.all(rows.map(async row => {
      const tx = transactions.get(row.transaction_id)
      let imageUrl: string | null = null
      if (row.storage_path) {
        imageUrl = await getPrivateImageUrl(row.storage_path, 1800).catch(() => null)
      }
      return { ...row, amount_bigint: tx?.amount_bigint ?? '0', accounting_date: tx?.accounting_date ?? row.created_at.slice(0, 10), image_url: imageUrl }
    }))
    setUserId(ownerId)
    setWallets((walletResult.data ?? []) as Wallet[])
    setCategories((categoryResult.data ?? []) as Category[])
    setWalletId(current => current || (walletResult.data ?? [])[0]?.id || '')
    setRecent(hydrated)
    const members = (memberResult.data ?? []) as GroupMember[]
    const grouped = [...new Set(members.map(member => member.connection_id))].map(connectionId => {
      const names = members.filter(member => member.connection_id === connectionId && member.user_id !== ownerId).map(member => member.display_name)
      return { id: connectionId, label: names.length ? `Nhóm cùng ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : 'Nhóm chia sẻ' }
    })
    setGroups(grouped)
    setFeedConnectionId(current => grouped.some(group => group.id === current) ? current : grouped[0]?.id ?? '')
    setError('')
    setLoading(false)
  }, [])

  useEffect(() => {
    const update = () => { void refresh() }
    window.addEventListener('moneymate:financial-change', update)
    return () => window.removeEventListener('moneymate:financial-change', update)
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const client = supabase
    if (!client || !feedConnectionId) { setSharedFeed([]); return }
    let active = true
    const load = async () => {
      setFeedLoading(true)
      setSharedFeed([])
      const { data, error: feedError } = await client.rpc('get_shared_personal_bill_checkins', { p_connection_id: feedConnectionId, p_limit: 50 })
      if (!active) return
      if (feedError) {
        setSharedFeed([])
        setError(feedError.message.includes('get_shared_personal_bill_checkins') ? 'Cần áp dụng migration chia sẻ Check-in trước khi mở bảng tin nhóm.' : 'Chưa tải được Check-in của nhóm.')
        setFeedLoading(false)
        return
      }
      const rows = (data ?? []) as Array<Omit<Checkin, 'image_url'>>
      const hydrated = await Promise.all(rows.map(async row => {
        if (!row.storage_path) return { ...row, image_url: null }
        return { ...row, image_url: await getPrivateImageUrl(row.storage_path, 1800).catch(() => null) }
      }))
      if (active) { setSharedFeed(hydrated); setFeedLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [feedConnectionId, feedRefreshKey])
  useEffect(() => {
    if (!file) { setPreviewUrl(''); return }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  useEffect(() => {
    document.body.classList.add('bill-checkin-immersive')
    return () => document.body.classList.remove('bill-checkin-immersive')
  }, [])
  useEffect(() => () => { void workerRef.current?.terminate() }, [])
  useEffect(() => {
    if (!cameraActive || !videoRef.current || !cameraStreamRef.current) return
    videoRef.current.srcObject = cameraStreamRef.current
    void videoRef.current.play().catch(() => setCameraError('Không thể phát hình ảnh camera. Hãy chọn ảnh từ thư viện.'))
  }, [cameraActive])
  useEffect(() => () => cameraStreamRef.current?.getTracks().forEach(track => track.stop()), [])

  const canSave = useMemo(() => Boolean(walletId && caption.trim() && amount && !saving && !reading), [walletId, caption, amount, saving, reading])

  function rotateRequest() {
    setCheckinId(createUuid())
    setIdempotencyKey(createUuid())
  }

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop())
    cameraStreamRef.current = null
    setCameraActive(false)
  }

  async function startCamera() {
    if (cameraStarting || cameraActive) return
    setError(''); setCameraError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Trình duyệt không thể mở camera trực tiếp ở trang này. Tính năng cần HTTPS và quyền camera; bạn vẫn có thể dùng camera thiết bị hoặc chọn ảnh.')
      return
    }
    setCameraStarting(true)
    try {
      stopCamera()
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      cameraStreamRef.current = stream
      setCameraActive(true)
    } catch {
      setCameraError('Camera chưa được cấp quyền hoặc đang được ứng dụng khác sử dụng. Cho phép quyền camera rồi thử lại, hoặc dùng camera thiết bị/thư viện ảnh.')
    } finally { setCameraStarting(false) }
  }

  async function captureFrame() {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError('Camera chưa sẵn sàng. Chờ một chút rồi thử lại.')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) { setCameraError('Không thể chụp ảnh ở trình duyệt này.'); return }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) { setCameraError('Không tạo được ảnh. Hãy thử lại hoặc chọn ảnh từ thư viện.'); return }
    chooseImage(new File([blob], `checkin-${Date.now()}.jpg`, { type: 'image/jpeg' }))
    stopCamera()
  }

  function chooseImage(selected: File | undefined) {
    if (!selected) return
    if (!acceptedImageTypes.includes(selected.type)) { setError('Chọn ảnh JPG, PNG hoặc WebP.'); return }
    if (selected.size > maxImageBytes) { setError('Ảnh quá lớn. Chọn ảnh dưới 15 MB.'); return }
    rotateRequest()
    stopCamera()
    setFile(selected)
    setError('')
    setCameraError('')
    setNotice('')
    setProgress({ percent: 0, message: '' })
  }

  async function readBill() {
    if (!file || reading) return
    setReading(true); setError(''); setNotice('')
    try {
      const result = await scanReceiptImage(file, setProgress, worker => { workerRef.current = worker })
      rotateRequest()
      if (result.suggestion.total) setAmount(result.suggestion.total)
      if (result.suggestion.merchant) setCaption(result.suggestion.merchant.slice(0, 240))
      if (result.suggestion.accountingDate) setDate(result.suggestion.accountingDate)
      setNotice(result.suggestion.total ? 'Đã điền thông tin gợi ý. Hãy đối chiếu lại với bill trước khi lưu.' : 'Chưa nhận ra số tiền. Bạn có thể nhập thủ công.')
      if (result.confidence < 55) setNotice('Độ tin cậy thấp. Hãy kiểm tra kỹ thông tin được gợi ý trước khi lưu.')
    } catch (cause) {
      setError(cause instanceof Error ? `Không đọc được bill: ${cause.message}` : 'Không đọc được ảnh. Bạn vẫn có thể nhập thông tin thủ công.')
    } finally { workerRef.current = null; setReading(false) }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('')
    if (!supabase || !userId) { setError('Cần đăng nhập để lưu khoản chi.'); return }
    if (!walletId) { setError('Tạo ví trước khi ghi nhận khoản chi.'); return }
    let total: bigint
    try { total = parseVnd(amount); if (total <= 0n) throw new Error() }
    catch { setError('Nhập số tiền nguyên dương bằng đồng Việt Nam.'); return }
    if (!caption.trim()) { setError('Nhập nội dung hóa đơn hoặc nơi mua.'); return }
    setSaving(true)
    let storagePath: string | null = null
    try {
      if (file) {
        storagePath = await uploadPrivateImage(file, 'bill-checkin')
      }
      const occurredAt = new Date(`${date}T12:00:00+07:00`).toISOString()
      const rpcName = shareConnectionId ? 'create_shared_personal_bill_checkin' : 'create_personal_bill_checkin'
      const { error: saveError } = await supabase.rpc(rpcName, {
        p_checkin_id: checkinId, p_wallet_id: walletId, p_amount_bigint: total.toString(),
        p_occurred_at: occurredAt, p_accounting_date: date, p_category_id: categoryId || null,
        p_caption: caption.trim(), p_storage_path: storagePath, p_idempotency_key: idempotencyKey,
        ...(shareConnectionId ? { p_connection_id: shareConnectionId } : {}),
      })
      if (saveError) throw new Error(saveError.message.includes('does not exist') ? 'Cơ sở dữ liệu chưa có migration Check-in bill. Hãy áp dụng migration 202611080007.' : saveError.code === '23514' ? 'Cơ sở dữ liệu chưa nhận dạng định dạng ảnh Cloudinary. Hãy áp dụng migration 202611090003.' : 'Không lưu được khoản chi. Kiểm tra ví, danh mục và thử lại.')
      setNotice(shareConnectionId ? 'Đã lưu khoản chi và chia sẻ Check-in với nhóm.' : 'Đã lưu check-in thành một khoản chi trong sổ của bạn.')
      if (shareConnectionId) { setFeedConnectionId(shareConnectionId); setFeedRefreshKey(value => value + 1) }
      setFile(null); setCaption(''); setAmount(''); setDate(todayHcm()); setCategoryId(''); setShareConnectionId(''); setProgress({ percent: 0, message: '' })
      rotateRequest()
      await refresh()
    } catch (cause) {
      if (storagePath) await deletePrivateImage(storagePath).catch(() => undefined)
      setError(cause instanceof Error ? cause.message : 'Không lưu được bill. Thử lại.')
    } finally { setSaving(false) }
  }

  return <section className="bill-checkin-page" aria-labelledby="bill-checkin-title">
    <LoadingModal show={loading} message="Đang mở Check-in…" />
    <header className="bill-checkin-topbar">
      <Link to="/more" className="bill-checkin-back" aria-label="Quay lại menu"><ArrowLeft size={20}/></Link>
      <div className="bill-checkin-brand"><span className="bill-checkin-brand-mark">M</span><div><strong>Check-in chi tiêu</strong><small>Sản phẩm, món ăn hoặc bill của bạn</small></div></div>
      <span className="bill-checkin-private" title={shareConnectionId ? 'Check-in này sẽ được chia sẻ với nhóm đã chọn' : 'Chỉ bạn xem được'}>{shareConnectionId ? <Users size={17}/> : <WalletCards size={17}/>}</span>
    </header>

    <div className="bill-checkin-layout">
      <section className="bill-checkin-capture" aria-label="Chụp ảnh sản phẩm hoặc khoản chi">
        <div className="bill-checkin-camera-top"><span><span className="bill-checkin-live-dot"/> SỔ CÁ NHÂN</span><span>{cameraActive ? 'Camera đang bật' : 'Ảnh tùy chọn'}</span></div>
        <div className={`bill-checkin-viewfinder ${previewUrl || cameraActive ? 'has-photo' : ''}`}>
          {previewUrl ? <img src={previewUrl} alt={`Ảnh check-in: ${caption || 'sản phẩm hoặc khoản chi'}`} /> : cameraActive ? <video ref={videoRef} autoPlay playsInline muted aria-label="Hình ảnh camera trực tiếp" /> : <div className="bill-checkin-camera-placeholder"><span className="camera-orbit"><Camera size={34}/></span><strong>Chụp một khoảnh khắc chi tiêu</strong><span>Sản phẩm, món ăn, bill hoặc khoản chi bất kỳ. Bạn cũng có thể lưu không kèm ảnh.</span><Button type="button" className="bill-checkin-start-camera" disabled={cameraStarting} onClick={() => void startCamera()}>{cameraStarting ? <LoaderCircle className="spin" size={17}/> : <Camera size={17}/>}<span>{cameraStarting ? 'Đang bật camera…' : 'Bật camera trực tiếp'}</span></Button><small>Trình duyệt sẽ hỏi quyền camera khi bạn bấm nút này.</small></div>}
          {previewUrl && <button className="bill-checkin-remove-photo" type="button" onClick={() => { setFile(null); rotateRequest() }} aria-label="Bỏ ảnh check-in"><X size={17}/></button>}
          {cameraActive && <button className="bill-checkin-remove-photo" type="button" onClick={stopCamera} aria-label="Tắt camera"><X size={17}/></button>}
          <input ref={cameraInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Chụp ảnh bill bằng camera" onChange={event => { chooseImage(event.target.files?.[0]); event.currentTarget.value = '' }}/>
          <input ref={galleryInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Chọn ảnh bill từ thư viện" onChange={event => { chooseImage(event.target.files?.[0]); event.currentTarget.value = '' }}/>
        </div>
        <div className="bill-checkin-camera-actions">
          <Button type="button" className="bill-checkin-gallery" onClick={() => galleryInput.current?.click()} aria-label="Chọn ảnh từ thư viện"><ImagePlus size={21}/></Button>
          <Button type="button" className="bill-checkin-shutter" disabled={cameraStarting} onClick={() => cameraActive ? void captureFrame() : void startCamera()} aria-label={cameraStarting ? 'Đang bật camera' : cameraActive ? 'Chụp ảnh' : 'Bật camera trực tiếp'}>{cameraStarting ? <LoaderCircle size={24} className="spin"/> : <span/>}</Button>
          <Button type="button" className="bill-checkin-read" disabled={!file || reading} onClick={() => void readBill()} aria-label="Gợi ý thông tin từ ảnh">{reading ? <LoaderCircle size={21} className="spin"/> : <Sparkles size={21}/>}</Button>
        </div>
        <div className="bill-checkin-camera-hints"><span>{file ? file.name : cameraStarting ? 'Đang bật camera…' : cameraActive ? 'Chạm nút giữa để chụp' : 'Ảnh tùy chọn'}</span><span>{reading ? `${progress.message} ${progress.percent}%` : file ? 'Nút gợi ý đọc nội dung, số tiền và ngày' : 'Bật camera hoặc nhập không cần ảnh'}</span></div>
        {cameraError && <div className="bill-checkin-camera-error" role="status"><span>{cameraError}</span><Button type="button" onClick={() => cameraInput.current?.click()}>Dùng camera thiết bị</Button></div>}
      </section>

      <section className="bill-checkin-entry">
        <div className="bill-checkin-entry-heading"><div><p className="bill-checkin-kicker">LƯU THÀNH KHOẢN CHI</p><h1 id="bill-checkin-title">Check-in hôm nay</h1><p>Lưu sản phẩm, món ăn hoặc khoản chi. Ảnh chỉ mình bạn xem.</p></div><ReceiptText size={24}/></div>
        <form className="bill-checkin-form" onSubmit={save}>
          <div className="bill-checkin-amount-field"><label htmlFor="bill-checkin-amount">Số tiền đã chi</label><div><Input id="bill-checkin-amount" inputMode="numeric" value={amount} onChange={event => { rotateRequest(); setAmount(normalizeVndInput(event.target.value)) }} placeholder="0" required /><span>₫</span></div>{amount && <small>{formatVnd(amount)}</small>}<AmountInWords id="bill-checkin-amount" value={amount}/></div>
          <div className="bill-checkin-field"><label htmlFor="bill-checkin-caption">Sản phẩm / nội dung chi</label><Input id="bill-checkin-caption" value={caption} onChange={event => { rotateRequest(); setCaption(event.target.value) }} maxLength={240} placeholder="Ví dụ: Tai nghe mới, Cà phê sáng…" required /></div>
          <div className="bill-checkin-field"><label htmlFor="bill-checkin-date">Ngày ghi sổ</label><Input id="bill-checkin-date" type="date" value={date} onChange={event => { rotateRequest(); setDate(event.target.value) }} required /></div>
          <div className="bill-checkin-field"><label htmlFor="bill-checkin-wallet">Trừ từ ví</label><Dropdown id="bill-checkin-wallet" value={walletId} onChange={event => { rotateRequest(); setWalletId(event.target.value) }} required><option value="">Chọn ví</option>{wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{wallet.display_name}</option>)}</Dropdown></div>
          <div className="bill-checkin-field"><label htmlFor="bill-checkin-category">Danh mục</label><Dropdown id="bill-checkin-category" value={categoryId} onChange={event => { rotateRequest(); setCategoryId(event.target.value) }}><option value="">Chưa phân loại</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Dropdown></div>
          <div className="bill-checkin-field bill-checkin-share-field"><label htmlFor="bill-checkin-share">Chia sẻ Check-in</label><Dropdown id="bill-checkin-share" value={shareConnectionId} onChange={event => { rotateRequest(); setShareConnectionId(event.target.value) }}><option value="">Không chia sẻ · chỉ mình tôi</option>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</Dropdown><small><Share2 size={13} aria-hidden="true"/>{shareConnectionId ? 'Nhóm thấy ảnh, nội dung, ngày và số tiền. Ví và danh mục vẫn riêng tư.' : 'Bạn có thể chọn một nhóm để cùng xem khoảnh khắc chi tiêu.'}</small></div>
          {error && <p className="bill-checkin-message error" role="alert">{error}</p>}
          {notice && <p className="bill-checkin-message success" role="status"><Check size={16}/>{notice}</p>}
          {!wallets.length && !loading && <p className="bill-checkin-message error">Tạo ví trong “Ví của tôi” trước khi lưu khoản chi.</p>}
          <Button type="submit" className="bill-checkin-save" disabled={!canSave || !wallets.length}>{saving ? <LoaderCircle className="spin" size={19}/> : <Check size={19}/>}<span>{saving ? 'Đang lưu…' : 'Lưu vào khoản chi'}</span><ChevronRight size={18}/></Button>
        </form>
      </section>
    </div>

    {groups.length > 0 && <section className="shared-checkin-feed" aria-labelledby="shared-checkin-feed-title">
      <header><div><p className="bill-checkin-kicker">KHOẢNH KHẮC CỦA NHÓM</p><h2 id="shared-checkin-feed-title">Vuốt để xem Check-in</h2><p>Vuốt trái hoặc phải, hoặc dùng nút điều hướng bên dưới.</p></div><div className="shared-checkin-group-select"><label htmlFor="shared-checkin-group">Nhóm</label><Dropdown id="shared-checkin-group" value={feedConnectionId} onChange={event => setFeedConnectionId(event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</Dropdown></div></header>
      {feedLoading && sharedFeed.length === 0 ? null : <SharedCheckinDeck items={sharedFeed} />}
    </section>}

    <section className="bill-checkin-recent" aria-labelledby="bill-checkin-recent-title">
      <header><div><p className="bill-checkin-kicker">NHỮNG LẦN GẦN ĐÂY</p><h2 id="bill-checkin-recent-title">Check-in gần đây</h2></div><Link to="/transactions?filter=expense">Xem sổ chi <ChevronRight size={16}/></Link></header>
      {recent.length === 0 ? <p className="bill-checkin-recent-empty"><Camera size={18}/>Sản phẩm và khoản chi đã lưu sẽ hiện ở đây.</p> : <div className="bill-checkin-recent-grid">{recent.map(item => <article className="bill-checkin-recent-card" key={item.id}>
        {item.image_url ? <ImageViewer src={item.image_url} alt={`Ảnh check-in: ${item.caption}`} label={`Xem ảnh ${item.caption}`} className="bill-checkin-recent-photo"><img src={item.image_url} alt="" loading="lazy"/></ImageViewer> : <div className="bill-checkin-recent-no-photo"><ReceiptText size={25}/><span>Không có ảnh</span></div>}
        <div><strong>{item.caption}</strong><small>{formatDate(item.accounting_date)}</small><b>{formatVnd(item.amount_bigint)}</b></div>
      </article>)}</div>}
    </section>
  </section>
}

function SharedCheckinDeck({ items }: { items: Checkin[] }) {
  const [index, setIndex] = useState(0)
  const [dragX, setDragX] = useState(0)
  const startX = useRef<number | null>(null)
  useEffect(() => { setIndex(0); setDragX(0) }, [items])
  if (!items.length) return <div className="shared-checkin-empty"><Users size={22} aria-hidden="true"/><strong>Chưa có Check-in được chia sẻ</strong><span>Check-in mới sẽ xuất hiện ở đây sau khi thành viên chọn chia sẻ với nhóm.</span></div>
  const item = items[index] ?? items[0]!
  const move = (direction: -1 | 1) => { setIndex(current => (current + direction + items.length) % items.length); setDragX(0) }
  return <div className="shared-checkin-deck">
    <div className="shared-checkin-stack" aria-live="polite">
      {items.length > 1 && <span className="shared-checkin-card-shadow" aria-hidden="true"/>}
      <article className="shared-checkin-card" style={{ transform: `translateX(${dragX}px) rotate(${dragX / 25}deg)` }} onPointerDown={event => { startX.current=event.clientX; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if(startX.current!==null) setDragX(Math.max(-120,Math.min(120,event.clientX-startX.current))) }} onPointerUp={event => { if(startX.current===null)return; const delta=event.clientX-startX.current; startX.current=null; if(Math.abs(delta)>55) move(delta<0?1:-1); else setDragX(0) }} onPointerCancel={() => { startX.current=null; setDragX(0) }}>
        <div className="shared-checkin-card-photo">{item.image_url ? <ImageViewer src={item.image_url} alt={`Ảnh Check-in của ${item.owner_display_name}: ${item.caption}`} label={`Xem ảnh Check-in của ${item.owner_display_name}`} className="shared-checkin-photo-button"><img src={item.image_url} alt="" draggable={false}/><span><Camera size={17} aria-hidden="true"/>Chạm để xem ảnh</span></ImageViewer> : <div className="shared-checkin-no-photo"><ReceiptText size={34} aria-hidden="true"/><span>Check-in không có ảnh</span></div>}</div>
        <div className="shared-checkin-card-copy"><div><span className="shared-checkin-avatar" aria-hidden="true">{item.owner_display_name?.slice(0,1).toLocaleUpperCase('vi-VN') ?? 'M'}</span><span><strong>{item.owner_display_name ?? 'Thành viên'}</strong><small>{formatDate(item.accounting_date)}</small></span></div><h3>{item.caption}</h3><b>{formatVnd(item.amount_bigint)}</b></div>
      </article>
    </div>
    <div className="shared-checkin-controls"><Button type="button" onClick={() => move(-1)} aria-label="Xem Check-in trước"><ChevronLeft size={20} aria-hidden="true"/></Button><span>{index+1} / {items.length}</span><Button type="button" onClick={() => move(1)} aria-label="Xem Check-in tiếp theo"><ChevronRight size={20} aria-hidden="true"/></Button></div>
  </div>
}

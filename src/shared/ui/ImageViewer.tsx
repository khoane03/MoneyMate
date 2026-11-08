import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, X, ZoomIn } from 'lucide-react'
import { Button } from './Controls'

type ImageViewerProps = {
  src?: string | null
  alt: string
  label?: string
  className?: string
  children?: ReactNode
  loadSrc?: () => Promise<string>
}

/** Opens private evidence inside the app and never navigates to the signed URL. */
export function ImageViewer({ src, alt, label = 'Xem ảnh', className = '', children, loadSrc }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [resolvedSrc, setResolvedSrc] = useState(src ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (src) setResolvedSrc(src) }, [src])

  async function open() {
    setError('')
    let nextSrc = src ?? resolvedSrc
    if (!nextSrc && loadSrc) {
      setLoading(true)
      try { nextSrc = await loadSrc(); setResolvedSrc(nextSrc) }
      catch { setError('Không tải được ảnh. Kiểm tra kết nối rồi thử lại.') }
      finally { setLoading(false) }
    }
    if (nextSrc) dialogRef.current?.showModal()
  }

  function close() { dialogRef.current?.close() }

  return <>
    <Button type="button" className={className} onClick={() => void open()} disabled={loading} aria-label={label}>
      {loading ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : children ?? <><ZoomIn size={16} aria-hidden="true" />{label}</>}
    </Button>
    {error && <span className="image-viewer-error" role="alert">{error}</span>}
    <dialog ref={dialogRef} className="image-viewer-dialog" aria-labelledby={titleId} onClick={event => { if (event.target === dialogRef.current) close() }}>
      <div className="image-viewer-shell">
        <header><strong id={titleId}>{label}</strong><Button type="button" onClick={close} aria-label="Đóng ảnh"><X size={21} aria-hidden="true" /></Button></header>
        {resolvedSrc && <img src={resolvedSrc} alt={alt} />}
      </div>
    </dialog>
  </>
}

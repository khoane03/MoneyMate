import { Button as CommonButton } from './Controls'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CircleHelp, ShieldAlert } from 'lucide-react'
import { ConfirmContext, type ConfirmOptions } from './confirmContext'

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const resolveRef = useRef<((result: boolean) => void) | null>(null)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const confirm = useCallback((next: ConfirmOptions) => new Promise<boolean>(resolve => {
    resolveRef.current?.(false)
    resolveRef.current = resolve
    setOptions(next)
  }), [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (options && dialog && !dialog.open) dialog.showModal()
  }, [options])

  function close(result: boolean) {
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close(result ? 'confirm' : 'cancel')
  }

  function finish() {
    resolveRef.current?.(dialogRef.current?.returnValue === 'confirm')
    resolveRef.current = null
    setOptions(null)
  }

  const Icon = options?.tone === 'danger' ? ShieldAlert : options?.tone === 'warning' ? AlertTriangle : CircleHelp

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <dialog
        ref={dialogRef}
        className={`confirm-dialog ${options?.tone ?? 'neutral'}`}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={finish}
        onCancel={event => { event.preventDefault(); close(false) }}
        onClick={event => { if (event.target === dialogRef.current) close(false) }}
      >
        {options && <div className="confirm-dialog-content">
          <span className="confirm-dialog-icon"><Icon size={24} aria-hidden="true" /></span>
          <h2 id={titleId}>{options.title}</h2>
          <p id={descriptionId}>{options.description}</p>
          <div className="confirm-dialog-actions">
            <CommonButton className="secondary-button" type="button" autoFocus onClick={() => close(false)}>{options.cancelLabel ?? 'Hủy'}</CommonButton>
            <CommonButton className={options.tone === 'danger' ? 'confirm-danger-button' : 'primary-button'} type="button" onClick={() => close(true)}>{options.confirmLabel ?? 'Xác nhận'}</CommonButton>
          </div>
        </div>}
      </dialog>
    </ConfirmContext.Provider>
  )
}

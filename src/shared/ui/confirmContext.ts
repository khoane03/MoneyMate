import { createContext } from 'react'

export type ConfirmOptions = {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'warning' | 'neutral'
}

export type ConfirmContextValue = { confirm: (options: ConfirmOptions) => Promise<boolean> }
export const ConfirmContext = createContext<ConfirmContextValue | null>(null)

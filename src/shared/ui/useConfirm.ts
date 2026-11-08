import { useContext } from 'react'
import { ConfirmContext } from './confirmContext'

export function useConfirm() {
  const context = useContext(ConfirmContext)
  if (!context) throw new Error('useConfirm must be used inside ConfirmProvider')
  return context.confirm
}

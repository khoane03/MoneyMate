import { createContext, useContext } from 'react'
import type { LoanSecurityStatus } from './loanSecurity'

export type LoanSecurityContextValue = {
  status: LoanSecurityStatus | null
  unlocked: boolean
  lock: () => Promise<void>
}

export const LoanSecurityContext = createContext<LoanSecurityContextValue | null>(null)

export function useLoanSecurity(): LoanSecurityContextValue | null {
  return useContext(LoanSecurityContext)
}

export type LoanMovement = { kind: string; amount_bigint: string; affects_outstanding: boolean }
export type LinkedLoanMovement = LoanMovement & { loan_origin_transaction_id?: string | null }
export type LenderLoan = { id: string; loan_lender_name: string | null }

export function loanLenderGroupKey(lenderName: string | null, loanId: string): string {
  const normalizedName = lenderName?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi-VN')
  return normalizedName ? `lender:${normalizedName}` : `unknown:${loanId}`
}

export function groupLoansByLender<T extends LenderLoan>(
  loans: T[]
): Array<{ key: string; lenderName: string; loans: T[] }> {
  const groups = new Map<string, { key: string; lenderName: string; loans: T[] }>()
  for (const loan of loans) {
    const key = loanLenderGroupKey(loan.loan_lender_name, loan.id)
    const group = groups.get(key)
    if (group) group.loans.push(loan)
    else groups.set(key, {
      key,
      lenderName: loan.loan_lender_name?.trim().replace(/\s+/gu, ' ') || 'Chưa ghi rõ',
      loans: [loan]
    })
  }
  return Array.from(groups.values())
}

export function calculateOutstanding(movements: LoanMovement[]): bigint {
  return movements.reduce((sum, movement) => {
    if (!movement.affects_outstanding) return sum
    if (movement.kind === 'borrowed_funds') return sum + BigInt(movement.amount_bigint)
    if (movement.kind === 'loan_principal_payment') return sum - BigInt(movement.amount_bigint)
    return sum
  }, 0n)
}

export function calculateLoanPaid(loanId: string, movements: LinkedLoanMovement[]): bigint {
  return movements.reduce((sum, movement) => movement.kind === 'loan_principal_payment'
    && movement.loan_origin_transaction_id === loanId && movement.affects_outstanding
    ? sum + BigInt(movement.amount_bigint) : sum, 0n)
}

export function calculateLoanRemaining(loanId: string, principal: string, movements: LinkedLoanMovement[]): bigint {
  const remaining = BigInt(principal) - calculateLoanPaid(loanId, movements)
  return remaining > 0n ? remaining : 0n
}

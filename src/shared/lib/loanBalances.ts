export type LoanMovement = { kind: string; amount_bigint: string; affects_outstanding: boolean }
export type LinkedLoanMovement = LoanMovement & { loan_origin_transaction_id?: string | null }

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

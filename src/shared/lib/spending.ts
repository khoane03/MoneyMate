export type SpendingMovement = { kind: string; amount_bigint: string }

export function isSpendingKind(kind: string): boolean {
  return kind === 'expense' || kind === 'loan_principal_payment'
}

export function calculateSpendingTotal(movements: SpendingMovement[]): bigint {
  return movements.reduce((sum, movement) => isSpendingKind(movement.kind)
    ? sum + BigInt(movement.amount_bigint) : sum, 0n)
}

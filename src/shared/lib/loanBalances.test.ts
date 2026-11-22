import { describe, expect, it } from 'vitest'
import { groupLoansByLender, loanLenderGroupKey } from './loanBalances'

describe('groupLoansByLender', () => {
  it('groups the same lender despite extra spaces and capitalization', () => {
    const groups = groupLoansByLender([
      { id: 'loan-1', loan_lender_name: '  Anh Minh  ' },
      { id: 'loan-2', loan_lender_name: 'anh   minh' },
      { id: 'loan-3', loan_lender_name: 'Chị Lan' }
    ])

    expect(groups).toEqual([
      { key: 'lender:anh minh', lenderName: 'Anh Minh', loans: [
        { id: 'loan-1', loan_lender_name: '  Anh Minh  ' },
        { id: 'loan-2', loan_lender_name: 'anh   minh' }
      ] },
      { key: 'lender:chị lan', lenderName: 'Chị Lan', loans: [
        { id: 'loan-3', loan_lender_name: 'Chị Lan' }
      ] }
    ])
  })

  it('does not merge loans with an unknown lender', () => {
    expect(loanLenderGroupKey(null, 'loan-1')).not.toBe(loanLenderGroupKey(null, 'loan-2'))
    expect(groupLoansByLender([
      { id: 'loan-1', loan_lender_name: null },
      { id: 'loan-2', loan_lender_name: null }
    ])).toHaveLength(2)
  })
})

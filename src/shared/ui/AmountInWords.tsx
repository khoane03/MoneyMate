import { useEffect, useState } from 'react'
import { amountInVietnameseWords } from '../lib/money'

type AmountInWordsProps = { id: string; value: string }

/** A compact, screen-reader announced Vietnamese reading of a VND input. */
export function AmountInWords({ id, value }: AmountInWordsProps) {
  const [spoken, setSpoken] = useState(() => amountInVietnameseWords(value))

  useEffect(() => {
    const timeout = window.setTimeout(() => setSpoken(amountInVietnameseWords(value)), 250)
    return () => window.clearTimeout(timeout)
  }, [value])

  if (!spoken) return null
  return <small id={`${id}-words`} className="amount-in-words" aria-live="polite" aria-atomic="true">{spoken}</small>
}

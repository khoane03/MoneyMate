export type PageResult<T> = { data: T[] | null; error: unknown | null }

/**
 * Reads a complete collection through bounded API pages. Use only when the
 * caller needs every row; activity feeds should expose load-more instead.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 500,
): Promise<PageResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer')
  }

  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1)
    if (result.error) return { data: null, error: result.error }
    const page = result.data ?? []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

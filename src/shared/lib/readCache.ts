/** Session-only cache for reference data. Financial and authorization reads bypass it. */
export function createReferenceFetch(network: typeof fetch, now = Date.now) {
  const entries = new Map<string, { expires: number; response: Response }>()
  const pending = new Map<string, Promise<Response>>()
  let generation = 0
  const clear = () => { generation++; entries.clear(); pending.clear() }

  const cachedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const table = url.pathname.match(/^\/rest\/v1\/(wallets|categories|profiles)$/)?.[1]
    const authorization = request.headers.get('authorization')
    // Wallet balances and status-dependent permissions are deliberately not cached.
    const referenceRead = request.method === 'GET' && authorization && table &&
      (table !== 'wallets' || url.searchParams.get('select') === 'id,display_name')
    if (!referenceRead) {
      const writes = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !url.pathname.endsWith('/record_app_usage')
      if (writes) clear()
      try { return await network(input, init) }
      finally { if (writes) clear() }
    }
    const key = `${authorization}:${request.headers.get('accept')}:${request.headers.get('range')}:${request.url}`
    const entry = entries.get(key)
    if (entry && entry.expires > now()) return entry.response.clone()
    entries.delete(key)
    const existing = pending.get(key)
    if (existing) return (await existing).clone()
    const started = generation
    const promise = network(input, init).then(response => {
      if (response.ok && generation === started) {
        // Bound memory even for many distinct pagination/filter combinations.
        if (entries.size >= 100) entries.delete(entries.keys().next().value!)
        entries.set(key, { expires: now() + 60_000, response: response.clone() })
      }
      return response
    })
    pending.set(key, promise)
    try { return (await promise).clone() }
    finally { if (pending.get(key) === promise) pending.delete(key) }
  }
  return { fetch: cachedFetch, clear }
}

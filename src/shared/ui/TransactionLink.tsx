import { Link, useLocation, type LinkProps } from 'react-router-dom'

/** Keep the current route mounted while the quick-entry sheet is open. */
export function TransactionLink(props: LinkProps) {
  const location = useLocation()
  return <Link {...props} state={{ backgroundLocation: location }} />
}

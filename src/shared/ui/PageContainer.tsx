import type { HTMLAttributes, ReactNode } from 'react'

type PageContainerProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
}

/** Shared responsive content width for every routed screen. */
export function PageContainer({
  className = '',
  children,
  ...props
}: PageContainerProps) {
  return (
    <div className={`page-container ${className}`.trim()} {...props}>
      {children}
    </div>
  )
}

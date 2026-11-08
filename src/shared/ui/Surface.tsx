import type { ElementType, HTMLAttributes, ReactNode } from 'react'

type SurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType
  children: ReactNode
}

/** Opaque, readable content surface; do not use this for navigation chrome. */
export function Surface({
  as: Component = 'div',
  className = '',
  children,
  ...props
}: SurfaceProps) {
  return (
    <Component className={`content-surface ${className}`.trim()} {...props}>
      {children}
    </Component>
  )
}

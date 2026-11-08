import type { ElementType, HTMLAttributes, ReactNode } from 'react'

type GlassSurfaceProps = HTMLAttributes<HTMLElement> & {
  as: ElementType
  children: ReactNode
}

/** Translucent material for functional chrome such as navigation and overlays. */
export function GlassSurface({
  as: Component,
  className = '',
  children,
  ...props
}: GlassSurfaceProps) {
  return (
    <Component className={`glass-surface ${className}`.trim()} {...props}>
      {children}
    </Component>
  )
}

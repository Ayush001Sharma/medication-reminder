import type { HTMLAttributes } from 'react'
import { cx } from '../../lib/cx'

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article'
  padded?: boolean
}

/** White, rounded, softly shadowed. Secondary (muted) text is only allowed on surfaces like this one. */
export function Card({ as: Tag = 'div', padded = true, className, ...rest }: CardProps) {
  return (
    <Tag
      className={cx('rounded-2xl border border-line bg-surface shadow-soft', padded && 'p-6', className)}
      {...rest}
    />
  )
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cx('font-display text-xl font-semibold text-ink', className)} {...rest} />
}

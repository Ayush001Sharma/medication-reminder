import type { HTMLAttributes } from 'react'
import { cx } from '../../lib/cx'

/**
 * Secondary text. The muted colour is 4.75:1 on white but only 4.44:1 on the cream page and 4.13:1 on the
 * subtle fill, so this belongs INSIDE a Card (or another white surface), never directly on the page.
 */
export function Hint({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('text-sm text-muted', className)} {...rest} />
}

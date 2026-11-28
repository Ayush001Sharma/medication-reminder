import { Link, type LinkProps } from 'react-router-dom'
import { cx } from '../../lib/cx'
import { buttonClasses, type ButtonSize, type ButtonVariant } from './styles'

/** A router link that looks like a Button (navigation is a link, an action is a button). */
export function ButtonLink({
  variant,
  size,
  fullWidth,
  className,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean }) {
  return <Link className={cx(buttonClasses({ variant, size, fullWidth }), className)} {...rest} />
}

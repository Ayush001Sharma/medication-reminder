import { cx } from '../../lib/cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'lg'

const base =
  'inline-flex select-none items-center justify-center gap-2 rounded-2xl font-semibold ' +
  'transition duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60 ' +
  'motion-safe:active:scale-[0.97] motion-safe:disabled:active:scale-100'

/*
 * Filled buttons use sage-dark + white text (6.0:1). The brand sage itself is only 3.6:1 against white, so it
 * cannot carry button text at AA; sage is used for borders, accents and charts instead.
 */
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-sage-dark text-surface shadow-soft hover:bg-ink active:bg-ink',
  secondary: 'border border-sage-dark bg-surface text-sage-dark hover:bg-sage-tint active:bg-sage-tint',
  ghost: 'bg-transparent text-sage-dark hover:bg-sage-tint active:bg-sage-tint',
  danger: 'bg-danger text-surface shadow-soft hover:bg-ink active:bg-ink',
}

const sizes: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 text-sm',
  lg: 'min-h-12 px-6 text-base',
}

export function buttonClasses(options: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean } = {}) {
  const { variant = 'primary', size = 'lg', fullWidth } = options
  return cx(base, variants[variant], sizes[size], fullWidth && 'w-full')
}

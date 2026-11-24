import type { ReactNode } from 'react'
import { Logo } from '../components/layout/Logo'

/** The centred layout shared by the sign-in and register pages. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-cream px-4 py-10 text-ink sm:justify-center">
      <header className="mb-8">
        <Logo />
      </header>
      <main className="w-full max-w-md animate-rise rounded-2xl border border-line bg-surface p-6 shadow-soft sm:p-8">
        <h1 className="font-display text-3xl font-semibold text-ink">{title}</h1>
        <p className="mb-6 mt-2 text-base text-muted">{subtitle}</p>
        {children}
      </main>
    </div>
  )
}

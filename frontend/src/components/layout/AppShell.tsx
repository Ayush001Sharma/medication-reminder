import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { cx } from '../../lib/cx'
import { NavIcon } from './icons'
import { Logo } from './Logo'
import { navFor } from './navigation'
import { UserMenu } from './UserMenu'

/**
 * The frame around every signed-in page: a top bar (logo, navigation for this role, user menu) and, on
 * small screens, a bottom tab bar within thumb reach. Exactly one of the two navigations is visible.
 */
export function AppShell() {
  const { user } = useAuth()
  const items = user ? navFor(user.role) : []

  return (
    <div className="min-h-dvh bg-cream text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:font-semibold focus:text-sage-dark focus:shadow-lift"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-8">
            <Logo />
            <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cx(
                      'flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold transition duration-150',
                      isActive ? 'bg-sage-tint text-sage-dark' : 'text-ink hover:bg-subtle',
                    )
                  }
                >
                  <NavIcon name={item.icon} className="h-5 w-5" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <UserMenu />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 pb-28 pt-8 focus:outline-none md:pb-12 md:pt-10">
        <Outlet />
      </main>

      <nav
        aria-label="Main (mobile)"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-lift md:hidden"
      >
        <ul className="mx-auto flex max-w-md">
          {items.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cx(
                    'mx-1 my-1.5 flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-xs font-semibold transition duration-150',
                    isActive ? 'bg-sage-tint text-sage-dark' : 'text-ink hover:bg-subtle',
                  )
                }
              >
                <NavIcon name={item.icon} className="h-6 w-6" />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}

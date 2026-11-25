import { Illustration } from '../components/landing/Illustration'
import { Logo } from '../components/layout/Logo'
import { ButtonLink } from '../components/ui/ButtonLink'
import { usePageTitle } from '../hooks/usePageTitle'

const FEATURES = [
  {
    title: 'Reminders on your clock',
    text: 'Set your times once, in your own timezone. They stay right when the clocks change, and each reminder arrives once.',
  },
  {
    title: 'A calm view of your day',
    text: 'See what is due, tick off what you took, and look back at how the week went, without charts shouting at you.',
  },
  {
    title: 'Sharing on your terms',
    text: 'Invite a caregiver or doctor to see your adherence report. You can take that access back at any time.',
  },
]

/** The page people see before they sign in: what the app is, and two clear ways in. */
export function LandingPage() {
  usePageTitle('')
  return (
    <div className="min-h-dvh bg-cream text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-2">
          <ButtonLink to="/login" variant="ghost" size="md">
            Sign in
          </ButtonLink>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-4 pb-16 pt-6 md:pt-12">
        <section className="grid items-center gap-10 md:grid-cols-2 md:gap-14" aria-labelledby="hero-title">
          <div className="animate-rise">
            <h1 id="hero-title" className="font-display text-4xl font-semibold text-ink md:text-5xl">
              Gentle reminders for the medicine that matters.
            </h1>
            <p className="mt-5 max-w-prose text-lg text-ink">
              MedReminder tells you when it is time for each dose, keeps a quiet record of what you have taken, and, only if you choose,
              lets someone who cares for you see how things are going.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/register">Create your account</ButtonLink>
              <ButtonLink to="/login" variant="secondary">
                Sign in
              </ButtonLink>
            </div>
          </div>
          <Illustration className="mx-auto w-full max-w-md animate-fade-in md:max-w-none" />
        </section>

        <section aria-labelledby="how-title" className="mt-16 md:mt-24">
          <h2 id="how-title" className="font-display text-2xl font-semibold text-ink md:text-3xl">
            Made to feel easy
          </h2>
          <ul className="mt-6 grid gap-4 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="rounded-2xl border border-line bg-surface p-6 shadow-soft">
                <h3 className="font-display text-xl font-semibold text-ink">{feature.title}</h3>
                <p className="mt-2 text-base text-muted">{feature.text}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <p className="mx-auto max-w-5xl px-4 py-6 text-sm text-ink">
          MedReminder helps you remember and keep track. It does not give medical advice: always follow what your doctor or pharmacist tells you.
        </p>
      </footer>
    </div>
  )
}

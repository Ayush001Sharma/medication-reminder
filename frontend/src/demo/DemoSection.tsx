import { lazy, Suspense } from 'react'

/*
 * The ONLY place demo mode is switched on. `import.meta.env.VITE_DEMO_MODE` is replaced with a literal when the
 * app is built, so without VITE_DEMO_MODE=true this whole expression folds to `null`, the dynamic import()
 * disappears and the demo code (and the demo password inside it) is not in the build at all.
 * src/demo/demoStripped.test.ts builds the app both ways and checks this.
 */
const DemoLogin = import.meta.env.VITE_DEMO_MODE === 'true' ? lazy(() => import('./DemoLogin')) : null

export function DemoSection() {
  if (!DemoLogin) return null
  return (
    <Suspense fallback={null}>
      <DemoLogin />
    </Suspense>
  )
}

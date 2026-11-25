/**
 * "Never show demo mode in a build where the variable is not set", proven on real production builds: the app is
 * built twice into temporary folders and the output is searched. Without VITE_DEMO_MODE=true the demo labels, the
 * demo emails and the demo password must not be anywhere in the JavaScript, even when the VITE_DEMO_* values
 * ARE set in the environment (as they are after copying .env.example).
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'

const work = mkdtempSync(join(tmpdir(), 'medreminder-demo-'))
const emptyEnvDir = join(work, 'env') // so a developer's own .env.local cannot change the result
mkdirSync(emptyEnvDir)
afterAll(() => rmSync(work, { recursive: true, force: true }))

const DEMO_VALUES = {
  VITE_DEMO_PASSWORD: 'unit-test-demo-password',
  VITE_DEMO_PATIENT_KOLKATA_EMAIL: 'kolkata.test@example.com',
  VITE_DEMO_PATIENT_NEW_YORK_EMAIL: 'newyork.test@example.com',
  VITE_DEMO_CAREGIVER_EMAIL: 'caregiver.test@example.com',
  VITE_DEMO_DOCTOR_EMAIL: 'doctor.test@example.com',
}

async function buildWith(name: string, demoMode: string | undefined): Promise<string> {
  const outDir = join(work, name)
  const saved = { ...process.env }
  Object.assign(process.env, DEMO_VALUES)
  if (demoMode === undefined) delete process.env.VITE_DEMO_MODE
  else process.env.VITE_DEMO_MODE = demoMode
  try {
    await build({ mode: 'production', logLevel: 'silent', envDir: emptyEnvDir, build: { outDir, emptyOutDir: true } })
  } finally {
    for (const key of [...Object.keys(DEMO_VALUES), 'VITE_DEMO_MODE']) {
      if (key in saved) process.env[key] = saved[key]
      else delete process.env[key]
    }
  }
  return everything(outDir)
}

function everything(dir: string): string {
  return readdirSync(dir)
    .map((entry) => {
      const path = join(dir, entry)
      return statSync(path).isDirectory() ? everything(path) : /\.(js|css|html)$/.test(entry) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

const MARKERS = ['Try as patient', 'Try as caregiver', 'Demo mode', 'unit-test-demo-password', 'kolkata.test@example.com', 'doctor.test@example.com', 'demo-password-123', 'demo.asha@example.com']

describe('demo mode in production builds', () => {
  it.each([
    ['unset', undefined],
    ['"false"', 'false'],
    ['"TRUE" (only the exact word "true" counts)', 'TRUE'],
    ['"1"', '1'],
  ] as const)('is completely absent when VITE_DEMO_MODE is %s', async (_label, value) => {
    const output = await buildWith(`off-${String(value)}`, value)
    expect(output.length).toBeGreaterThan(50_000) // really built the app
    for (const marker of MARKERS) expect(output, marker).not.toContain(marker)
  }, 120_000)

  it('is present when VITE_DEMO_MODE is "true" (so the check above can fail)', async () => {
    const output = await buildWith('on', 'true')
    for (const marker of ['Try as patient (Kolkata)', 'Try as patient (New York)', 'Try as caregiver', 'Try as doctor', 'unit-test-demo-password', 'kolkata.test@example.com']) {
      expect(output, marker).toContain(marker)
    }
  }, 120_000)
})

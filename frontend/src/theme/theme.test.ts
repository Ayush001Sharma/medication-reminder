/**
 * Guards the design system from the SOURCE: the palette, WCAG contrast of every pair the components use, and
 * rules such as "no default Tailwind colours", "no localStorage" and "no CDN". If you change a colour or add
 * a component and one of these fails, that is the point.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// `npm test` runs from the frontend folder, so the working directory is the project root.
const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const css = readFileSync(join(SRC, 'index.css'), 'utf8')

const tokens: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()]),
)

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(foreground: string, background: string): number {
  const [a, b] = [luminance(tokens[foreground] as string), luminance(tokens[background] as string)].sort((x, y) => y - x)
  return ((a as number) + 0.05) / ((b as number) + 0.05)
}

describe('palette', () => {
  it('has exactly the specified tokens and values', () => {
    expect(tokens).toEqual({
      cream: '#faf7f0',
      surface: '#ffffff',
      subtle: '#f3efe4',
      sage: '#6b8f71',
      'sage-dark': '#4a6b50',
      'sage-tint': '#e4ede3',
      ink: '#2b2f2a',
      muted: '#6e756c',
      line: '#e6e1d6',
      clay: '#c98b6b',
      danger: '#b5483f',
    })
  })

  it('removes the default Tailwind palette so only the tokens exist', () => {
    expect(css).toContain('--color-*: initial;')
    expect(css).toContain('--shadow-*: initial;')
  })

  it('self-hosts the two typefaces', () => {
    expect(css).toContain('"DM Sans"')
    expect(css).toContain('"Fraunces"')
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    expect(main).toMatch(/@fontsource\/dm-sans\/\d+\.css/)
    expect(main).toMatch(/@fontsource\/fraunces\/\d+\.css/)
  })
})

describe('WCAG AA contrast of every text/background pair the components use (4.5:1)', () => {
  const textPairs: Array<[string, string]> = [
    ['ink', 'cream'], ['ink', 'surface'], ['ink', 'subtle'], ['ink', 'sage-tint'], ['ink', 'clay'],
    ['muted', 'surface'],
    ['sage-dark', 'cream'], ['sage-dark', 'surface'], ['sage-dark', 'subtle'], ['sage-dark', 'sage-tint'],
    ['surface', 'sage-dark'], ['surface', 'danger'],
    ['danger', 'cream'], ['danger', 'surface'],
  ]
  it.each(textPairs)('%s text on %s', (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('non-text contrast (3:1) for control borders and focus rings', () => {
  it.each([['sage', 'surface'], ['sage', 'cream'], ['sage-dark', 'cream'], ['sage-dark', 'surface'], ['danger', 'surface']])(
    '%s against %s',
    (foreground, background) => {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3)
    },
  )
})

describe('pairs that are NOT AA for text (so the rules below forbid them)', () => {
  it.each([['muted', 'cream'], ['muted', 'subtle'], ['muted', 'sage-tint'], ['surface', 'sage'], ['ink', 'sage'], ['clay', 'surface'], ['surface', 'clay']])(
    '%s on %s stays below 4.5:1',
    (foreground, background) => {
      expect(contrast(foreground, background)).toBeLessThan(4.5)
    },
  )
})

// --- source scans ----------------------------------------------------------------------------------
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !path.includes(`${join('src', 'test')}`) ? [path] : []
  })
}
const files = sourceFiles(SRC).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))

describe('source rules', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('uses no default Tailwind colour utilities (blue-500, gray-100, white, black...)', () => {
    const palette = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
    const numbered = new RegExp(`\\b[a-z-:]*(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|accent|shadow|decoration)-(?:${palette})-\\d{2,3}\\b`)
    const plain = /\b(?:bg|text|border|ring|fill|stroke|divide|outline)-(?:white|black)\b/
    for (const file of files) {
      expect(file.text, `${file.path}: default palette colour`).not.toMatch(numbered)
      expect(file.text, `${file.path}: white/black are not tokens (use surface/ink)`).not.toMatch(plain)
    }
  })

  it('has no hard-coded colours or arbitrary colour values in components', () => {
    for (const file of files) {
      expect(file.text, `${file.path}: hex colour`).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/)
      expect(file.text, `${file.path}: arbitrary colour`).not.toMatch(/-\[(?:#|rgb|hsl|oklch)/)
    }
  })

  it('never uses clay or the brand sage as a TEXT colour (both are under 4.5:1 on light backgrounds)', () => {
    for (const file of files) {
      expect(file.text, file.path).not.toMatch(/\btext-(?:clay|sage)(?![-\w])/)
    }
  })

  it('uses the muted text colour only in files whose text sits on a white surface', () => {
    // Each of these renders muted text inside a white card, white input or white menu, never on cream.
    const allowed = [
      join('src', 'components', 'ui', 'Hint.tsx'),
      join('src', 'components', 'ui', 'Input.tsx'), // placeholder inside the white input
      join('src', 'components', 'ui', 'Textarea.tsx'), // placeholder inside the white textarea
      join('src', 'components', 'ui', 'Combobox.tsx'), // placeholder and option detail inside the white field and list
      join('src', 'components', 'ui', 'EmptyState.tsx'), // white panel
      join('src', 'components', 'layout', 'UserMenu.tsx'), // white dropdown
      join('src', 'pages', 'AuthLayout.tsx'), // white card
    ]
    const using = files.filter((f) => /\btext-muted\b|placeholder:text-muted/.test(f.text)).map((f) => f.path)
    expect(using.filter((path) => !allowed.includes(path))).toEqual([])
  })

  it('never references localStorage (tokens live in memory and sessionStorage only)', () => {
    // Comments are stripped first, so a comment that explains WHY it is not used is fine, but any code
    // reference at all (window.localStorage, globalThis.localStorage, ['localStorage']...) fails.
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const file of files) expect(withoutComments(file.text), file.path).not.toMatch(/localStorage/)
  })

  it('loads nothing from a CDN: no external URLs in the HTML shell or source', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    expect(html).not.toMatch(/https?:\/\//)
    for (const file of files) expect(file.text, file.path).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/)
  })

  it('does not put secrets or tokens in the VITE_ environment file', () => {
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const variables = [...env.matchAll(/^(?!#)\s*([A-Z_]+)=/gm)].map((m) => m[1])
    expect(variables).toEqual(['VITE_API_BASE_URL'])
  })
})

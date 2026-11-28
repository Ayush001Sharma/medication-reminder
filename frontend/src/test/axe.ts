import axe from 'axe-core'

/**
 * Run axe-core on rendered markup and fail on any accessibility violation (names, labels, roles, ARIA use...).
 * Two rules are skipped because jsdom cannot evaluate them: colour contrast (it has no real layout or styles;
 * contrast is verified from the design tokens in theme.test.ts and in a real browser) and "region" (a lone
 * component has no page landmarks).
 */
export async function expectNoA11yViolations(container: Element) {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
  expect(summary).toEqual([])
}

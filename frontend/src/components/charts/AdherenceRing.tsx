import { Pie, PieChart } from 'recharts'

/**
 * A donut showing adherence. Fixed size (no ResponsiveContainer) so it also renders in tests. Colours come
 * from the theme variables. The number in the middle is real text and the wrapper has a text alternative,
 * so the chart is never the only carrier of the information.
 */
export function AdherenceRing({ percent, size = 168 }: { percent: number | null; size?: number }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const data = [
    { name: 'Taken', value, fill: 'var(--color-sage)' },
    { name: 'Remaining', value: 100 - value, fill: 'var(--color-subtle)' },
  ]
  const label = percent === null ? 'Adherence is not available yet' : `Adherence ${Math.round(value)} percent`
  return (
    <div role="img" aria-label={label} className="relative shrink-0" style={{ width: size, height: size }}>
      <PieChart width={size} height={size} accessibilityLayer={false}>
        <Pie
          data={data}
          dataKey="value"
          startAngle={90}
          endAngle={-270}
          innerRadius={size * 0.36}
          outerRadius={size * 0.5}
          stroke="none"
          isAnimationActive={false}
        />
      </PieChart>
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span className="font-display text-3xl font-semibold text-ink">
          {percent === null ? '–' : `${Math.round(value)}%`}
        </span>
      </div>
    </div>
  )
}

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { MedicationAdherence } from '../../api/types'
import { useElementWidth } from '../../hooks/useElementWidth'
import { shortLabel } from '../../lib/report'

const ROW_HEIGHT = 44

/**
 * Adherence per medication as horizontal sage bars on a pale track, 0 to 100 percent. Medications with no
 * percentage (nothing taken or missed yet) are left out of the chart; the list under it still names them.
 * The wrapper has a text alternative and the numbers are repeated as text by the caller, so the chart is never
 * the only carrier of the information.
 */
export function MedicationBars({ medications }: { medications: MedicationAdherence[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const rows = medications
    .filter((m) => m.adherence_percent !== null)
    .map((m) => ({ id: m.medication_id, name: shortLabel(m.name), percent: Math.round(m.adherence_percent ?? 0) }))
  if (rows.length === 0) return null
  const height = rows.length * ROW_HEIGHT + 40
  const label = `Adherence per medication: ${rows.map((r) => `${r.name} ${r.percent} percent`).join(', ')}`
  return (
    <div ref={ref} role="img" aria-label={label} className="w-full">
      <BarChart
        width={width}
        height={height}
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
        barCategoryGap={10}
        accessibilityLayer={false}
      >
        <CartesianGrid horizontal={false} stroke="var(--color-line)" />
        <XAxis
          type="number"
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tickFormatter={(value: number) => `${value}%`}
          tick={{ fill: 'var(--color-ink)', fontSize: 12 }}
          stroke="var(--color-sage)"
        />
        <YAxis
          type="category"
          dataKey="name"
          width={Math.min(130, Math.max(80, width * 0.32))}
          tick={{ fill: 'var(--color-ink)', fontSize: 13 }}
          stroke="var(--color-sage)"
        />
        <Bar
          dataKey="percent"
          fill="var(--color-sage)"
          background={{ fill: 'var(--color-subtle)', radius: 8 }}
          radius={8}
          maxBarSize={24}
          isAnimationActive={false}
        />
      </BarChart>
    </div>
  )
}

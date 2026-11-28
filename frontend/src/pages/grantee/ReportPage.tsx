import { lazy, Suspense } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../../api/client'
import type { AdherenceReport, MedicationAdherence } from '../../api/types'
import { RangePicker } from '../../components/access/RangePicker'
import { NavIcon } from '../../components/layout/icons'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card, CardTitle } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Hint } from '../../components/ui/Hint'
import { InfoTip } from '../../components/ui/InfoTip'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, Skeleton } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { usePageTitle } from '../../hooks/usePageTitle'
import { isIsoDate, shortDate } from '../../lib/dates'
import { ADHERENCE_DEFINITION, isNoAccess, isPatientId } from '../../lib/report'

// Recharts is large; it loads only when a report with data is shown.
const AdherenceRing = lazy(() => import('../../components/charts/AdherenceRing').then((m) => ({ default: m.AdherenceRing })))
const MedicationBars = lazy(() => import('../../components/charts/MedicationBars').then((m) => ({ default: m.MedicationBars })))

function NoAccess() {
  return (
    <EmptyState
      icon={<NavIcon name="patients" className="h-7 w-7" />}
      title="This report isn't available"
      description="You may no longer have access to this patient's reports (a patient can stop sharing at any time), or the link may be wrong."
      action={<ButtonLink to="/patients">Back to your patients</ButtonLink>}
    />
  )
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
      <dt className="text-sm font-semibold text-ink">{label}</dt>
      <dd className="mt-1">
        <span className="font-display text-3xl font-semibold text-ink">{value}</span>
        {note && <Hint className="mt-1">{note}</Hint>}
      </dd>
    </div>
  )
}

function MedicationList({ medications }: { medications: MedicationAdherence[] }) {
  return (
    <ul aria-label="Adherence by medication" className="mt-4 divide-y divide-line">
      {medications.map((m) => (
        <li key={m.medication_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
          <span className="text-base text-ink">
            <span className="font-semibold">{m.name}</span> {m.dosage}
          </span>
          <span className="text-sm text-ink">
            {m.adherence_percent === null ? 'Not enough data' : `${Math.round(m.adherence_percent)}%`} · {m.taken} taken, {m.missed} missed, {m.skipped} skipped
          </span>
        </li>
      ))}
    </ul>
  )
}

function ReportBody({ report }: { report: AdherenceReport }) {
  const { totals } = report
  const medications = report.medications ?? []
  if (totals.total === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="activity" className="h-7 w-7" />}
        title="No doses to report for these dates"
        description="Nothing was taken, missed or skipped in this period. Try a wider range."
      />
    )
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <Card as="section" aria-labelledby="adherence-title" className="flex flex-col items-center gap-2 text-center md:min-w-72">
          <div className="flex items-center gap-1">
            <CardTitle id="adherence-title">Adherence</CardTitle>
            <InfoTip label="How adherence is calculated">{ADHERENCE_DEFINITION}</InfoTip>
          </div>
          <Suspense fallback={<Skeleton className="h-52 w-52 rounded-full" />}>
            <AdherenceRing percent={totals.adherence_percent} size={208} />
          </Suspense>
          {totals.adherence_percent === null && (
            <p className="max-w-xs text-base text-ink">
              There is no percentage yet. It needs at least one taken or missed dose in this period, and skipped doses are not counted.
            </p>
          )}
        </Card>
        <section aria-label="Dose counts" className="space-y-4">
          <dl className="grid grid-cols-2 gap-4">
            <Stat label="Taken" value={totals.taken} />
            <Stat label="Missed" value={totals.missed} />
            <Stat label="Skipped" value={totals.skipped} />
            <Stat label="Taken late" value={totals.taken_late} note="Also counted as taken" />
          </dl>
          <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
            <p className="text-sm font-semibold text-ink">Current streak</p>
            <p className="mt-1 text-base text-ink">
              <span className="font-display text-3xl font-semibold">{report.current_streak}</span>{' '}
              {report.current_streak === 1 ? 'dose' : 'doses'} taken in a row
            </p>
          </div>
        </section>
      </div>

      {medications.length > 0 && (
        <Card as="section" aria-labelledby="by-medication-title">
          <CardTitle id="by-medication-title" className="mb-4">
            By medication
          </CardTitle>
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <MedicationBars medications={medications} />
          </Suspense>
          <MedicationList medications={medications} />
        </Card>
      )}
    </div>
  )
}

function ReportSkeleton() {
  return (
    <LoadingRegion label="Loading the report">
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <Skeleton className="h-72 w-full rounded-2xl md:w-72" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-6 h-56 w-full rounded-2xl" />
    </LoadingRegion>
  )
}

/**
 * One patient's adherence report for a caregiver or doctor. The date range lives in the address (?from=&to=),
 * so it survives a reload and the back button. Without it the API gives the last 30 days in the patient's
 * own timezone. A missing or revoked patient is shown as a calm message, never an error screen.
 */
export function ReportPage() {
  const { patientId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const fromParam = params.get('from') ?? ''
  const toParam = params.get('to') ?? ''
  const custom = isIsoDate(fromParam) && isIsoDate(toParam)
  const validId = isPatientId(patientId)

  const report = useAsync(
    (signal) => {
      if (!validId) return Promise.reject(new ApiError(404, 'Not found'))
      return api.get<AdherenceReport>('/api/reports/adherence/', {
        signal,
        query: { patient: patientId, from: custom ? fromParam : undefined, to: custom ? toParam : undefined },
      })
    },
    `${patientId}|${custom ? fromParam : ''}|${custom ? toParam : ''}`,
  )

  // The picker shows the dates in the address; for the default view it waits for the API to say which they are.
  const shown = custom ? { from: fromParam, to: toParam } : report.status === 'success' ? report.data.range : null
  const noAccess = report.status === 'error' && isNoAccess(report.error)
  const rangeError =
    report.status === 'error' && !noAccess && report.error instanceof ApiError && report.error.status === 400 ? report.error.message : undefined

  const patientName = report.status === 'success' ? report.data.patient?.full_name : undefined
  usePageTitle(noAccess ? 'Report not available' : patientName ? `Report for ${patientName}` : 'Adherence report')
  const description =
    report.status === 'success'
      ? `${patientName ? `${patientName} · ` : ''}${shortDate(report.data.range.from)} to ${shortDate(report.data.range.to)} (${report.data.range.timezone.replaceAll('_', ' ')})`
      : 'Taken doses compared with missed ones, for the dates you choose.'

  return (
    <>
      <div className="mb-2">
        <ButtonLink variant="ghost" size="md" to="/patients" className="-ml-4">
          ← All patients
        </ButtonLink>
      </div>
      <PageHeader title="Adherence report" description={description} />

      {!noAccess && (
        <RangePicker
          key={shown ? `${shown.from}|${shown.to}` : 'loading'}
          from={shown?.from ?? ''}
          to={shown?.to ?? ''}
          disabled={shown === null}
          serverError={rangeError}
          onApply={(from, to) => setParams({ from, to })}
          onReset={() => setParams({})}
        />
      )}

      {report.status === 'loading' && <ReportSkeleton />}
      {noAccess && <NoAccess />}
      {report.status === 'error' && !noAccess && (
        <Card>
          <p className="mb-4 text-base text-ink">{rangeError ? 'Those dates could not be used. Please adjust them and try again.' : 'We could not load this report.'}</p>
          {!rangeError && (
            <Button variant="secondary" onClick={report.reload}>
              Try again
            </Button>
          )}
        </Card>
      )}
      {report.status === 'success' && (
        <div aria-busy={report.refreshing || undefined} className={report.refreshing ? 'opacity-60 transition-opacity' : undefined}>
          <ReportBody report={report.data} />
        </div>
      )}
    </>
  )
}

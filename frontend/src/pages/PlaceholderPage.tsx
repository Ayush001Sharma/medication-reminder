import { NavIcon, type IconName } from '../components/layout/icons'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'

/** A routed page that is not built yet. It keeps the navigation honest and shows the empty-state pattern. */
export function PlaceholderPage({ title, icon, description }: { title: string; icon: IconName; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={<NavIcon name={icon} className="h-7 w-7" />} title="Coming soon" description={description} />
    </>
  )
}

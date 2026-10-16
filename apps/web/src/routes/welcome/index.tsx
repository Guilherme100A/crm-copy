// `/welcome` (spec 02 §2; permissão dashboard.sales ou dashboard.support): dashboard com filtros na URL (T78).
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { DashboardPage } from '@/features/dashboard/dashboard-page'
import { dashboardSearchSchema, type DashboardSearch } from '@/features/dashboard/search'

export const Route = createFileRoute('/welcome/')({
  validateSearch: dashboardSearchSchema,
  component: WelcomeRoute,
})

function WelcomeRoute() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const onSearch = (next: DashboardSearch) => void navigate({ search: next, replace: true })
  return <DashboardPage search={search} onSearch={onSearch} />
}

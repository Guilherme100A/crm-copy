// Admin interno da plataforma (T100; 20-admin-interno.md §2): `/admin?tab=`, só para platform_admin (guard em
// `app/access.ts`). `tab` é string livre (o nome já existe com outros tipos em outras rotas): validado no componente.
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AdminPage } from '@/features/admin/admin-page'

export const Route = createFileRoute('/admin/')({
  validateSearch: z.object({ tab: z.string().optional().catch(undefined) }),
  component: AdminRoute,
})

function AdminRoute() {
  const { tab } = Route.useSearch()
  return <AdminPage tab={tab} />
}

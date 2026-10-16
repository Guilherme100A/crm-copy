// `/settings/inbound-webhooks/$webhookId/edit`: abas Configuração e Histórico (T89).
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { editSearchSchema, WebhookEditPage, type EditSearch } from '@/features/settings-webhooks/edit-page'

export const Route = createFileRoute('/settings/inbound-webhooks/$webhookId/edit')({
  validateSearch: editSearchSchema,
  component: WebhookEditRoute,
})

function WebhookEditRoute() {
  const { webhookId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const onSearch = (next: EditSearch) => void navigate({ search: next, replace: true })
  return <WebhookEditPage key={webhookId} webhookId={webhookId} search={search} onSearch={onSearch} />
}

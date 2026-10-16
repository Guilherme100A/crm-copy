// `/settings/inbound-webhooks/`: lista de webhooks de entrada (T89).
import { createFileRoute } from '@tanstack/react-router'
import { WebhooksListPage } from '@/features/settings-webhooks/list-page'

export const Route = createFileRoute('/settings/inbound-webhooks/')({
  component: WebhooksListPage,
})

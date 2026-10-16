// `/settings/inbound-webhooks/new`: criar webhook ("Salvar e continuar" leva à edição) (T89).
import { createFileRoute } from '@tanstack/react-router'
import { WebhookNewPage } from '@/features/settings-webhooks/webhook-form'

export const Route = createFileRoute('/settings/inbound-webhooks/new')({
  component: WebhookNewPage,
})

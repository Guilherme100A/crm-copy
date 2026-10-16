// `/settings/inbound-webhooks` (spec 18; permissão webhooks.view): layout das telas de webhooks de entrada (T89).
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { registerWebhookSamplesRealtime } from '@/features/settings-webhooks/realtime'

// Handler do SSE registrado junto com a árvore de rotas (antes de o shell abrir a conexão).
registerWebhookSamplesRealtime()

export const Route = createFileRoute('/settings/inbound-webhooks')({
  component: Outlet,
})

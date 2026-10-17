// `/oauth/consent?request=<id>` (T115): consentimento do OAuth MCP. Exige sessão (o guard leva ao login com retorno).
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ConsentPage } from '@/features/mcp-oauth/consent-page'

export const Route = createFileRoute('/oauth/consent')({
  validateSearch: z.object({ request: z.string().optional().catch(undefined) }),
  component: ConsentRoute,
})

function ConsentRoute() {
  const { request } = Route.useSearch()
  return <ConsentPage key={request ?? ''} request={request ?? null} />
}

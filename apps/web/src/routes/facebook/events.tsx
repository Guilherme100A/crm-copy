// Search params com prefixo `ev_` (como os `fb_*` do Gerenciador) para não colidir com os de outras rotas.
// `/facebook/events` (revisão 3; permissão facebook.pixel): "Eventos enviados" — diagnóstico por pixel da Conversions API.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useCallback } from 'react'
import { z } from 'zod'
import { EventsPage, type EventsSearch } from '@/features/facebook/events-page'
import { FacebookLayout } from '@/features/facebook/layout'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'

registerFacebookRealtime()

const searchSchema = z.object({
  ev_pixel: z.string().max(64).optional().catch(undefined),
  ev_page: z.coerce.number().int().min(1).optional().catch(undefined),
  ev_status: z.string().max(32).optional().catch(undefined),
  ev_mode: z.string().max(32).optional().catch(undefined),
  ev_event: z.string().max(64).optional().catch(undefined),
  ev_source: z.string().max(32).optional().catch(undefined),
})

export const Route = createFileRoute('/facebook/events')({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const to = facebookRedirect(context.session, 'events')
    if (to) throw redirect({ to, replace: true } as never)
  },
  component: EventsRoute,
})

function EventsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: EventsSearch) => void navigate({ search: next, replace: true }), [navigate])
  return (
    <FacebookLayout active="events">
      <EventsPage search={search} onSearch={onSearch} />
    </FacebookLayout>
  )
}

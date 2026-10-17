// `/facebook/campaigns` (11 §2.1; permissão facebook.campaigns): Gerenciador de anúncios. Sem a permissão, vai para a
// primeira sub-rota permitida (AC-T106-01). Nível, status, nome e período nos search params `fb_*`.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useCallback } from 'react'
import { CampaignsPage, type CampaignsSearch } from '@/features/facebook/campaigns-page'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'
import { campaignsSearchSchema } from '@/features/facebook/search'

registerFacebookRealtime()

export const Route = createFileRoute('/facebook/campaigns')({
  validateSearch: campaignsSearchSchema,
  beforeLoad: ({ context }) => {
    const to = facebookRedirect(context.session, 'campaigns')
    if (to) throw redirect({ to, replace: true } as never)
  },
  component: CampaignsRoute,
})

function CampaignsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: CampaignsSearch) => void navigate({ search: next, replace: true }), [navigate])
  return <CampaignsPage search={search} onSearch={onSearch} />
}

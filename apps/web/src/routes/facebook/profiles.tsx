// `/facebook/profiles` (11 §2.3; permissão facebook.profiles): perfis Meta e contas de anúncio. Recebe a volta do
// OAuth (`?meta_oauth=&meta_message=`), que a página consome e tira da URL. Sem a permissão, vai para a primeira
// sub-rota permitida (AC-T106-01).
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useCallback } from 'react'
import { FacebookLayout } from '@/features/facebook/layout'
import { ProfilesPage } from '@/features/facebook/profiles-page'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'
import { profilesSearchSchema } from '@/features/facebook/search'

registerFacebookRealtime()

export const Route = createFileRoute('/facebook/profiles')({
  validateSearch: profilesSearchSchema,
  beforeLoad: ({ context }) => {
    const to = facebookRedirect(context.session, 'profiles')
    if (to) throw redirect({ to, replace: true } as never)
  },
  component: ProfilesRoute,
})

function ProfilesRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onClearSearch = useCallback(() => void navigate({ search: {}, replace: true }), [navigate])
  return (
    <FacebookLayout active="profiles">
      <ProfilesPage search={search} onClearSearch={onClearSearch} />
    </FacebookLayout>
  )
}

// `/profile?tab=personal|security|preferences` (protegida, livre para qualquer membro; spec 18 §5.3).
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PROFILE_TABS, ProfilePage } from '@/features/profile/profile-page'

export const Route = createFileRoute('/profile/')({
  validateSearch: z.object({ tab: z.enum(PROFILE_TABS).catch('personal').default('personal') }),
  component: ProfileRoute,
})

function ProfileRoute() {
  const { tab } = Route.useSearch()
  const { session } = Route.useRouteContext()
  // A guarda da raiz garante sessão nas rotas protegidas.
  return session ? <ProfilePage session={session} tab={tab} /> : null
}

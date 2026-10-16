// `/invitations/$token`: convite (aberto com ou sem sessão, sem shell; link enviado pela T22).
import { createFileRoute } from '@tanstack/react-router'
import { InvitationPage } from '@/features/auth/invitation-page'

export const Route = createFileRoute('/invitations/$token')({
  component: InvitationRoute,
})

function InvitationRoute() {
  const { token } = Route.useParams()
  const { session } = Route.useRouteContext()
  return <InvitationPage key={token} token={token} session={session ?? null} />
}

// `/invitation/$token` (URL da spec 01): redireciona para `/invitations/$token`, a tela do convite.
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/invitation/$token')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/invitations/$token', params: { token: params.token }, replace: true })
  },
})

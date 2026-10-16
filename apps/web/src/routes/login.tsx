// `/login` (público, só deslogado). Já autenticado: vai ao `?redirect=` seguro ou à home do papel (spec 18 §2.2).
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { redirectIfAuthenticated } from '@/features/auth/guest'
import { LoginPage } from '@/features/auth/login-page'

const opt = z.string().optional().catch(undefined)

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: opt, message: opt, email: opt }),
  beforeLoad: ({ context, search }) => redirectIfAuthenticated(context, search.redirect),
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect, message, email } = Route.useSearch()
  return <LoginPage redirect={redirect} message={message} email={email} />
}

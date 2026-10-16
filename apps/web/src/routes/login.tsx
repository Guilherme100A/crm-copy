// `/login` (público). Já autenticado: vai para o `?redirect=` seguro ou para a home do papel (spec 18 §2.2).
import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { homeOf } from '@/app/access'
import { splitHref } from '@/app/guard'
import { LoginPage } from '@/features/auth/login-page'
import { safeRedirect } from '@/lib/redirect'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined), message: z.string().optional().catch(undefined) }),
  beforeLoad: ({ context, search }) => {
    const session = (context as { session?: Parameters<typeof homeOf>[0] | null }).session
    if (session) {
      const { to, search: s } = splitHref(safeRedirect(search.redirect, homeOf(session)))
      throw redirect({ to, search: s, replace: true } as never)
    }
  },
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect: target, message } = Route.useSearch()
  return <LoginPage redirect={target} message={message} />
}

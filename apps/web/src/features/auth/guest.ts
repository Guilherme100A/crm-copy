// Guarda "somente deslogado" das telas públicas (spec 01 §2): com sessão, vai para o `?redirect=` seguro ou para a
// home do papel. O convite não usa esta guarda (é aberto com ou sem sessão).
import { redirect } from '@tanstack/react-router'
import { homeOf } from '@/app/access'
import { splitHref } from '@/app/guard'
import { safeRedirect } from '@/lib/redirect'
import type { Session } from '@/lib/session'

export function redirectIfAuthenticated(context: unknown, target?: string): void {
  const session = (context as { session?: Session | null }).session
  if (!session) return
  const { to, search } = splitHref(safeRedirect(target, homeOf(session)))
  throw redirect({ to, search, replace: true } as never)
}

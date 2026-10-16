// Rota raiz: guarda de sessão e permissão em toda navegação (spec 18 §2.2, §5.3), shell para as rotas internas,
// atalho de tema e 404. As rotas de módulo (`routes/<módulo>/**`) herdam tudo daqui.
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { decide, DeniedNotice, isPublicPath, splitHref, takeDeniedNotice } from '@/app/guard'
import { AppShell } from '@/app/shell/app-shell'
import { NotFound } from '@/components/not-found'
import { initialLocale, isLocale, translate, useI18n } from '@/i18n'
import { loadSession, type Session } from '@/lib/session'
import { readStorage, STORAGE_KEYS } from '@/lib/storage'
import { isThemeShortcut, toggleTheme } from '@/lib/theme'
import { notify } from '@/lib/toast'

export interface RouterContext {
  queryClient: QueryClient
}

const denied = new DeniedNotice()

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }): Promise<{ session: Session | null }> => {
    const session = await loadSession(context.queryClient)
    const decision = decide(session, location.pathname, `${location.pathname}${location.searchStr}`)
    if (decision.kind === 'redirect') {
      if (decision.denied && denied.shouldNotify(location.pathname)) {
        notify('shell-permission-denied', translate(initialLocale(session?.user.locale), 'guards.permissionDenied'))
      }
      const { to, search } = splitHref(decision.href)
      throw redirect({ to, search, replace: true } as never)
    }
    return { session }
  },
  component: RootComponent,
  notFoundComponent: NotFound,
})

/** Ctrl/Cmd+M alterna o tema fora de campos de texto (spec 18 §5.1). */
function useThemeShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isThemeShortcut(e)) return
      e.preventDefault()
      toggleTheme()
      window.dispatchEvent(new Event('crm:theme'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Sem idioma salvo no navegador, adota o do perfil. */
function useProfileLocale(session: Session | null) {
  const { locale, setLocale } = useI18n()
  useEffect(() => {
    const profileLocale = session?.user.locale
    if (!readStorage(STORAGE_KEYS.locale) && isLocale(profileLocale) && profileLocale !== locale) setLocale(profileLocale)
  }, [session?.user.locale, locale, setLocale])
}

/** Aviso decidido na carga inicial (antes do router): mostrado uma vez, ao montar. */
function useInitialDeniedNotice(session: Session | null) {
  const locale = session?.user.locale
  useEffect(() => {
    if (takeDeniedNotice()) notify('shell-permission-denied', translate(initialLocale(locale), 'guards.permissionDenied'))
  }, [locale])
}

function RootComponent() {
  const { session } = Route.useRouteContext()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useThemeShortcut()
  useProfileLocale(session)
  useInitialDeniedNotice(session)
  if (isPublicPath(pathname) || !session) return <Outlet />
  return (
    <AppShell session={session}>
      <Outlet />
    </AppShell>
  )
}

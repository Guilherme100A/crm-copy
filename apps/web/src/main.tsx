// Entrada da SPA (STACK D): React 19 + TanStack Router (rotas por arquivo) + TanStack Query, i18n e toasts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { decide, deferDeniedNotice } from './app/guard'
import { ToastProvider } from './components/toaster'
import { I18nProvider } from './i18n'
import { setUnauthorizedHandler } from './lib/http'
import { loginPath } from './lib/redirect'
import { loadSession, profileQueryKey } from './lib/session'
import { applyTheme, currentTheme } from './lib/theme'
import { routeTree } from './routeTree.gen'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
})

function makeRouter() {
  return createRouter({
    routeTree,
    context: { queryClient },
    // Sem isto o cache de preload do Router (30 s) passa por cima do frescor do Query (STACK D §2).
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}

applyTheme(currentTheme())

// Carga inicial: decide o redirecionamento ANTES de criar o router (que grava o estado do histórico ao nascer).
// Assim um caminho negado (ex.: /welcome sem dashboard) é trocado por replaceState e não gera uma segunda
// navegação para ele (AC-T23-05). Navegações seguintes passam pelo guarda da rota raiz.
try {
  const session = await loadSession(queryClient)
  const { pathname, search } = window.location
  const decision = decide(session, pathname, `${pathname}${search}`)
  if (decision.kind === 'redirect') {
    window.history.replaceState(null, '', decision.href)
    if (decision.denied) deferDeniedNotice()
  }
} catch {
  // API fora do ar: o guarda do router decide na navegação
}

const router = makeRouter()

// Sessão acabou (401 confirmado pela sonda única): limpa o cache e vai ao login preservando o caminho.
// O perfil fica marcado "sem sessão" no cache: o guarda do login não refaz a sonda (uma só por 401; AC-T23-06).
setUnauthorizedHandler(() => {
  const { pathname, searchStr } = router.state.location
  queryClient.clear()
  queryClient.setQueryData(profileQueryKey, null)
  void router.navigate({ href: loginPath(`${pathname}${searchStr}`), replace: true })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
)

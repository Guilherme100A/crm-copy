// `/mass-dispatches` (10 §2; permissão contacts.view; T83). O rascunho vindo de Contatos (T77) chega no state do
// router (`massDispatchDraft`) e abre o wizard; depois é retirado do state com `replace`, para não reabrir.
import { createFileRoute, useRouterState, type HistoryState } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { MASS_DISPATCH_DRAFT_KEY } from '@/features/contacts/selection'
import { readDraft } from '@/features/mass-dispatch/logic'
import { MassDispatchPage } from '@/features/mass-dispatch/page'
import { registerMassDispatchRealtime } from '@/features/mass-dispatch/realtime'

// Handler do SSE registrado junto com a árvore de rotas (antes de o shell abrir a conexão).
registerMassDispatchRealtime()

export const Route = createFileRoute('/mass-dispatches/')({
  component: MassDispatchRoute,
})

function MassDispatchRoute() {
  const state = useRouterState({ select: (s) => s.location.state })
  const draft = useMemo(() => readDraft(state, MASS_DISPATCH_DRAFT_KEY), [state])
  const navigate = Route.useNavigate()
  const onDraftConsumed = useCallback(
    () =>
      void navigate({
        to: '.',
        replace: true,
        state: (prev) => {
          const next: Record<string, unknown> = { ...(prev as unknown as Record<string, unknown>) }
          delete next[MASS_DISPATCH_DRAFT_KEY]
          return next as HistoryState
        },
      }),
    [navigate],
  )
  return <MassDispatchPage draft={draft} onDraftConsumed={onDraftConsumed} />
}

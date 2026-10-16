// `/crms` (spec 18; permissão kanban.view): lista de quadros com indicadores (T70).
import { createFileRoute } from '@tanstack/react-router'
import { CrmsListPage } from '@/features/crms/list-page'
import { registerCrmsRealtime } from '@/features/crms/realtime'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerCrmsRealtime()

export const Route = createFileRoute('/crms/')({
  component: CrmsListPage,
})

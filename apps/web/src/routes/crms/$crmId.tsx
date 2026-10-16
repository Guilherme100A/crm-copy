// `/crms/$crmId` (spec 18; permissão kanban.view): quadro kanban arrastável (T70).
import { createFileRoute } from '@tanstack/react-router'
import { CrmBoardPage } from '@/features/crms/board-page'
import { registerCrmsRealtime } from '@/features/crms/realtime'

registerCrmsRealtime()

export const Route = createFileRoute('/crms/$crmId')({
  component: CrmBoardRoute,
})

function CrmBoardRoute() {
  const { crmId } = Route.useParams()
  return <CrmBoardPage key={crmId} crmId={crmId} />
}

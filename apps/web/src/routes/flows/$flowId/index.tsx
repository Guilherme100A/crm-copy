// `/flows/$flowId` (spec 18; permissão flows.view): fluxo em somente leitura (T45).
import { createFileRoute } from '@tanstack/react-router'
import { FlowEditorPage, registerFlowEditorRealtime } from '@/features/flow-editor'

registerFlowEditorRealtime()

export const Route = createFileRoute('/flows/$flowId/')({
  component: FlowViewRoute,
})

function FlowViewRoute() {
  const { flowId } = Route.useParams()
  return <FlowEditorPage key={flowId} flowId={flowId} mode="view" />
}

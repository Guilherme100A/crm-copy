// `/flows/$flowId/edit` (spec 18; permissão flows.view): editor do fluxo; sem flows.edit abre em leitura (T45).
import { createFileRoute } from '@tanstack/react-router'
import { FlowEditorPage, registerFlowEditorRealtime } from '@/features/flow-editor'
import { registerFlowCopilotRealtime } from '@/features/flow-copilot'

registerFlowEditorRealtime()
registerFlowCopilotRealtime()

export const Route = createFileRoute('/flows/$flowId/edit')({
  component: FlowEditRoute,
})

function FlowEditRoute() {
  const { flowId } = Route.useParams()
  return <FlowEditorPage key={flowId} flowId={flowId} mode="edit" />
}

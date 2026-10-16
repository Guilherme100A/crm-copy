// Realtime do editor (06 §7): `flow.graph_updated` de outro ator (outro usuário, assistente, API) recarrega o rascunho do
// fluxo aberto. O handler é registrado no carregamento da rota (antes de o shell abrir o SSE) e repassa o evento a
// quem estiver ouvindo aquele fluxo; os eventos do próprio usuário são ignorados (já estão no canvas).
import { onRealtime } from '@/lib/realtime'

export interface GraphUpdated {
  flow_id: string
  actor_id: string | null
  mutation: string
}

type Listener = (ev: GraphUpdated) => void

const listeners = new Map<string, Set<Listener>>()

export function onGraphUpdated(flowId: string, fn: Listener): () => void {
  let set = listeners.get(flowId)
  if (!set) listeners.set(flowId, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(flowId)
  }
}

export function dispatchGraphUpdated(data: unknown): void {
  const ev = data as Partial<GraphUpdated> | null
  if (!ev || typeof ev.flow_id !== 'string') return
  const full: GraphUpdated = { flow_id: ev.flow_id, actor_id: typeof ev.actor_id === 'string' ? ev.actor_id : null, mutation: String(ev.mutation ?? '') }
  for (const fn of listeners.get(full.flow_id) ?? []) fn(full)
}

/** O evento veio de outra pessoa (token de API sem usuário também conta como outro). */
export const isForeign = (ev: GraphUpdated, me: string | null) => !me || ev.actor_id !== me

let registered = false

export function registerFlowEditorRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('flow.graph_updated', (e) => dispatchGraphUpdated(e.data))
}

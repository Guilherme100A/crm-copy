// Streaming do assistente (T93): `copilot.delta` e `copilot.completed` chegam pelo SSE e são repassados a quem ouve a
// sessão. Os handlers são registrados no carregamento da rota do editor (antes de o shell abrir o SSE; lição T53).
import { onRealtime } from '@/lib/realtime'

export interface CopilotDelta {
  session_id: string
  message_id: string
  kind: 'text' | 'tool'
  delta?: string
  tool?: string
  ok?: boolean
  error?: string
}

export interface CopilotCompleted {
  session_id: string
  message_id: string
  status: 'completed' | 'failed' | 'paused_quota'
  graph_changed: boolean
}

export type CopilotStreamEvent = ({ type: 'delta' } & CopilotDelta) | ({ type: 'completed' } & CopilotCompleted)

type Listener = (ev: CopilotStreamEvent) => void
const listeners = new Map<string, Set<Listener>>()

export function onCopilotStream(sessionId: string, fn: Listener): () => void {
  let set = listeners.get(sessionId)
  if (!set) listeners.set(sessionId, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(sessionId)
  }
}

export function dispatchCopilotStream(type: 'delta' | 'completed', data: unknown): void {
  const d = data as { session_id?: unknown } | null
  if (!d || typeof d.session_id !== 'string') return
  const ev = { type, ...(data as object) } as CopilotStreamEvent
  for (const fn of listeners.get(d.session_id) ?? []) fn(ev)
}

let registered = false

export function registerFlowCopilotRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('copilot.delta', (e) => dispatchCopilotStream('delta', e.data))
  onRealtime('copilot.completed', (e) => dispatchCopilotStream('completed', e.data))
}

/** Resposta em andamento montada pelos deltas. */
export interface StreamingReply {
  messageId: string | null
  text: string
  tools: { tool: string; ok: boolean; error?: string }[]
}

export const emptyStreaming = (): StreamingReply => ({ messageId: null, text: '', tools: [] })

/** Aplica um delta (puro). Delta de outra resposta recomeça o acúmulo. */
export function applyCopilotDelta(state: StreamingReply, d: CopilotDelta): StreamingReply {
  const s = state.messageId && state.messageId !== d.message_id ? emptyStreaming() : state
  if (d.kind === 'text') return { ...s, messageId: d.message_id, text: s.text + (d.delta ?? '') }
  return {
    ...s,
    messageId: d.message_id,
    tools: [...s.tools, { tool: d.tool ?? '', ok: d.ok !== false, ...(d.error ? { error: d.error } : {}) }],
  }
}

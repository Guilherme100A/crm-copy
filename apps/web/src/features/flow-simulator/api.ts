// API do simulador (T82): `POST /api/flows/:id/simulate`. Stateless: para continuar, o cliente reenvia a escolha
// (`resume`), as variáveis e os passos acumulados da resposta anterior.
import { api } from '@/lib/http'

export type SimWaitKind =
  | 'wait_response'
  | 'menu'
  | 'carousel'
  | 'smart_interval'
  | 'condition_choice'
  | 'distributor'
  | 'ai_choice'
  | 'integration_choice'

export type SimMessage = { seq: number; node_key: string; to: 'contact' | 'internal' } & (
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video' | 'audio' | 'sticker'; url: string; caption?: string }
  | { kind: 'document'; url: string; file_name?: string; caption?: string }
  | { kind: 'contact'; name: string }
  | { kind: 'location'; name?: string; latitude: number; longitude: number }
  | { kind: 'react' | 'delete' }
)

export type SimNotice =
  | { code: 'not_simulated'; seq: number; node_key: string; node_type: string }
  | { code: 'jump_flow'; seq: number; node_key: string; target_flow_id: string }

export interface SimChoice {
  handle: string
  label?: string
  connected: boolean
}

export interface SimStep {
  seq: number
  node_key: string
  node_type: string
  status: 'done' | 'failed'
  handle?: string
  error?: string | null
}

export type SimEndReason = 'completed' | 'no_start' | 'no_next' | 'failed' | 'loop_guard' | 'jump_flow'

export interface SimulationResult {
  status: 'waiting' | 'finished'
  steps: SimStep[]
  messages: SimMessage[]
  notices: SimNotice[]
  vars: Record<string, unknown>
  steps_total: number
  wait?: { node_key: string; node_type: string; kind: SimWaitKind; choices: SimChoice[] }
  end?: { reason: SimEndReason; node_key?: string; handle?: string; error?: string }
  interrupted?: 'loop_guard'
}

export interface SimulateBody {
  resume?: { node_key: string; handle: string; text?: string }
  vars?: Record<string, unknown>
  steps_so_far?: number
}

export const simulatorApi = {
  run: async (flowId: string, body: SimulateBody) =>
    (await api.post<{ simulation: SimulationResult }>(`/api/flows/${encodeURIComponent(flowId)}/simulate`, body))
      .simulation,
}

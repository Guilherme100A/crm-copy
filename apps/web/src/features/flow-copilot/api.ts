// API do assistente de fluxo (T93): sessões por fluxo, mensagens e retomada. A resposta do turno chega também por
// SSE (`copilot.delta`/`copilot.completed`); o POST de mensagem só volta quando o turno termina.
import { api } from '@/lib/http'

export type CopilotSessionStatus = 'active' | 'paused_quota' | 'archived'

export interface CopilotSession {
  id: string
  flow_id: string
  title: string
  status: CopilotSessionStatus
  last_message_at: string
  created_at: string
  updated_at: string
}

export interface CopilotToolCall {
  name: string
  input: unknown
  ok: boolean
  output?: unknown
}

export interface CopilotMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  status: 'completed' | 'failed'
  client_message_id: string | null
  tool_calls: CopilotToolCall[]
  credits: number
  error_code: string | null
  created_at: string
}

export interface CopilotSessionList {
  items: CopilotSession[]
  can_edit: boolean
  tools: string[]
}

export interface CopilotTurn {
  session: CopilotSession
  message: CopilotMessage
  reply: CopilotMessage | null
  graph_changed: boolean
}

const base = '/api/flow-copilot/sessions'
const one = (id: string) => `${base}/${encodeURIComponent(id)}`

export const copilotKeys = {
  sessions: (flowId: string, archived: boolean) => ['flow-copilot', 'sessions', flowId, archived] as const,
  messages: (sessionId: string) => ['flow-copilot', 'messages', sessionId] as const,
}

export const copilotApi = {
  list: (flowId: string, includeArchived = false) =>
    api.get<CopilotSessionList>(
      `${base}?flow_id=${encodeURIComponent(flowId)}${includeArchived ? '&include_archived=1' : ''}`,
    ),
  create: async (flowId: string) => (await api.post<{ session: CopilotSession }>(base, { flow_id: flowId })).session,
  archive: async (id: string) => (await api.post<{ session: CopilotSession }>(`${one(id)}/archive`)).session,
  reopen: async (id: string) => (await api.post<{ session: CopilotSession }>(`${one(id)}/reopen`)).session,
  resume: async (id: string) => (await api.post<{ session: CopilotSession }>(`${one(id)}/resume`)).session,
  messages: async (id: string) => (await api.get<{ items: CopilotMessage[] }>(`${one(id)}/messages`)).items,
  send: (id: string, content: string, clientMessageId: string) =>
    api.post<CopilotTurn>(`${one(id)}/messages`, { content, client_message_id: clientMessageId }),
}

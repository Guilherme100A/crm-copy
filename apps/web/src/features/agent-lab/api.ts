// API do laboratório de agentes (T79; 07 §5 itens 4 e 6, §6): teste ao vivo, "Limpar conversa", estimativa e run da
// criação assistida, e a transcrição do ditado. O run é lido por `GET /api/ai-agents/runs/:runId` e atualizado pelo
// SSE `ai_agent.run.updated` (realtime.ts).
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export const RUN_STAGES = ['extract', 'compose', 'persist'] as const
export type RunStage = (typeof RUN_STAGES)[number]
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface PublicRun {
  id: string
  status: RunStatus
  stage: RunStage | null
  stages_done?: RunStage[]
  warnings: string[]
  agent_id: string | null
  error_message: string | null
  created_at?: string
  updated_at?: string
}

export interface SkillFired {
  tool: string
  action_type: string
  skill_id: string | null
  input: unknown
}

export interface TestMessageResult {
  blocks: { type: 'text'; text: string }[]
  audio: { requested: boolean; allowed: boolean; reason: string | null }
  skills_fired: SkillFired[]
  fields_filled: Record<string, string>
  collected: Record<string, string>
  handoff: { reason: string } | null
  trace: {
    model: { provider: string; model: string }
    instructions: string
    knowledge_hits: string[]
    tool_calls: { name: string; input: unknown; output: unknown }[]
    finish: string
    steps: number
  }
  charged_credits: number
  charged_tokens: number
  usage: { input_tokens: number; output_tokens: number }
  eval: { used: number; limit: number }
}

export interface RunEstimate {
  estimated_tokens: number
  estimated_credits: number | null
  available_credits: number
  enough: boolean
}

export interface RunInput {
  pitch: string
  site_url?: string
}

const enc = encodeURIComponent

export const LAB_KEY = ['agent-lab'] as const
export const runKey = (runId: string) => [...LAB_KEY, 'run', runId] as const

export const runQuery = (runId: string) =>
  queryOptions({
    queryKey: runKey(runId),
    queryFn: async () => (await api.get<{ run: PublicRun }>(`/api/ai-agents/runs/${enc(runId)}`)).run,
    staleTime: 0,
  })

export const labApi = {
  testMessage: (agentId: string, text: string, draft: Record<string, unknown> | null) =>
    api.post<TestMessageResult>(`/api/ai-agents/${enc(agentId)}/test-messages`, draft ? { text, draft } : { text }),
  resetTest: (agentId: string) => api.delete<{ ok: true }>(`/api/ai-agents/${enc(agentId)}/test-messages`),
  estimate: (body: RunInput) => api.post<RunEstimate>('/api/ai-agents/runs/estimate', body),
  createRun: async (body: RunInput) => (await api.post<{ run: PublicRun }>('/api/ai-agents/runs', body)).run,
  transcribe: async (audio: Blob, filename: string) => {
    const form = new FormData()
    form.append('file', audio, filename)
    return (await api.post<{ text: string }>('/api/ai-agents/transcriptions', form)).text
  },
}

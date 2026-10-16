// API dos agentes de IA (07 §6; T39/T52/T79/T80/T88): lista com cota, CRUD, publicar/pausar, duplicar, avatar,
// fontes de conhecimento, opções de modelo, vozes (só leitura aqui) e catálogos dos selects (fluxos, etiquetas).
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'

export const AGENT_STATUSES = ['draft', 'active', 'paused'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]
export const AGENT_GOALS = ['sell', 'schedule', 'answer', 'qualify'] as const
export const AGENT_PERSONALITIES = ['seller', 'support', 'consultative', 'casual'] as const
export const AI_ENGINES = ['economy', 'balanced', 'advanced'] as const
export const NO_BALANCE_ACTIONS = ['none', 'flow', 'notify'] as const
export const SKILL_ACTION_TYPES = [
  'trigger_flow',
  'transfer_human',
  'apply_label',
  'fill_field',
  'close_conversation',
  'compose_message',
] as const
export const SKILL_SCHEDULE_MODES = ['now', 'on_date', 'if_silent'] as const
export const SKILL_SILENCE_UNITS = ['hours', 'days'] as const
export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const
export const AVATAR_KEYS = Array.from({ length: 10 }, (_, i) => `leo-${i + 1}`)
export const KNOWLEDGE_SLOT_LIMITS = { site: 1, pdf: 2, text: 2, faq: 10, flow: 1 } as const

export type SkillActionType = (typeof SKILL_ACTION_TYPES)[number]
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export interface ModelRef {
  provider: string
  model: string
}

export interface AgentSettings {
  buffer_enabled: boolean
  buffer_seconds: number
  split_messages: boolean
  audio_choice_enabled: boolean
  audio_min_words: number
  audio_guidance: string
  audio_voice: string
  audio_max_per_conversation: number
  understand_audio: boolean
  understand_image: boolean
  understand_receipt: boolean
  validate_receipt_pix_key: boolean
  expected_pix_key: string
  validate_receipt_recipient: boolean
  expected_recipient_name: string
  sign_name: boolean
  business_hours_only: boolean
  pause_on_human: boolean
  stall_limit_enabled: boolean
  stall_limit: number
  engine: (typeof AI_ENGINES)[number]
  no_balance_action: (typeof NO_BALANCE_ACTIONS)[number]
  no_balance_flow_id: string | null
  no_balance_notify_name: string
  no_balance_notify_phone: string
  no_balance_notify_country_code: string
  no_balance_notify_message: string
  [k: string]: unknown
}

export interface AgentSkill {
  id?: string
  enabled: boolean
  when_text: string
  action_type: SkillActionType
  action_params: Record<string, unknown>
  schedule_mode: (typeof SKILL_SCHEDULE_MODES)[number]
  silence_amount: number
  silence_unit: (typeof SKILL_SILENCE_UNITS)[number]
}

export interface CollectionField {
  id?: string
  key: string
  label: string
  enabled: boolean
}

export interface AgentDto {
  id: string
  name: string
  role: string
  avatar_key: string
  avatar_url: string | null
  status: AgentStatus
  primary_goal: string
  purpose: string
  audience: string
  personality: string
  example_messages: string
  business_rules: string
  never_talk_about: string
  use_emojis: boolean
  generated_prompt: string
  last_generated_prompt: string
  prompt_edited: boolean
  locked_blocks: unknown[]
  model: ModelRef | null
  resolved_model: ModelRef | null
  settings: AgentSettings
  skills: AgentSkill[]
  collection_fields: CollectionField[]
  skills_count: number
  created_at: string
  updated_at: string
}

export interface AgentsList {
  items: AgentDto[]
  quota: { used: number; limit: number | null }
}

export interface KnowledgeSource {
  id: string
  agent_id: string
  kind: 'site' | 'pdf' | 'text' | 'file' | 'faq' | 'flow'
  slot: keyof typeof KNOWLEDGE_SLOT_LIMITS
  status: 'pending' | 'ready' | 'failed'
  title: string | null
  url: string | null
  filename: string | null
  flow_id: string | null
  items: { q: string; a: string }[] | null
  pages_count: number | null
  questions_count: number | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface ModelOptions {
  providers: { provider: string; available: boolean }[]
  models: ModelRef[]
}

export interface VoiceDto {
  id: string
  name: string
  language: string
  status: string
  samples_count: number
  kept_at: string | null
  created_at: string
}

const enc = encodeURIComponent

export const AGENTS_KEY = ['agents'] as const
export const agentsListKey = (status: AgentStatus | undefined) => [...AGENTS_KEY, 'list', status ?? 'all'] as const
export const agentKey = (id: string) => [...AGENTS_KEY, 'agent', id] as const
export const knowledgeKey = (agentId: string) => [...AGENTS_KEY, 'knowledge', agentId] as const

export const agentsListQuery = (status: AgentStatus | undefined) =>
  queryOptions({
    queryKey: agentsListKey(status),
    queryFn: () => api.get<AgentsList>('/api/ai-agents', { query: { status } }),
    staleTime: 0,
  })

export const agentQuery = (id: string) =>
  queryOptions({
    queryKey: agentKey(id),
    queryFn: async () => (await api.get<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}`)).agent,
    staleTime: 0,
  })

export const knowledgeQuery = (agentId: string) =>
  queryOptions({
    queryKey: knowledgeKey(agentId),
    queryFn: async () =>
      (await api.get<{ items: KnowledgeSource[] }>(`/api/ai-agents/${enc(agentId)}/knowledge-sources`)).items,
    staleTime: 0,
  })

export const modelOptionsQuery = () =>
  queryOptions({
    queryKey: [...AGENTS_KEY, 'model-options'] as const,
    queryFn: () => api.get<ModelOptions>('/api/ai-agents/model-options'),
    staleTime: 0,
  })

/** Catálogo opcional: sem a permissão (403) o select fica vazio. */
async function optional<T>(fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) return empty
    throw err
  }
}

export const voicesQuery = () =>
  queryOptions({
    queryKey: [...AGENTS_KEY, 'voices'] as const,
    queryFn: () =>
      optional(
        async () => (await api.get<{ items: VoiceDto[] }>('/api/ai-voices', { query: { limit: 100 } })).items,
        [] as VoiceDto[],
      ),
    staleTime: 30_000,
  })

export const flowNamesQuery = () =>
  queryOptions({
    queryKey: [...AGENTS_KEY, 'flow-names'] as const,
    queryFn: () =>
      optional(
        async () => (await api.get<{ items: { id: string; name: string }[] }>('/api/flows/names')).items,
        [] as { id: string; name: string }[],
      ),
    staleTime: 60_000,
  })

export const labelsQuery = () =>
  queryOptions({
    queryKey: [...AGENTS_KEY, 'labels'] as const,
    queryFn: () =>
      optional(
        async () =>
          (await api.get<{ items: { id: string; name: string; color: string | null }[] }>('/api/labels')).items,
        [] as { id: string; name: string; color: string | null }[],
      ),
    staleTime: 60_000,
  })

export type AgentPayload = Partial<
  Omit<
    AgentDto,
    | 'id'
    | 'status'
    | 'avatar_url'
    | 'last_generated_prompt'
    | 'locked_blocks'
    | 'resolved_model'
    | 'skills_count'
    | 'created_at'
    | 'updated_at'
  >
>

export const agentsApi = {
  create: async (body: AgentPayload) => (await api.post<{ agent: AgentDto }>('/api/ai-agents', body)).agent,
  update: async (id: string, body: AgentPayload) =>
    (await api.patch<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}`, body)).agent,
  remove: (id: string, force = false) =>
    api.delete<{ ok: true }>(`/api/ai-agents/${enc(id)}`, { query: { force: force ? 1 : undefined } }),
  duplicate: async (id: string) => (await api.post<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}/duplicate`)).agent,
  publish: async (id: string) => (await api.post<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}/publish`)).agent,
  pause: async (id: string) => (await api.post<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}/pause`)).agent,
  generatePrompt: async (id: string) =>
    (await api.post<{ agent: AgentDto; prompt: string }>(`/api/ai-agents/${enc(id)}/generate-prompt`)).agent,
  uploadAvatar: async (id: string, file: File) => {
    const form = new FormData()
    form.append('avatar', file)
    return (await api.post<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}/avatar`, form)).agent
  },
  removeAvatar: async (id: string) => (await api.delete<{ agent: AgentDto }>(`/api/ai-agents/${enc(id)}/avatar`)).agent,
  addKnowledge: async (agentId: string, body: Record<string, unknown> | FormData) =>
    (await api.post<{ source: KnowledgeSource }>(`/api/ai-agents/${enc(agentId)}/knowledge-sources`, body)).source,
  reindexKnowledge: async (agentId: string, sid: string) =>
    (
      await api.post<{ source: KnowledgeSource }>(
        `/api/ai-agents/${enc(agentId)}/knowledge-sources/${enc(sid)}/reindex`,
      )
    ).source,
  removeKnowledge: (agentId: string, sid: string) =>
    api.delete(`/api/ai-agents/${enc(agentId)}/knowledge-sources/${enc(sid)}`),
}

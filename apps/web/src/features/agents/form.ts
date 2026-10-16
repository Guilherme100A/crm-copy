// Regras puras da lista e do editor de agentes: busca/filtro, texto da cota, rascunho do editor ↔ payload, erros do
// servidor por campo (e a aba de cada campo), modelos com disponibilidade por provedor.
import type {
  AgentDto,
  AgentPayload,
  AgentSettings,
  AgentSkill,
  AgentStatus,
  CollectionField,
  ModelOptions,
  ModelRef,
  SkillActionType,
} from './api'

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function filterAgents<T extends { name: string }>(items: readonly T[], search: string): T[] {
  const q = norm(search.trim())
  return q ? items.filter((a) => norm(a.name).includes(q)) : [...items]
}

/** Cota: `{used, limit}` → limite atingido? (`null` = ilimitado). */
export const limitReached = (q: { used: number; limit: number | null } | undefined) =>
  !!q && q.limit !== null && q.used >= q.limit

export const EDITOR_TABS = ['photo', 'instructions', 'skills', 'knowledge', 'collection', 'settings'] as const
export type EditorTab = (typeof EDITOR_TABS)[number]

const TAB_OF: Record<string, EditorTab> = {
  name: 'photo',
  role: 'photo',
  avatar_key: 'photo',
  avatar: 'photo',
  primary_goal: 'instructions',
  personality: 'instructions',
  purpose: 'instructions',
  audience: 'instructions',
  example_messages: 'instructions',
  business_rules: 'instructions',
  never_talk_about: 'instructions',
  use_emojis: 'instructions',
  generated_prompt: 'instructions',
  prompt_edited: 'instructions',
  skills: 'skills',
  knowledge: 'knowledge',
  collection_fields: 'collection',
  settings: 'settings',
  model: 'settings',
}

/** Aba onde o campo do erro aparece (`settings.buffer_seconds` → settings; `skills.0.when_text` → skills). */
export const tabOfField = (path: string): EditorTab => TAB_OF[path.split('.')[0] ?? ''] ?? 'photo'

export type FieldErrors = Record<string, string>

/** `details.fields[]` de um VALIDATION_ERROR (SPEC 3.5) → `{ path: message }`. */
export function fieldErrorsOf(details: unknown): FieldErrors {
  const fields = (details as { fields?: unknown } | null | undefined)?.fields
  const out: FieldErrors = {}
  if (!Array.isArray(fields)) return out
  for (const f of fields) {
    const path = typeof f?.path === 'string' ? f.path : ''
    const message = typeof f?.message === 'string' ? f.message : ''
    if (path && !(path in out)) out[path] = message
  }
  return out
}

/** Rascunho editável do agente (o que o PATCH/POST envia). */
export interface AgentDraft {
  name: string
  role: string
  avatar_key: string
  primary_goal: string
  personality: string
  purpose: string
  audience: string
  example_messages: string
  business_rules: string
  never_talk_about: string
  use_emojis: boolean
  generated_prompt: string
  prompt_edited: boolean
  model: ModelRef | null
  settings: AgentSettings
  skills: AgentSkill[]
  collection_fields: CollectionField[]
}

export const SETTINGS_DEFAULTS: AgentSettings = {
  buffer_enabled: true,
  buffer_seconds: 5,
  split_messages: true,
  audio_choice_enabled: true,
  audio_min_words: 40,
  audio_guidance: '',
  audio_voice: '',
  audio_max_per_conversation: 3,
  understand_audio: true,
  understand_image: true,
  understand_receipt: true,
  validate_receipt_pix_key: false,
  expected_pix_key: '',
  validate_receipt_recipient: false,
  expected_recipient_name: '',
  sign_name: false,
  business_hours_only: false,
  pause_on_human: true,
  stall_limit_enabled: true,
  stall_limit: 12,
  engine: 'balanced',
  no_balance_action: 'none',
  no_balance_flow_id: null,
  no_balance_notify_name: '',
  no_balance_notify_phone: '',
  no_balance_notify_country_code: '55',
  no_balance_notify_message: '',
}

export const DEFAULT_COLLECTION_FIELDS: CollectionField[] = [
  { key: 'nome', label: 'Nome', enabled: true },
  { key: 'cidade', label: 'Cidade', enabled: true },
  { key: 'produto', label: 'Produto', enabled: true },
  { key: 'email', label: 'E-mail', enabled: false },
  { key: 'recompra', label: 'Recompra', enabled: false },
]

/** Agente novo (`/agentes/novo`): os defaults de 07 §3.1. */
export const newDraft = (): AgentDraft => ({
  name: 'Leo',
  role: '',
  avatar_key: 'leo-2',
  primary_goal: 'sell',
  personality: 'seller',
  purpose: '',
  audience: '',
  example_messages: '',
  business_rules: '',
  never_talk_about: '',
  use_emojis: true,
  generated_prompt: '',
  prompt_edited: false,
  model: null,
  settings: { ...SETTINGS_DEFAULTS },
  skills: [],
  collection_fields: DEFAULT_COLLECTION_FIELDS.map((f) => ({ ...f })),
})

export function draftOf(a: AgentDto): AgentDraft {
  return {
    name: a.name,
    role: a.role,
    avatar_key: a.avatar_key,
    primary_goal: a.primary_goal,
    personality: a.personality,
    purpose: a.purpose,
    audience: a.audience,
    example_messages: a.example_messages,
    business_rules: a.business_rules,
    never_talk_about: a.never_talk_about,
    use_emojis: a.use_emojis,
    generated_prompt: a.generated_prompt,
    prompt_edited: a.prompt_edited,
    model: a.model,
    settings: { ...SETTINGS_DEFAULTS, ...a.settings },
    skills: a.skills.map(({ id: _id, ...s }) => ({ ...s, action_params: { ...s.action_params } })),
    collection_fields: a.collection_fields.map((f) => ({ key: f.key, label: f.label, enabled: f.enabled })),
  }
}

/** Payload do save: o servidor valida tudo (erros voltam por campo). Habilidades sem id do servidor. */
export function payloadOf(d: AgentDraft): AgentPayload {
  return {
    ...d,
    name: d.name,
    skills: d.skills.map((s) => ({ ...s, action_params: paramsFor(s.action_type, s.action_params) })),
    collection_fields: d.collection_fields.map((f) => ({ key: f.key, label: f.label, enabled: f.enabled })),
  }
}

/** Parâmetros que cada ação aceita (07 §3.3): os demais tipos vão `{}`. */
export function paramsFor(type: SkillActionType, p: Record<string, unknown>): Record<string, unknown> {
  if (type === 'trigger_flow') return { flow_id: p.flow_id ?? '', return_to_agent: p.return_to_agent === true }
  if (type === 'apply_label')
    return {
      mode: p.mode === 'remove' ? 'remove' : 'add',
      label_id: p.label_id || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
    }
  return {}
}

export const newSkill = (): AgentSkill => ({
  enabled: true,
  when_text: '',
  action_type: 'transfer_human',
  action_params: {},
  schedule_mode: 'now',
  silence_amount: 1,
  silence_unit: 'days',
})

/** "Quando" com menos de 4 palavras é vago (07 §3.3). */
export const vagueWhen = (text: string) => {
  const n = text.trim().split(/\s+/).filter(Boolean).length
  return n > 0 && n < 4
}

/** Chave de campo de coleta a partir do rótulo (`Data de nascimento` → `data_de_nascimento`). */
export function keyFromLabel(label: string): string {
  const k = norm(label)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return /^[a-z]/.test(k) ? k : k ? `c_${k}`.slice(0, 40) : ''
}

export const sameDraft = (a: AgentDraft, b: AgentDraft) => JSON.stringify(a) === JSON.stringify(b)

/** Opções do seletor: modelos do catálogo com a disponibilidade do provedor; o modelo atual entra mesmo fora dele. */
export interface ModelOption extends ModelRef {
  available: boolean
}

export function modelOptions(opts: ModelOptions | undefined, current: ModelRef | null): ModelOption[] {
  const avail = new Map((opts?.providers ?? []).map((p) => [p.provider, p.available]))
  const out: ModelOption[] = (opts?.models ?? []).map((m) => ({ ...m, available: avail.get(m.provider) ?? false }))
  if (current && !out.some((m) => m.provider === current.provider && m.model === current.model))
    out.unshift({ ...current, available: avail.get(current.provider) ?? false })
  // Disponíveis primeiro, mantendo a ordem do catálogo dentro de cada grupo.
  return [...out.filter((m) => m.available), ...out.filter((m) => !m.available)]
}

/** Transição de status pelos botões do cabeçalho (07 §5.7). */
export const nextAction = (status: AgentStatus): 'publish' | 'pause' => (status === 'active' ? 'pause' : 'publish')

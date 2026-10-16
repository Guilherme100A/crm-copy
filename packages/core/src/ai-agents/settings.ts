// AgentSettings, habilidades e campos de coleta (07-agentes-ia.md §3.2, §3.3, §3.5), validados por zod.
import { z } from 'zod'

export const AI_ENGINES = ['economy', 'balanced', 'advanced'] as const
export type AiEngine = (typeof AI_ENGINES)[number]
export const NO_BALANCE_ACTIONS = ['none', 'flow', 'notify'] as const

const uuidOrNull = z.uuid().nullable()

/** Schema das configurações; cada campo tem o default de 07 §3.2. */
export const agentSettingsSchema = z.object({
  buffer_enabled: z.boolean().default(true),
  buffer_seconds: z.number().int().min(1).max(60).default(5),
  split_messages: z.boolean().default(true),
  audio_choice_enabled: z.boolean().default(true),
  audio_min_words: z.number().int().min(1).max(1000).default(40),
  audio_guidance: z.string().max(2000).default(''),
  audio_voice: z.string().max(200).default(''),
  audio_max_per_conversation: z.number().int().min(0).max(100).default(3),
  understand_audio: z.boolean().default(true),
  understand_image: z.boolean().default(true),
  understand_receipt: z.boolean().default(true),
  validate_receipt_pix_key: z.boolean().default(false),
  expected_pix_key: z.string().max(200).default(''),
  validate_receipt_recipient: z.boolean().default(false),
  expected_recipient_name: z.string().max(200).default(''),
  source_flow_id: uuidOrNull.default(null),
  source_label_id: uuidOrNull.default(null),
  sign_name: z.boolean().default(false),
  business_hours_only: z.boolean().default(false),
  pause_on_human: z.boolean().default(true),
  stall_limit_enabled: z.boolean().default(true),
  stall_limit: z.number().int().min(1).max(200).default(12),
  engine: z.enum(AI_ENGINES).default('balanced'),
  no_balance_action: z.enum(NO_BALANCE_ACTIONS).default('none'),
  no_balance_flow_id: uuidOrNull.default(null),
  no_balance_notify_name: z.string().max(200).default(''),
  no_balance_notify_phone: z.string().max(40).default(''),
  no_balance_notify_country_code: z.string().max(5).default('55'),
  no_balance_notify_message: z.string().max(2000).default(''),
})
export type AgentSettings = z.output<typeof agentSettingsSchema>

/** Defaults de 07 §3.2 (objeto congelado). */
export const AGENT_SETTINGS_DEFAULTS: Readonly<AgentSettings> = Object.freeze(agentSettingsSchema.parse({}))

export const SKILL_ACTION_TYPES = ['trigger_flow', 'transfer_human', 'apply_label', 'fill_field', 'close_conversation', 'compose_message'] as const
export const SKILL_SCHEDULE_MODES = ['now', 'on_date', 'if_silent'] as const
export const SKILL_SILENCE_UNITS = ['hours', 'days'] as const

const base = {
  enabled: z.boolean().default(true),
  when_text: z.string().max(2000).default(''),
  schedule_mode: z.enum(SKILL_SCHEDULE_MODES).default('now'),
  silence_amount: z.number().int().min(1).max(365).default(1),
  silence_unit: z.enum(SKILL_SILENCE_UNITS).default('days'),
}

/** Habilidade com `action_params` validado pelo tipo (07 §3.3). */
export const agentSkillSchema = z.discriminatedUnion('action_type', [
  z.object({ ...base, action_type: z.literal('trigger_flow'), action_params: z.object({ flow_id: z.uuid(), return_to_agent: z.boolean().default(false) }) }),
  z.object({
    ...base,
    action_type: z.literal('apply_label'),
    action_params: z.object({ mode: z.enum(['add', 'remove']).default('add'), label_id: z.uuid().nullish(), tags: z.array(z.string().max(100)).max(50).default([]) }),
  }),
  ...(['transfer_human', 'fill_field', 'close_conversation', 'compose_message'] as const).map((t) =>
    z.object({ ...base, action_type: z.literal(t), action_params: z.record(z.string(), z.unknown()).default({}) }),
  ),
])
export type AgentSkillInput = z.output<typeof agentSkillSchema>

export const COLLECTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

export const collectionFieldSchema = z.object({
  key: z.string().regex(COLLECTION_KEY_RE, 'Use letras minúsculas, números e _'),
  label: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
})
export type CollectionFieldInput = z.output<typeof collectionFieldSchema>

/** Campos de coleta padrão (07 §3.5): nome, cidade, produto ligados; email, recompra desligados. */
export const DEFAULT_COLLECTION_FIELDS: readonly CollectionFieldInput[] = Object.freeze([
  { key: 'nome', label: 'Nome', enabled: true },
  { key: 'cidade', label: 'Cidade', enabled: true },
  { key: 'produto', label: 'Produto', enabled: true },
  { key: 'email', label: 'E-mail', enabled: false },
  { key: 'recompra', label: 'Recompra', enabled: false },
])

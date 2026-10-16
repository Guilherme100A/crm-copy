import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Vozes da conta (T80; 07-agentes-ia.md §3.7): clonagem de voz a partir de 1–3 áudios no provedor de TTS
// (ElevenLabs, chave BYOK da empresa ou da plataforma). Fica `pending` até o usuário manter (`kept`) ou descartar
// (exclusão). As amostras não são guardadas: só os metadados.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const AI_VOICE_LANGUAGES = ['pt', 'en', 'es', 'hi'] as const
export type AiVoiceLanguage = (typeof AI_VOICE_LANGUAGES)[number]
export const AI_VOICE_STATUSES = ['pending', 'kept'] as const
export type AiVoiceStatus = (typeof AI_VOICE_STATUSES)[number]

export interface AiVoiceSample {
  filename: string
  mime: string
  bytes: number
}

export const aiVoices = crm.table(
  'ai_voices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    language: text('language').$type<AiVoiceLanguage>().notNull(),
    status: text('status').$type<AiVoiceStatus>().notNull().default('pending'),
    provider: text('provider').notNull().default('elevenlabs'),
    /** `voice_id` no provedor; é o que vai em `ai_agents.settings.audio_voice`. */
    providerVoiceId: text('provider_voice_id').notNull(),
    samplesCount: integer('samples_count').notNull(),
    samples: jsonb('samples').$type<AiVoiceSample[]>().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    keptAt: timestamp('kept_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_voices_company_idx').on(t.companyId, t.createdAt), uniqueIndex('ai_voices_provider_voice_uq').on(t.companyId, t.provider, t.providerVoiceId)],
)

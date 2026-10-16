import { sql } from 'drizzle-orm'
import { boolean, check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Chaves de provedores de IA da empresa (T38, BYOK; 07-agentes-ia.md §3.8, 19-integracoes.md §3.3).
// O segredo só existe cifrado (SPEC 1.4 nº 8): `secret_enc` = `serializeEncrypted` com AAD `ai-key/<company>/<id>`.
// Com várias chaves ativas do mesmo provedor, vale a de `updated_at` mais recente.

export const AI_KEY_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq'] as const
export type AiKeyProvider = (typeof AI_KEY_PROVIDERS)[number]

export const aiProviderKeys = crm.table(
  'ai_provider_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Fixo depois de criado. */
    provider: text('provider').$type<AiKeyProvider>().notNull(),
    name: text('name').notNull(),
    secretEnc: text('secret_enc').notNull(),
    /** Últimos 4 caracteres do segredo, para exibir `…abcd`. */
    secretHint: text('secret_hint').notNull(),
    active: boolean('active').notNull().default(true),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ai_provider_keys_company_provider_idx').on(t.companyId, t.provider, t.updatedAt),
    check('ai_provider_keys_name_len', sql`char_length(${t.name}) between 2 and 80`),
    check('ai_provider_keys_provider_check', sql`${t.provider} in ('anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq')`),
  ],
)

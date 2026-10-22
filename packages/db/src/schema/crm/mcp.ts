import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Credenciais MCP (T94; 09 §3.4): clientes de IA externos (Cursor, n8n, Claude) leem a empresa pelo servidor MCP com
// `Authorization: Bearer <token>`. O token (`auth_type = 'static'`) é mostrado uma única vez; no banco só o SHA-256 e
// os 4 últimos caracteres. Expira por `expires_at`; revogar marca `revoked_at` (some da listagem e invalida na hora).
// `oauth` (conector do Claude) é da T115. `access = 'write'` libera as ferramentas que gravam, sempre limitadas às
// permissões do usuário dono do token (criador da credencial estática ou quem autorizou o OAuth).

export const MCP_AUTH_TYPES = ['static', 'oauth'] as const
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number]
export const MCP_ACCESS_MODES = ['read', 'write'] as const
export type McpAccessMode = (typeof MCP_ACCESS_MODES)[number]

export const mcpCredentials = crm.table(
  'mcp_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    authType: text('auth_type').$type<McpAuthType>().notNull().default('static'),
    access: text('access').$type<McpAccessMode>().notNull().default('read'),
    /** SHA-256 (hex) do token cru; nulo para `oauth`. */
    tokenHash: text('token_hash'),
    /** 4 últimos caracteres do token, para identificar na UI. */
    tokenHint: text('token_hint'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('mcp_credentials_token_hash_uq').on(t.tokenHash), index('mcp_credentials_company_idx').on(t.companyId, t.createdAt)],
)

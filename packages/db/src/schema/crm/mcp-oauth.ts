import { index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { mcpCredentials } from './mcp.js'
import { createdAt, crm } from './schema.js'

// OAuth 2.1 das credenciais MCP `auth_type = 'oauth'` (T115; 09 §3.4, §4): servidor de autorização para conectores
// como o do Claude. O cliente se registra sozinho (RFC 7591), o usuário aprova na tela de consentimento e recebe
// access token curto + refresh token com rotação. Nenhum segredo cru no banco: só o SHA-256 (hex).
// A credencial fica `pending` até existir um grant ativo (`connected`, com o nome do cliente); revogar a credencial
// (T94) ou o grant invalida access e refresh na hora.

/** Cliente registrado dinamicamente (antes de qualquer login, por isso sem empresa). */
export const mcpOauthClients = crm.table('mcp_oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull().unique(),
  /** SHA-256 do `client_secret`; nulo para cliente público (`token_endpoint_auth_method = 'none'`). */
  clientSecretHash: text('client_secret_hash'),
  clientName: text('client_name'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull(),
  /** Metadados aceitos no registro (devolvidos ao cliente, RFC 7591 §3.2.1). */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
})

/**
 * Pedido de autorização (`/authorize`) aguardando consentimento; aprovado, ganha o código de uso único (hash) e
 * expiração curta. `credentialId` vem do `resource` (URL do conector).
 */
export const mcpOauthAuthorizations = crm.table(
  'mcp_oauth_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => mcpCredentials.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    state: text('state'),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash'),
    /** Validade do pedido; ao aprovar, passa a ser a do código. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_authorizations_code_hash_uq').on(t.codeHash),
    index('mcp_oauth_authorizations_company_idx').on(t.companyId, t.createdAt),
  ],
)

/** Grant = família de tokens de uma conexão (cliente × credencial). Revogar a família derruba todos os tokens. */
export const mcpOauthGrants = crm.table(
  'mcp_oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => mcpCredentials.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpOauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    authorizationId: uuid('authorization_id').references(() => mcpOauthAuthorizations.id, { onDelete: 'set null' }),
    /** Nome do cliente na hora da conexão (`connected_client_hint`). */
    clientName: text('client_name').notNull(),
    scope: text('scope').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('mcp_oauth_grants_company_idx').on(t.companyId, t.credentialId)],
)

/** Par access/refresh emitido; a rotação marca `rotated_at` no par anterior (reuso dele revoga o grant). */
export const mcpOauthTokens = crm.table(
  'mcp_oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    accessHash: text('access_hash').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_tokens_access_hash_uq').on(t.accessHash),
    uniqueIndex('mcp_oauth_tokens_refresh_hash_uq').on(t.refreshHash),
    index('mcp_oauth_tokens_company_idx').on(t.companyId, t.grantId),
  ],
)

import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Conexões WhatsApp da empresa (T40, 08-conexoes.md §3.1): 1:1 com a sessão do gateway (`session_id`).
// O estado da sessão vem do gateway; `connection_state`/`last_disconnect_reason` são projetados dos eventos
// `session.connection` (T47). A senha do proxy só existe cifrada (SPEC 1.4 nº 8).

export const EPHEMERAL_DURATIONS = ['off', '1d', '7d', '90d'] as const
export type EphemeralDuration = (typeof EPHEMERAL_DURATIONS)[number]

/**
 * Origem da conexão: `crm` (o CRM criou a sessão no gateway) ou `ai-manager` (chip que já existia no ai-manager,
 * importado sem QR; o ciclo de vida da sessão fica no painel do ai-manager e o CRM só vincula/desvincula).
 */
export const CONNECTION_ORIGINS = ['crm', 'ai-manager'] as const
export type ConnectionOrigin = (typeof CONNECTION_ORIGINS)[number]

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const
export type ConnectionProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

export const connections = crm.table(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Id da sessão no gateway (WaGateway.sessions). */
    sessionId: text('session_id').notNull(),
    name: text('name').notNull(),
    phoneNumber: text('phone_number'),
    /** Último `session.connection` conhecido. */
    connectionState: text('connection_state'),
    lastDisconnectReason: text('last_disconnect_reason'),
    lastStatusCode: integer('last_status_code'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    /** QR ou código de pareamento pedido (status `connecting` antes da primeira conexão). */
    qrRequestedAt: timestamp('qr_requested_at', { withTimezone: true }),
    notifySentByMe: boolean('notify_sent_by_me').notNull().default(false),
    ephemeralDuration: text('ephemeral_duration').notNull().default('off'),
    saveContactsEnabled: boolean('save_contacts_enabled').notNull().default(false),
    scheduledForDeletionAt: timestamp('scheduled_for_deletion_at', { withTimezone: true }),
    /** Proxy alterado depois da conexão: vale após reiniciar a sessão. */
    requiresRestart: boolean('requires_restart').notNull().default(false),
    proxyProtocol: text('proxy_protocol'),
    proxyHost: text('proxy_host'),
    proxyPort: integer('proxy_port'),
    proxyUsername: text('proxy_username'),
    /** `serializeEncrypted` (AES-256-GCM, AAD `connection/<id>/proxy`). */
    proxyPasswordEnc: text('proxy_password_enc'),
    origin: text('origin').notNull().default('crm'),
    /**
     * Conexão importada e desvinculada: o `session_id` vira `unlinked:<id>` (nada mais roteia nem envia por ela, e a
     * sessão pode ser importada de novo) e o id original fica em `unlinked_session_id`. Os chats ficam no histórico.
     */
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    unlinkedSessionId: text('unlinked_session_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connections_session_id_uq').on(t.sessionId),
    index('connections_company_created_idx').on(t.companyId, t.createdAt),
    check('connections_name_len', sql`char_length(${t.name}) between 2 and 100`),
    check('connections_ephemeral_check', sql`${t.ephemeralDuration} in ('off', '1d', '7d', '90d')`),
    check('connections_state_check', sql`${t.connectionState} is null or ${t.connectionState} in ('open', 'close')`),
    check('connections_origin_check', sql`${t.origin} in ('crm', 'ai-manager')`),
    check('connections_proxy_protocol_check', sql`${t.proxyProtocol} is null or ${t.proxyProtocol} in ('http', 'https', 'socks5')`),
    check('connections_proxy_port_check', sql`${t.proxyPort} is null or ${t.proxyPort} between 1 and 65535`),
  ],
)

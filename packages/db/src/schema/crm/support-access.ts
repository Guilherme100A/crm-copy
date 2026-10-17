import { sql } from 'drizzle-orm'
import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Acesso de suporte (T32; 01 §19, 16 §3.7): o usuário `support` pede acesso a uma empresa; owner/admin aprova uma
// concessão temporária (12 h) com escopo só de fluxos e MCP. Pedido `pending` → `approved` | `rejected` | `cancelled`;
// concessão ativa enquanto `revoked_at` é nulo e `expires_at` está no futuro.

export const SUPPORT_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type SupportAccessRequestStatus = (typeof SUPPORT_ACCESS_REQUEST_STATUSES)[number]

export const supportAccessRequests = crm.table(
  'support_access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supportUserId: uuid('support_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<SupportAccessRequestStatus>().notNull().default('pending'),
    /** Owner/admin que aprovou ou recusou. */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Último reenvio (o evento `support_access.requested` é publicado de novo). */
    resentAt: timestamp('resent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // No máximo um pedido pendente por suporte e empresa.
    uniqueIndex('support_access_requests_pending_uq').on(t.companyId, t.supportUserId).where(sql`${t.status} = 'pending'`),
    index('support_access_requests_company_idx').on(t.companyId, t.status, t.createdAt),
    index('support_access_requests_support_idx').on(t.supportUserId, t.createdAt),
  ],
)

export const supportAccessGrants = crm.table(
  'support_access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supportUserId: uuid('support_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').references(() => supportAccessRequests.id, { onDelete: 'set null' }),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('support_access_grants_company_idx').on(t.companyId, t.supportUserId, t.expiresAt),
    index('support_access_grants_support_idx').on(t.supportUserId, t.expiresAt),
  ],
)

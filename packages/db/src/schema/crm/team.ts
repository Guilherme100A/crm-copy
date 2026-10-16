import { sql } from 'drizzle-orm'
import { date, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, memberRoleEnum, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Convites unificados (T22): `member` (entrar numa empresa) e `platform` (cadastrar-se na plataforma já
// vinculado à empresa). O token só existe como SHA-256 (`token_hash`); `expired` é derivado de `expires_at`.

export const INVITATION_KINDS = ['member', 'platform'] as const
export type InvitationKind = (typeof INVITATION_KINDS)[number]
export const invitationKindEnum = crm.enum('invitation_kind', INVITATION_KINDS)

export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'cancelled'] as const
export type InvitationStoredStatus = (typeof INVITATION_STATUSES)[number]
export const invitationStatusEnum = crm.enum('invitation_status', INVITATION_STATUSES)

export const invitations = crm.table(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: invitationKindEnum('kind').notNull().default('member'),
    /** Minúsculo (normalizado na entrada). */
    email: text('email').notNull(),
    role: memberRoleEnum('role').notNull().default('member'),
    status: invitationStatusEnum('status').notNull().default('pending'),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    /** Dia (no fuso da empresa) a que `resends_today` se refere. */
    resendsDay: date('resends_day', { mode: 'string' }),
    resendsToday: integer('resends_today').notNull().default(0),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    index('invitations_company_kind_idx').on(t.companyId, t.kind, t.createdAt),
    // Um convite pendente por (empresa, tipo, e-mail).
    uniqueIndex('invitations_pending_uq').on(t.companyId, t.kind, t.email).where(sql`${t.status} = 'pending'`),
  ],
)

import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { createdAt, crm, updatedAt } from './schema.js'

// Tabelas-base do CRM (T01): empresas, usuários, vínculos, sessões, tokens, auditoria e configurações da plataforma.

export const SYSTEM_ROLES = ['user', 'platform_admin', 'support'] as const
export type SystemRole = (typeof SYSTEM_ROLES)[number]
export const systemRoleEnum = crm.enum('system_role', SYSTEM_ROLES)

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]
export const memberRoleEnum = crm.enum('member_role', MEMBER_ROLES)

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'
export const DEFAULT_LOCALE = 'pt-BR'

export const companies = crm.table(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    active: boolean('active').notNull().default(true),
    timeZone: text('time_zone').notNull().default(DEFAULT_TIME_ZONE),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('companies_slug_uq').on(t.slug)],
)

export const users = crm.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    systemRole: systemRoleEnum('system_role').notNull().default('user'),
    locale: text('locale').notNull().default(DEFAULT_LOCALE),
    avatarKey: text('avatar_key'),
    lastCompanyId: uuid('last_company_id').references((): AnyPgColumn => companies.id, { onDelete: 'set null' }),
    referralCode: text('referral_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // E-mail único sem diferenciar maiúsculas (AC-T01-03).
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    uniqueIndex('users_referral_code_uq').on(t.referralCode),
  ],
)

export const companyMembers = crm.table(
  'company_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    // null = matriz padrão do papel; lista explícita substitui a matriz (SPEC 3.3).
    permissionKeys: text('permission_keys').array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('company_members_company_user_uq').on(t.companyId, t.userId),
    // No máximo um owner por empresa (AC-T01-03).
    uniqueIndex('company_members_one_owner_uq').on(t.companyId).where(sql`${t.role} = 'owner'`),
    index('company_members_user_idx').on(t.userId),
  ],
)

// Sessões de login por token opaco; só o SHA-256 do token é guardado (SPEC 3.4).
export const authSessions = crm.table(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_sessions_token_hash_uq').on(t.tokenHash), index('auth_sessions_user_idx').on(t.userId)],
)

// Tokens de API por empresa (`crm_pat_<…>`); só hash + prefixo para exibir a máscara (SPEC 3.4).
export const apiTokens = crm.table(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_token_hash_uq').on(t.tokenHash), index('api_tokens_company_idx').on(t.companyId, t.createdAt)],
)

export const passwordResets = crm.table(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('password_resets_token_hash_uq').on(t.tokenHash), index('password_resets_user_idx').on(t.userId)],
)

// Auditoria das rotas mutantes (SPEC 3.6), sem segredos em `detail`.
// `company_id` é nulo só em ações de plataforma (login, admin interno), que não pertencem a uma empresa.
export const auditLogs = crm.table(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_company_created_idx').on(t.companyId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorUserId),
  ],
)

// Configurações globais da plataforma (chave → valor), editadas pelo admin interno.
export const platformSettings = crm.table('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})

export const CRM_BASE_TABLES = [
  'companies',
  'users',
  'company_members',
  'auth_sessions',
  'api_tokens',
  'password_resets',
  'audit_logs',
  'platform_settings',
] as const

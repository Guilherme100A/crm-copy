import { boolean, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Meta Ads (T99; 11 §3.1–3.2): perfis Meta conectados por OAuth (um login por perfil, N por empresa) e as contas de
// anúncio de cada perfil. O token longo do usuário só existe cifrado (SPEC 1.4 nº 8; AAD `meta_profile/<id>/token`).

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const metaProfiles = crm.table(
  'meta_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    /** Id do usuário na Meta (`/me.id`). */
    fbUserId: text('fb_user_id').notNull(),
    fbUserName: text('fb_user_name'),
    pictureUrl: text('picture_url'),
    /** `serializeEncrypted` (AES-256-GCM). Nunca sai pela API. */
    accessTokenEnc: text('access_token_enc').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('meta_profiles_company_fb_user_uq').on(t.companyId, t.fbUserId), index('meta_profiles_company_idx').on(t.companyId, t.createdAt)],
)

export const metaAdAccounts = crm.table(
  'meta_ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => metaProfiles.id, { onDelete: 'cascade' }),
    /** Id da conta na Graph (`act_<n>`). */
    fbAccountId: text('fb_account_id').notNull(),
    name: text('name'),
    currency: text('currency'),
    /** `account_status` da Meta (1 = ativa). */
    accountStatus: integer('account_status'),
    /** Entra no dashboard e no Gerenciador. Nada é incluído automaticamente (11 §3.2). */
    includedInDashboard: boolean('included_in_dashboard').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('meta_ad_accounts_profile_account_uq').on(t.profileId, t.fbAccountId), index('meta_ad_accounts_company_idx').on(t.companyId, t.profileId)],
)

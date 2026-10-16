import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Contatos, etiquetas e catálogo de campos personalizados (T26; features 05 §3.1–3.2 e 17 §3.D–3.E).
// Identidade WhatsApp: `phone_e164` OU `wa_lid`, cada um único por empresa quando presente (SPEC 3.8).

/** Origem do consentimento (SPEC 1.4 nº 3), repassada ao `WaGateway.recordConsent`. */
export const CONSENT_SOURCES = ['inbound', 'manual', 'import', 'webhook', 'sale'] as const
export type ContactConsentSource = (typeof CONSENT_SOURCES)[number]

/** Como o contato nasceu no CRM. */
export const CONTACT_ORIGINS = ['manual', 'api', 'whatsapp', 'import', 'webhook', 'sale'] as const
export type ContactOrigin = (typeof CONTACT_ORIGINS)[number]

export const contacts = crm.table(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    phoneE164: text('phone_e164'),
    waLid: text('wa_lid'),
    email: text('email'),
    state: text('state'),
    city: text('city'),
    zip: text('zip'),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    consent: boolean('consent').notNull().default(false),
    consentSource: text('consent_source').$type<ContactConsentSource>(),
    optOut: boolean('opt_out').notNull().default(false),
    origin: text('origin').$type<ContactOrigin>().notNull().default('manual'),
    // Atribuição de anúncio Click-to-WhatsApp.
    ctwaClid: text('ctwa_clid'),
    sourceId: text('source_id'),
    sourceUrl: text('source_url'),
    adMediaUrl: text('ad_media_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('contacts_company_phone_uq').on(t.companyId, t.phoneE164).where(sql`${t.phoneE164} is not null`),
    uniqueIndex('contacts_company_lid_uq').on(t.companyId, t.waLid).where(sql`${t.waLid} is not null`),
    index('contacts_company_created_idx').on(t.companyId, t.createdAt),
  ],
)

export const labels = crm.table(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('labels_company_name_uq').on(t.companyId, sql`lower(${t.name})`)],
)

export const contactLabels = crm.table(
  'contact_labels',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'contact_labels_pk', columns: [t.contactId, t.labelId] }),
    index('contact_labels_company_label_idx').on(t.companyId, t.labelId),
  ],
)

/** Catálogo de campos personalizados: chave minúscula imutável; só a descrição é editável. */
export const customFieldDefs = crm.table(
  'custom_field_defs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    description: text('description'),
    exampleValue: text('example_value'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('custom_field_defs_company_key_uq').on(t.companyId, t.key)],
)

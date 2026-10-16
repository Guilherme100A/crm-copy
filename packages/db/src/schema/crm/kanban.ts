import { sql } from 'drizzle-orm'
import { bigint, boolean, char, check, doublePrecision, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { chats } from './chats.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Kanban / CRM de funil (T50; 04-kanban-crm.md §3.1–3.3). Quadros (`crms`), colunas com posição 0..n−1 e cards
// (um por chat por quadro, posição fracionária para inserir entre dois sem reescrever a coluna).

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const kanbanBoards = crm.table(
  'crms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('crms_company_idx').on(t.companyId, t.createdAt)],
)

export const kanbanColumns = crm.table(
  'crm_columns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    crmId: uuid('crm_id')
      .notNull()
      .references(() => kanbanBoards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 0..n−1 dentro do quadro (recompactado ao mover/excluir). */
    position: integer('position').notNull(),
    /** `#RRGGBB` ou null ("Automático": cor da paleta pela posição). */
    accentColor: text('accent_color'),
    /** Coluna conta como conversão nos relatórios. */
    conversionGoal: boolean('conversion_goal').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('crm_columns_company_crm_idx').on(t.companyId, t.crmId, t.position),
    check('crm_columns_accent_color_check', sql`${t.accentColor} is null or ${t.accentColor} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
)

export const kanbanCards = crm.table(
  'crm_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    crmId: uuid('crm_id')
      .notNull()
      .references(() => kanbanBoards.id, { onDelete: 'cascade' }),
    /** Excluir a coluna exclui os cards dela (04 §5.10). */
    columnId: uuid('column_id')
      .notNull()
      .references(() => kanbanColumns.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** Ordem fracionária dentro da coluna. */
    position: doublePrecision('position').notNull(),
    /** Valor do lead (SPEC 3.6: centavos + moeda). */
    valueCents: bigint('value_cents', { mode: 'number' }).notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('BRL'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Um card por chat em cada quadro (04 §3.5).
    uniqueIndex('crm_cards_crm_chat_uq').on(t.crmId, t.chatId),
    index('crm_cards_company_crm_column_idx').on(t.companyId, t.crmId, t.columnId, t.position),
    index('crm_cards_company_chat_idx').on(t.companyId, t.chatId),
  ],
)

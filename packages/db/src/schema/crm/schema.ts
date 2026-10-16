import { pgSchema, timestamp } from 'drizzle-orm/pg-core'

// Todas as tabelas do CRM ficam no schema `crm` (SPEC 3.1), separadas das `public.*` do WhatsApp,
// para conviver com o banco do ai-manager (AI-MANAGER-MAP §13.1 nº 4).
export const CRM_SCHEMA = 'crm'
export const crm = pgSchema(CRM_SCHEMA)

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

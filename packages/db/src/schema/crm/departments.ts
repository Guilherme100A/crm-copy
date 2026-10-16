import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, companyMembers } from './base.js'
import { connections } from './connections.js'
import { flows } from './flows.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Departamentos, escopo de chat por membro e horários de atendimento por conexão (T31; 16 §3.2–3.3).
// Toda tabela tem company_id (SPEC 3.3) com índice começando por ele. `connection_id` referencia crm.connections
// (FK acrescentada pela T40; excluir a conexão remove o vínculo/horário).

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const DEFAULT_DEPARTMENT_COLOR = '#3B82F6'

export const departments = crm.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    color: text('color').notNull().default(DEFAULT_DEPARTMENT_COLOR),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('departments_company_name_idx').on(t.companyId, t.name)],
)

/** Departamentos do membro (escopo de chat). Nenhum = vê todos. */
export const memberDepartments = crm.table(
  'member_departments',
  {
    companyId: companyId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => companyMembers.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.departmentId] }), index('member_departments_company_dept_idx').on(t.companyId, t.departmentId)],
)

/** Conexões do membro (escopo de chat). Nenhuma = vê todas. */
export const memberConnections = crm.table(
  'member_connections',
  {
    companyId: companyId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => companyMembers.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.connectionId] }), index('member_connections_company_conn_idx').on(t.companyId, t.connectionId)],
)

export const BUSINESS_HOUR_ACTIONS = ['message', 'flow'] as const
export type BusinessHourAction = (typeof BUSINESS_HOUR_ACTIONS)[number]

/** Horário de atendimento de uma conexão e a ação fora do horário. */
export const businessHourConfigs = crm.table(
  'business_hour_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    active: boolean('active').notNull().default(false),
    actionType: text('action_type').$type<BusinessHourAction>().notNull().default('message'),
    messageText: text('message_text'),
    /** Fluxo fora do horário. Excluir um fluxo referenciado é bloqueado pela API (T28); a FK é a rede de segurança. */
    flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('business_hour_configs_company_connection_uq').on(t.companyId, t.connectionId),
    index('business_hour_configs_company_flow_idx').on(t.companyId, t.flowId),
    check('business_hour_configs_action_ck', sql`${t.actionType} in ('message', 'flow')`),
  ],
)

/** Intervalos `[start, end)` por dia da semana (0 = domingo). Horas em `HH:MM`; `24:00` = fim do dia. */
export const businessHours = crm.table(
  'business_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    configId: uuid('config_id')
      .notNull()
      .references(() => businessHourConfigs.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    active: boolean('active').notNull().default(true),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('business_hours_company_config_idx').on(t.companyId, t.configId, t.dayOfWeek),
    check('business_hours_day_ck', sql`${t.dayOfWeek} between 0 and 6`),
  ],
)

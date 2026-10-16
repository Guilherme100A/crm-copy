// Exportação dos leads de um quadro (T76; 04 §5.26 "Exportar leads em planilha"): kind `kanban_cards` da T27, com os
// mesmos filtros do quadro (etapa, etiquetas OU, responsável, atualizado de/até) e o escopo de chats do criador
// (T31/T48). O registro acontece ao carregar o módulo: API e worker importam o mesmo `@crm/core`.
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { chatLabels, chats, contacts, kanbanBoards, kanbanCards, kanbanColumns, labels, type Database } from '@crm/db'
import { actorScope, scopeCondition } from '../chats/query/context'
import { getExportKind, keysetPages, registerExportKind, type ExportQueryCtx } from '../exports/registry'
import { kanbanInvalid, kanbanNotFound } from './errors'

export const KANBAN_EXPORT_KIND = 'kanban_cards'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Filtros gravados no job (`filters` do `POST /api/jobs`). */
export interface KanbanExportFilters {
  crm_id: string
  column_id?: string
  label_ids?: string[]
  assigned_to?: string
  updated_from?: string
  updated_to?: string
}

export interface KanbanExportRow extends Record<string, unknown> {
  card_id: string
  column_position: number
  position: number
  name: string
  phone_e164: string | null
  column: string
  value_cents: number
  currency: string
  labels: string
  updated_at: Date
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function uuid(v: unknown, path: string): string | undefined {
  const s = str(v)
  if (s === undefined) return undefined
  if (!UUID_RE.test(s)) throw kanbanInvalid(path, 'Identificador inválido')
  return s
}

function date(v: unknown, path: string): string | undefined {
  const s = str(v)
  if (s !== undefined && Number.isNaN(new Date(s).getTime())) throw kanbanInvalid(path, 'Data inválida (ISO 8601)')
  return s
}

/** Valida e normaliza os filtros do job (lança `KanbanError` de validação). */
export function parseKanbanExportFilters(raw: Record<string, unknown>): KanbanExportFilters {
  const crm = uuid(raw.crm_id, 'crm_id')
  if (!crm) throw kanbanInvalid('crm_id', 'Informe o quadro')
  const rawLabels = Array.isArray(raw.label_ids) ? raw.label_ids : typeof raw.label_ids === 'string' ? raw.label_ids.split(',') : []
  const labelIds = [...new Set(rawLabels.map((v, i) => uuid(v, `label_ids.${i}`)).filter((v): v is string => !!v))]
  const assigned = str(raw.assigned_to)
  if (assigned && assigned !== 'me' && assigned !== 'none' && !UUID_RE.test(assigned)) throw kanbanInvalid('assigned_to', 'Responsável inválido')
  const from = date(raw.updated_from, 'updated_from')
  const to = date(raw.updated_to, 'updated_to')
  if (from && to && new Date(to) < new Date(from)) throw kanbanInvalid('updated_to', 'O fim do período é antes do início')
  const out: KanbanExportFilters = { crm_id: crm }
  const column = uuid(raw.column_id, 'column_id')
  if (column) out.column_id = column
  if (labelIds.length) out.label_ids = labelIds
  if (assigned) out.assigned_to = assigned
  if (from) out.updated_from = from
  if (to) out.updated_to = to
  return out
}

/** Condições dos cards exportados (empresa, quadro, escopo do criador e filtros). */
async function conditions(ctx: ExportQueryCtx): Promise<SQL[]> {
  const f = parseKanbanExportFilters(ctx.filters)
  const [board] = await ctx.db
    .select({ id: kanbanBoards.id })
    .from(kanbanBoards)
    .where(and(eq(kanbanBoards.id, f.crm_id), eq(kanbanBoards.companyId, ctx.companyId)))
    .limit(1)
  if (!board) throw kanbanNotFound('CRM')
  const scope = await actorScope(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, perms: new Set() })
  const conds: (SQL | undefined)[] = [eq(kanbanCards.companyId, ctx.companyId), eq(kanbanCards.crmId, board.id), scopeCondition(scope)]
  if (f.column_id) conds.push(eq(kanbanCards.columnId, f.column_id))
  if (f.updated_from) conds.push(gte(kanbanCards.updatedAt, new Date(f.updated_from)))
  if (f.updated_to) conds.push(lte(kanbanCards.updatedAt, new Date(f.updated_to)))
  if (f.assigned_to === 'me') conds.push(ctx.userId ? eq(chats.assignedUserId, ctx.userId) : sql`false`)
  else if (f.assigned_to === 'none') conds.push(isNull(chats.assignedUserId))
  else if (f.assigned_to) conds.push(eq(chats.assignedUserId, f.assigned_to))
  if (f.label_ids?.length)
    conds.push(sql`exists (select 1 from ${chatLabels} where ${chatLabels.chatId} = ${kanbanCards.chatId} and ${inArray(chatLabels.labelId, f.label_ids)})`)
  return conds.filter((c): c is SQL => c !== undefined)
}

async function labelNames(db: Database, chatIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!chatIds.length) return out
  const rows = await db
    .select({ chatId: chatLabels.chatId, name: labels.name })
    .from(chatLabels)
    .innerJoin(labels, eq(labels.id, chatLabels.labelId))
    .where(inArray(chatLabels.chatId, chatIds))
    .orderBy(asc(labels.name))
  for (const r of rows) out.set(r.chatId, [...(out.get(r.chatId) ?? []), r.name])
  return out
}

const valueCell = (cents: unknown) => (Number(cents || 0) / 100).toFixed(2)

/** Registra o kind (idempotente). */
export function ensureKanbanExportKind(): void {
  if (getExportKind(KANBAN_EXPORT_KIND)) return
  registerExportKind<KanbanExportRow>(KANBAN_EXPORT_KIND, {
    permission: 'kanban.view',
    fileName: (id) => `kanban_leads_${id}.csv`,
    columns: [
      { key: 'name', header: 'Nome' },
      { key: 'phone_e164', header: 'Telefone' },
      { key: 'column', header: 'Etapa' },
      { key: 'value_cents', header: 'Valor', format: valueCell },
      { key: 'currency', header: 'Moeda' },
      { key: 'labels', header: 'Etiquetas' },
      { key: 'updated_at', header: 'Atualizado em' },
    ],
    count: async (ctx) => {
      const [r] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(kanbanCards)
        .innerJoin(chats, eq(chats.id, kanbanCards.chatId))
        .where(and(...(await conditions(ctx))))
      return r?.n ?? 0
    },
    query: (ctx) => {
      let conds: SQL[] | null = null
      // Ordem do quadro (etapa, posição no card, id) com keyset nessa mesma tupla.
      return keysetPages<KanbanExportRow>(async (after, limit) => {
        conds ??= await conditions(ctx)
        const rows = await ctx.db
          .select({
            id: kanbanCards.id,
            chatId: kanbanCards.chatId,
            position: kanbanCards.position,
            valueCents: kanbanCards.valueCents,
            currency: kanbanCards.currency,
            updatedAt: kanbanCards.updatedAt,
            columnName: kanbanColumns.name,
            columnPosition: kanbanColumns.position,
            name: contacts.name,
            phone: contacts.phoneE164,
          })
          .from(kanbanCards)
          .innerJoin(kanbanColumns, eq(kanbanColumns.id, kanbanCards.columnId))
          .innerJoin(chats, eq(chats.id, kanbanCards.chatId))
          .innerJoin(contacts, eq(contacts.id, chats.contactId))
          .where(
            and(
              ...conds,
              after
                ? sql`(${kanbanColumns.position}, ${kanbanCards.position}, ${kanbanCards.id}) > (${after.column_position}, ${after.position}, ${after.card_id})`
                : undefined,
            ),
          )
          .orderBy(asc(kanbanColumns.position), asc(kanbanCards.position), asc(kanbanCards.id))
          .limit(limit)
        const names = await labelNames(ctx.db, [...new Set(rows.map((r) => r.chatId))])
        return rows.map((r) => ({
          card_id: r.id,
          column_position: r.columnPosition,
          position: r.position,
          name: r.name,
          phone_e164: r.phone,
          column: r.columnName,
          value_cents: r.valueCents,
          currency: r.currency,
          labels: (names.get(r.chatId) ?? []).join(' | '),
          updated_at: r.updatedAt,
        }))
      })
    },
  })
}

ensureKanbanExportKind()

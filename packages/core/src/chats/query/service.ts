// Lista de conversas (T48; 03 F01–F14): filtros, escopo da T31, cursor de 15 e contadores por aba.
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { CHAT_STATUSES, chatLabels, chats, companyMembers, contacts, departments, labels, messages, users, type ChatStatus, type Database } from '@crm/db'
import { foldText } from '../../departments'
import { toChatDto, type ChatDto, type ChatRow } from '../model/dto'
import { chatInvalid, chatNotFound } from '../lifecycle/errors'
import { actorScope, assertInScope, companyChats, scopeCondition, type ChatActor } from './context'

export const CHAT_PAGE_LIMIT = 15
export const CHAT_PAGE_MAX = 50
const ACCENTED = 'áàâãäåéèêëíìîïóòôõöúùûüçñý'
const PLAIN = 'aaaaaaeeeeiiiiooooouuuucny'

export interface ChatListQuery {
  status?: ChatStatus
  search?: string
  /** `me`, `none` ou um user_id. */
  assigned_to?: string
  response_status?: 'unanswered' | 'answered'
  read_status?: 'unread' | 'read'
  created_from?: string
  created_to?: string
  connection_ids?: string[]
  department_ids?: string[]
  label_ids?: string[]
  contact_id?: string
  cursor?: string
  limit?: number
}

export interface ChatListItem extends ChatDto {
  contact: { id: string; name: string; phone_e164: string | null; wa_lid: string | null }
  assigned_user: { id: string; name: string } | null
  label_ids: string[]
}

export type ChatCounts = Record<ChatStatus, number>

const sortAt = sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`

/** Texto de `timestamptz` do Postgres (`2026-10-16 03:00:00.123456+00`) ou ISO. */
const PG_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/

function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown }
    if (typeof v.t === 'string' && typeof v.id === 'string' && /^[0-9a-f-]{36}$/i.test(v.id) && PG_TS_RE.test(v.t)) return { t: v.t, id: v.id }
  } catch {
    // cai no erro abaixo
  }
  throw chatInvalid('cursor', 'Cursor inválido')
}

/** `t` é o texto exato do timestamp no Postgres (microssegundos), para o keyset não pular nem repetir linhas. */
const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString('base64url')

function parseDate(value: string | undefined, path: string): Date | undefined {
  if (value === undefined || value === '') return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw chatInvalid(path, 'Data inválida (ISO 8601)')
  return d
}

export class ChatQueryService {
  constructor(private readonly db: Database) {}

  /** Condições dos filtros (sem o status), já com escopo e empresa. */
  private async filters(actor: ChatActor, q: ChatListQuery): Promise<SQL[]> {
    const from = parseDate(q.created_from, 'created_from')
    const to = parseDate(q.created_to, 'created_to')
    if (from && !to) throw chatInvalid('created_to', 'Informe o fim do período')
    if (to && !from) throw chatInvalid('created_from', 'Informe o início do período')
    if (from && to && to < from) throw chatInvalid('created_to', 'O fim do período é antes do início')

    const scope = await actorScope(this.db, actor)
    const conds: (SQL | undefined)[] = [companyChats(actor.companyId), scopeCondition(scope)]
    if (from && to) conds.push(gte(chats.createdAt, from), lte(chats.createdAt, to))
    if (q.assigned_to === 'me') conds.push(actor.userId ? eq(chats.assignedUserId, actor.userId) : sql`false`)
    else if (q.assigned_to === 'none') conds.push(isNull(chats.assignedUserId))
    else if (q.assigned_to) conds.push(eq(chats.assignedUserId, q.assigned_to))
    if (q.read_status === 'unread') conds.push(sql`${chats.unreadCount} > 0`)
    if (q.read_status === 'read') conds.push(eq(chats.unreadCount, 0))
    if (q.connection_ids?.length) conds.push(inArray(chats.connectionId, q.connection_ids))
    if (q.department_ids?.length) conds.push(inArray(chats.departmentId, q.department_ids))
    if (q.contact_id) conds.push(eq(chats.contactId, q.contact_id))
    if (q.label_ids?.length)
      conds.push(sql`exists (select 1 from ${chatLabels} where ${chatLabels.chatId} = ${chats.id} and ${inArray(chatLabels.labelId, q.label_ids)})`)
    if (q.response_status) {
      // Última mensagem do chat (as notas internas ficam em outra tabela e não contam).
      const lastInbound = sql`(select ${messages.direction} from ${messages} where ${messages.chatId} = ${chats.id} order by ${messages.createdAt} desc, ${messages.id} desc limit 1) = 'inbound'`
      conds.push(q.response_status === 'unanswered' ? lastInbound : sql`not coalesce(${lastInbound}, false)`)
    }
    const term = q.search?.trim()
    if (term) {
      const name = foldText(term).replace(/[\\%_]/g, (c) => `\\${c}`)
      const digits = term.replace(/\D/g, '')
      const nameCond = sql`translate(lower(${contacts.name}), ${ACCENTED}, ${PLAIN}) like ${`%${name}%`}`
      const phoneCond = digits.length >= 3 ? sql`regexp_replace(coalesce(${contacts.phoneE164}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : undefined
      conds.push(sql`exists (select 1 from ${contacts} where ${contacts.id} = ${chats.contactId} and (${phoneCond ? or(nameCond, phoneCond) : nameCond}))`)
    }
    return conds.filter((c): c is SQL => c !== undefined)
  }

  async list(actor: ChatActor, q: ChatListQuery = {}): Promise<{ items: ChatListItem[]; next_cursor: string | null; counts: ChatCounts }> {
    const limit = Math.min(Math.max(1, q.limit ?? CHAT_PAGE_LIMIT), CHAT_PAGE_MAX)
    const conds = await this.filters(actor, q)
    const where = [...conds]
    if (q.status) where.push(eq(chats.status, q.status))
    if (q.cursor) {
      const c = decodeCursor(q.cursor)
      where.push(sql`(${sortAt}, ${chats.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`)
    }
    const rows = await this.db
      .select({ ...getTableColumns(chats), sortKey: sql<string>`(${sortAt})::text` })
      .from(chats)
      .where(and(...where))
      .orderBy(desc(sortAt), desc(chats.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const next = rows.length > limit && last ? encodeCursor(last.sortKey, last.id) : null
    return { items: await this.decorate(page.map(({ sortKey: _k, ...r }) => r)), next_cursor: next, counts: await this.countWhere(conds) }
  }

  /** Contadores por aba com os mesmos filtros (sem o de status) — AC-T48-06. */
  async counts(actor: ChatActor, q: ChatListQuery = {}): Promise<ChatCounts> {
    return this.countWhere(await this.filters(actor, q))
  }

  async get(actor: ChatActor, id: string): Promise<ChatListItem> {
    const row = await this.row(actor, id)
    return (await this.decorate([row]))[0]!
  }

  /** Linha do chat respeitando empresa e escopo (fora do escopo → 404). */
  async row(actor: ChatActor, id: string): Promise<ChatRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw chatNotFound()
    const [row] = await this.db.select().from(chats).where(and(companyChats(actor.companyId), eq(chats.id, id))).limit(1)
    if (!row) throw chatNotFound()
    assertInScope(await actorScope(this.db, actor), row)
    return row
  }

  /** Marca como lidos os chats do escopo (com os filtros da lista); devolve quantos mudaram. */
  async markAllRead(actor: ChatActor, q: ChatListQuery = {}): Promise<number> {
    const conds = await this.filters(actor, q)
    if (q.status) conds.push(eq(chats.status, q.status))
    const res = await this.db
      .update(chats)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(...conds, sql`${chats.unreadCount} > 0`))
      .returning({ id: chats.id })
    return res.length
  }

  /** Opções dos filtros (conexões com chats no escopo, departamentos, etiquetas, atendentes). */
  async filterOptions(actor: ChatActor) {
    const scope = await actorScope(this.db, actor)
    const [conns, deps, labs, members] = await Promise.all([
      this.db.selectDistinct({ id: chats.connectionId }).from(chats).where(and(companyChats(actor.companyId), scopeCondition(scope))),
      this.db
        .select({ id: departments.id, name: departments.name, color: departments.color })
        .from(departments)
        .where(and(eq(departments.companyId, actor.companyId), scope.departments === 'all' ? undefined : inArray(departments.id, scope.departments.length ? scope.departments : ['00000000-0000-0000-0000-000000000000'])))
        .orderBy(asc(departments.name)),
      this.db.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).where(eq(labels.companyId, actor.companyId)).orderBy(asc(labels.name)),
      this.db
        .select({ id: users.id, name: users.name })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(eq(companyMembers.companyId, actor.companyId))
        .orderBy(asc(users.name)),
    ])
    return { connections: conns.map((c) => c.id).sort(), departments: deps, labels: labs, users: members }
  }

  private async countWhere(conds: SQL[]): Promise<ChatCounts> {
    const rows = await this.db
      .select({ status: chats.status, n: sql<number>`count(*)::int` })
      .from(chats)
      .where(and(...conds))
      .groupBy(chats.status)
    const out = Object.fromEntries(CHAT_STATUSES.map((s) => [s, 0])) as ChatCounts
    for (const r of rows) out[r.status] = Number(r.n)
    return out
  }

  /** Acrescenta contato, atendente e etiquetas (3 consultas para a página toda). */
  async decorate(rows: ChatRow[]): Promise<ChatListItem[]> {
    if (!rows.length) return []
    const contactIds = [...new Set(rows.map((r) => r.contactId))]
    const userIds = [...new Set(rows.map((r) => r.assignedUserId).filter((x): x is string => !!x))]
    const [cs, us, ls] = await Promise.all([
      this.db.select({ id: contacts.id, name: contacts.name, phone_e164: contacts.phoneE164, wa_lid: contacts.waLid }).from(contacts).where(inArray(contacts.id, contactIds)),
      userIds.length ? this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : Promise.resolve([]),
      this.db.select({ chatId: chatLabels.chatId, labelId: chatLabels.labelId }).from(chatLabels).where(inArray(chatLabels.chatId, rows.map((r) => r.id))),
    ])
    const contactBy = new Map(cs.map((c) => [c.id, c]))
    const userBy = new Map(us.map((u) => [u.id, u]))
    return rows.map((r) => ({
      ...toChatDto(r),
      contact: contactBy.get(r.contactId) ?? { id: r.contactId, name: '', phone_e164: null, wa_lid: null },
      assigned_user: r.assignedUserId ? (userBy.get(r.assignedUserId) ?? null) : null,
      label_ids: ls.filter((l) => l.chatId === r.id).map((l) => l.labelId).sort(),
    }))
  }
}

// Kanban (T50; 04-kanban-crm.md §3, §5): quadros, colunas (0..n−1) e cards (um por chat por quadro, posição
// fracionária). Cards de chats fora do escopo do membro (T31/T48) não aparecem, não contam e não são editáveis.
// Mover card/coluna trava a linha do quadro: movimentos concorrentes no mesmo quadro não embaralham a ordem.
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, max, ne, sql, type SQL } from 'drizzle-orm'
import { chatLabels, chats, contacts, kanbanBoards, kanbanCards, kanbanColumns, type Database } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import { buildPageMeta, pageOffset, type PageMeta } from '@crm/shared'
import { actorScope, scopeCondition, type ChatActor } from '../chats/query/context'
import { scopeAllows, type ChatScope } from '../departments/scope'
import type { RealtimePublisher } from '../realtime/publisher'
import { KanbanError, kanbanInvalid, kanbanNotFound } from './errors'
import { centsToValue, funnelStats, type ColumnTotal, type FunnelStats } from './stats'

export const DEFAULT_COLUMNS = [
  { name: 'Novo', conversionGoal: false },
  { name: 'Qualificação', conversionGoal: false },
  { name: 'Ganho', conversionGoal: true },
] as const
export const ACCENT_COLOR_RE = /^#[0-9A-Fa-f]{6}$/
export const CARD_PAGE_LIMIT = 20
const POSITION_STEP = 1024
const MIN_GAP = 1e-6

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: string | null | undefined): v is string => !!v && UUID_RE.test(v)

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Exec = Database | Tx
type BoardRow = typeof kanbanBoards.$inferSelect
type ColumnRow = typeof kanbanColumns.$inferSelect
type CardRow = typeof kanbanCards.$inferSelect

export interface ColumnDto {
  id: string
  crm_id: string
  name: string
  position: number
  accent_color: string | null
  conversion_goal: boolean
  created_at: string
  updated_at: string
}

export interface BoardDto {
  id: string
  name: string
  columns: ColumnDto[]
  quantity_of_columns: number
  summary: { total_cards: number; total_value_cents: number; total_value: number; conversion_count: number; conversion_rate: number }
  created_at: string
  updated_at: string
}

export interface CardDto {
  id: string
  crm_id: string
  column_id: string
  chat_id: string
  position: number
  value_cents: number
  value: number
  currency: string
  chat: { status: string; unread_count: number; last_message_preview: string | null }
  customer: { name: string; phone_e164: string | null }
  label_ids: string[]
  created_at: string
  updated_at: string
}

export interface ColumnTotalsDto {
  column_id: string
  total_count: number
  total_value_cents: number
  total_value: number
}

export interface CardFilters {
  column_id?: string
  label_ids?: string[]
  /** `me`, `none` ou user_id (responsável do chat). */
  assigned_to?: string
  updated_from?: string
  updated_to?: string
}

export interface ColumnInput {
  name?: string
  accentColor?: string | null
  conversionGoal?: boolean
}

export interface KanbanServiceOptions {
  db: Database
  publisher?: RealtimePublisher
  logger?: Pick<Logger, 'warn'>
}

/** Ator de sistema (fluxos, webhooks): empresa inteira, sem escopo. */
export const systemActor = (companyId: string): ChatActor => ({ companyId, userId: null, perms: new Set() })

const toColumn = (c: ColumnRow): ColumnDto => ({
  id: c.id,
  crm_id: c.crmId,
  name: c.name,
  position: c.position,
  accent_color: c.accentColor,
  conversion_goal: c.conversionGoal,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
})

function assertColor(value: string | null | undefined) {
  if (value === undefined || value === null) return
  if (!ACCENT_COLOR_RE.test(value)) throw kanbanInvalid('accent_color', 'A cor deve estar no formato #RRGGBB')
}

function assertName(value: string | undefined, path = 'name'): string | undefined {
  if (value === undefined) return undefined
  const v = value.trim()
  if (!v) throw kanbanInvalid(path, 'Nome obrigatório')
  if (v.length > 120) throw kanbanInvalid(path, 'Nome muito longo')
  return v
}

function parseDate(value: string | undefined, path: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw kanbanInvalid(path, 'Data inválida (ISO 8601)')
  return d
}

export class KanbanService {
  private readonly db: Database
  private readonly opts: KanbanServiceOptions

  constructor(opts: KanbanServiceOptions) {
    this.db = opts.db
    this.opts = opts
  }

  // ---------------------------------------------------------------- quadros

  async listBoards(actor: ChatActor): Promise<BoardDto[]> {
    const boards = await this.db.select().from(kanbanBoards).where(eq(kanbanBoards.companyId, actor.companyId)).orderBy(asc(kanbanBoards.createdAt))
    const scope = await actorScope(this.db, actor)
    return Promise.all(boards.map((b) => this.boardDto(b, scope)))
  }

  async getBoard(actor: ChatActor, id: string): Promise<BoardDto> {
    return this.boardDto(await this.board(this.db, actor.companyId, id), await actorScope(this.db, actor))
  }

  /** Cria o quadro com as 3 colunas padrão (Novo, Qualificação, Ganho — esta de conversão). */
  async createBoard(actor: ChatActor, input: { name: string }): Promise<BoardDto> {
    const name = assertName(input.name)!
    const board = await this.db.transaction(async (tx) => {
      const [b] = await tx.insert(kanbanBoards).values({ companyId: actor.companyId, name }).returning()
      await tx
        .insert(kanbanColumns)
        .values(DEFAULT_COLUMNS.map((c, i) => ({ companyId: actor.companyId, crmId: b!.id, name: c.name, position: i, conversionGoal: c.conversionGoal })))
      return b!
    })
    await this.columnChanged(actor.companyId, board.id, null, 'created')
    return this.getBoard(actor, board.id)
  }

  async updateBoard(actor: ChatActor, id: string, input: { name?: string }): Promise<BoardDto> {
    const board = await this.board(this.db, actor.companyId, id)
    const name = assertName(input.name)
    if (name !== undefined) await this.db.update(kanbanBoards).set({ name, updatedAt: new Date() }).where(eq(kanbanBoards.id, board.id))
    return this.getBoard(actor, board.id)
  }

  async deleteBoard(actor: ChatActor, id: string): Promise<void> {
    const board = await this.board(this.db, actor.companyId, id)
    await this.db.delete(kanbanBoards).where(eq(kanbanBoards.id, board.id))
  }

  // ---------------------------------------------------------------- colunas

  async createColumn(actor: ChatActor, crmId: string, input: ColumnInput & { name: string }): Promise<ColumnDto> {
    const name = assertName(input.name)!
    assertColor(input.accentColor)
    const col = await this.db.transaction(async (tx) => {
      const board = await this.board(tx, actor.companyId, crmId, true)
      const [last] = await tx.select({ p: max(kanbanColumns.position) }).from(kanbanColumns).where(eq(kanbanColumns.crmId, board.id))
      const [row] = await tx
        .insert(kanbanColumns)
        .values({
          companyId: actor.companyId,
          crmId: board.id,
          name,
          position: (last?.p ?? -1) + 1,
          accentColor: input.accentColor ?? null,
          conversionGoal: input.conversionGoal ?? false,
        })
        .returning()
      await this.touchBoard(tx, board.id)
      return row!
    })
    await this.columnChanged(actor.companyId, crmId, col.id, 'created')
    return toColumn(col)
  }

  async updateColumn(actor: ChatActor, crmId: string, columnId: string, input: ColumnInput): Promise<ColumnDto> {
    const name = assertName(input.name)
    assertColor(input.accentColor)
    const col = await this.column(this.db, actor.companyId, crmId, columnId)
    const [row] = await this.db
      .update(kanbanColumns)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
        ...(input.conversionGoal !== undefined ? { conversionGoal: input.conversionGoal } : {}),
        updatedAt: new Date(),
      })
      .where(eq(kanbanColumns.id, col.id))
      .returning()
    await this.columnChanged(actor.companyId, crmId, col.id, 'updated')
    return toColumn(row!)
  }

  /** Exclui a coluna e os cards dela (FK cascade) e recompacta as posições 0..n−1. */
  async deleteColumn(actor: ChatActor, crmId: string, columnId: string): Promise<{ deletedCards: number }> {
    const deleted = await this.db.transaction(async (tx) => {
      const board = await this.board(tx, actor.companyId, crmId, true)
      const col = await this.column(tx, actor.companyId, board.id, columnId)
      const [n] = await tx.select({ n: count() }).from(kanbanCards).where(eq(kanbanCards.columnId, col.id))
      await tx.delete(kanbanColumns).where(eq(kanbanColumns.id, col.id))
      await this.compact(tx, board.id)
      await this.touchBoard(tx, board.id)
      return Number(n?.n ?? 0)
    })
    await this.columnChanged(actor.companyId, crmId, columnId, 'deleted')
    return { deletedCards: deleted }
  }

  /** Move a coluna para `position` (limitada a 0..n−1) e recompacta o resto. */
  async moveColumn(actor: ChatActor, crmId: string, columnId: string, position: number): Promise<ColumnDto[]> {
    if (!Number.isInteger(position) || position < 0) throw kanbanInvalid('position', 'Posição inválida')
    const cols = await this.db.transaction(async (tx) => {
      const board = await this.board(tx, actor.companyId, crmId, true)
      const list = await this.columns(tx, board.id)
      const moving = list.find((c) => c.id === columnId)
      if (!moving) throw kanbanNotFound('Coluna')
      const rest = list.filter((c) => c.id !== columnId)
      rest.splice(Math.min(position, rest.length), 0, moving)
      for (const [i, c] of rest.entries()) if (c.position !== i) await tx.update(kanbanColumns).set({ position: i, updatedAt: new Date() }).where(eq(kanbanColumns.id, c.id))
      await this.touchBoard(tx, board.id)
      return this.columns(tx, board.id)
    })
    await this.columnChanged(actor.companyId, crmId, columnId, 'moved')
    return cols.map(toColumn)
  }

  // ---------------------------------------------------------------- cards

  /** Cards do quadro com filtros; totais por coluna (todas as colunas, com os filtros exceto `column_id`). */
  async listCards(
    actor: ChatActor,
    crmId: string,
    filters: CardFilters & { page?: number; limit?: number },
  ): Promise<{ items: CardDto[]; page: PageMeta; columns: ColumnTotalsDto[] }> {
    const board = await this.board(this.db, actor.companyId, crmId)
    const scope = await actorScope(this.db, actor)
    const conds = this.cardConds(actor, board.id, scope, filters)
    if (filters.column_id !== undefined) {
      if (!isUuid(filters.column_id)) throw kanbanInvalid('column_id', 'Coluna inválida')
      conds.push(eq(kanbanCards.columnId, filters.column_id))
    }
    const where = and(...conds)
    const page = { page: filters.page ?? 1, limit: filters.limit ?? CARD_PAGE_LIMIT }
    const [total] = await this.db.select({ n: count() }).from(kanbanCards).innerJoin(chats, eq(chats.id, kanbanCards.chatId)).where(where)
    const rows = await this.cardRows(where)
      .orderBy(asc(kanbanColumns.position), asc(kanbanCards.position), asc(kanbanCards.id))
      .limit(page.limit)
      .offset(pageOffset(page))
    return {
      items: await this.decorate(rows),
      page: buildPageMeta(page, { total: Number(total?.n ?? 0) }),
      columns: (await this.columnTotals(actor, board.id, scope, filters)).map((t) => ({
        column_id: t.column_id,
        total_count: t.total_count,
        total_value_cents: t.total_value_cents,
        total_value: centsToValue(t.total_value_cents),
      })),
    }
  }

  async getCard(actor: ChatActor, crmId: string, cardId: string): Promise<CardDto> {
    const card = await this.card(this.db, actor, crmId, cardId)
    return (await this.decorate(await this.cardRows(eq(kanbanCards.id, card.id))))[0]!
  }

  /** Cria o card do chat (com escopo do ator). Chat que já tem card no quadro → 409 `card_exists`. */
  async createCard(actor: ChatActor, crmId: string, input: { chatId: string; columnId?: string | null; valueCents?: number }): Promise<CardDto> {
    if (input.valueCents !== undefined) assertCents(input.valueCents)
    const chat = await this.chatInScope(actor, input.chatId)
    const card = await this.db.transaction(async (tx) => {
      const board = await this.board(tx, actor.companyId, crmId, true)
      const column = input.columnId ? await this.columnOrInvalid(tx, actor.companyId, board.id, input.columnId) : (await this.columns(tx, board.id))[0]
      if (!column) throw kanbanInvalid('column_id', 'O quadro não tem colunas')
      const [dup] = await tx
        .select({ id: kanbanCards.id })
        .from(kanbanCards)
        .where(and(eq(kanbanCards.crmId, board.id), eq(kanbanCards.chatId, chat.id)))
        .limit(1)
      if (dup) throw new KanbanError('conflict', 'O chat já tem um card neste quadro', 'card_exists', { card_id: dup.id })
      const [row] = await tx
        .insert(kanbanCards)
        .values({
          companyId: actor.companyId,
          crmId: board.id,
          columnId: column.id,
          chatId: chat.id,
          position: await this.endPosition(tx, column.id),
          valueCents: input.valueCents ?? 0,
        })
        .returning()
      await this.touchBoard(tx, board.id)
      return row!
    })
    await this.cardEvent(actor.companyId, 'kanban.card.created', card, chat)
    return this.getCard(actor, crmId, card.id)
  }

  async updateCard(actor: ChatActor, crmId: string, cardId: string, input: { valueCents?: number; currency?: string }): Promise<CardDto> {
    if (input.valueCents !== undefined) assertCents(input.valueCents)
    if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) throw kanbanInvalid('currency', 'Moeda inválida (ISO 4217)')
    const card = await this.card(this.db, actor, crmId, cardId)
    const [row] = await this.db
      .update(kanbanCards)
      .set({
        ...(input.valueCents !== undefined ? { valueCents: input.valueCents } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, card.id))
      .returning()
    await this.cardEvent(actor.companyId, 'kanban.card.updated', row!)
    return this.getCard(actor, crmId, card.id)
  }

  async deleteCard(actor: ChatActor, crmId: string, cardId: string): Promise<void> {
    const card = await this.card(this.db, actor, crmId, cardId)
    await this.db.delete(kanbanCards).where(eq(kanbanCards.id, card.id))
    await this.cardEvent(actor.companyId, 'kanban.card.deleted', card)
  }

  /**
   * Move o card para `columnId`, antes de `beforeCardId` (ou no fim). Posição fracionária entre os vizinhos; se o
   * espaço acabar, a coluna é renumerada. Tudo numa transação com a trava do quadro.
   */
  async moveCard(actor: ChatActor, crmId: string, cardId: string, input: { columnId: string; beforeCardId?: string | null }): Promise<CardDto> {
    const before = await this.card(this.db, actor, crmId, cardId)
    const moved = await this.db.transaction(async (tx) => {
      const board = await this.board(tx, actor.companyId, crmId, true)
      const column = await this.columnOrInvalid(tx, actor.companyId, board.id, input.columnId)
      let position: number
      if (input.beforeCardId) {
        if (input.beforeCardId === before.id) throw kanbanInvalid('before_card_id', 'O card não pode ficar antes de si mesmo')
        position = await this.positionBefore(tx, column.id, input.beforeCardId, before.id)
      } else {
        position = await this.endPosition(tx, column.id, before.id)
      }
      const [row] = await tx
        .update(kanbanCards)
        .set({ columnId: column.id, position, updatedAt: new Date() })
        .where(eq(kanbanCards.id, before.id))
        .returning()
      await this.touchBoard(tx, board.id)
      return row!
    })
    await this.cardEvent(actor.companyId, 'kanban.card.moved', moved, undefined, before.columnId)
    return this.getCard(actor, crmId, moved.id)
  }

  /** Totais por coluna (para o cliente atualizar contagens depois de mover). */
  async totals(actor: ChatActor, crmId: string, filters: CardFilters = {}): Promise<ColumnTotalsDto[]> {
    const board = await this.board(this.db, actor.companyId, crmId)
    const scope = await actorScope(this.db, actor)
    return (await this.columnTotals(actor, board.id, scope, filters)).map((t) => ({
      column_id: t.column_id,
      total_count: t.total_count,
      total_value_cents: t.total_value_cents,
      total_value: centsToValue(t.total_value_cents),
    }))
  }

  /** Chats da empresa (no escopo) sem card neste quadro, com busca por nome/telefone/mensagem. */
  async availableChats(actor: ChatActor, crmId: string, q: { search?: string; page?: number; limit?: number }) {
    const board = await this.board(this.db, actor.companyId, crmId)
    const scope = await actorScope(this.db, actor)
    const conds: (SQL | undefined)[] = [
      eq(chats.companyId, actor.companyId),
      scopeCondition(scope),
      sql`not exists (select 1 from ${kanbanCards} where ${kanbanCards.crmId} = ${board.id} and ${kanbanCards.chatId} = ${chats.id})`,
    ]
    const term = q.search?.trim()
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      const digits = term.replace(/\D/g, '')
      conds.push(
        sql`(${contacts.name} ilike ${like} or coalesce(${chats.lastMessagePreview}, '') ilike ${like}${digits.length >= 3 ? sql` or coalesce(${contacts.phoneE164}, '') like ${`%${digits}%`}` : sql``})`,
      )
    }
    const where = and(...conds)
    const page = { page: q.page ?? 1, limit: q.limit ?? CARD_PAGE_LIMIT }
    const [total] = await this.db.select({ n: count() }).from(chats).innerJoin(contacts, eq(contacts.id, chats.contactId)).where(where)
    const rows = await this.db
      .select({ id: chats.id, name: contacts.name, phone: contacts.phoneE164, status: chats.status, unread: chats.unreadCount, preview: chats.lastMessagePreview })
      .from(chats)
      .innerJoin(contacts, eq(contacts.id, chats.contactId))
      .where(where)
      .orderBy(desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`), asc(chats.id))
      .limit(page.limit)
      .offset(pageOffset(page))
    return {
      items: rows.map((r) => ({ id: r.id, customer_name: r.name, customer_phone: r.phone, status: r.status, unread_count: r.unread, last_message_preview: r.preview })),
      page: buildPageMeta(page, { total: Number(total?.n ?? 0) }),
    }
  }

  /** Funil do quadro (04 §3.6) a partir dos totais por coluna com os filtros. */
  async stats(actor: ChatActor, crmId: string, filters: CardFilters = {}): Promise<FunnelStats> {
    const board = await this.board(this.db, actor.companyId, crmId)
    return funnelStats(await this.columnTotals(actor, board.id, await actorScope(this.db, actor), filters))
  }

  /**
   * Coloca o chat no quadro/coluna (cria o card ou move o existente para o fim da coluna); `columnId: null` tira o
   * chat do quadro; `undefined` = 1ª coluna ao criar, sem mover se já existe. Usado por `PATCH /api/chats/:id`.
   */
  async setChatColumn(actor: ChatActor, chatId: string, crmId: string, columnId: string | null | undefined): Promise<CardDto | null> {
    const chat = await this.chatInScope(actor, chatId)
    const board = await this.board(this.db, actor.companyId, crmId)
    const [existing] = await this.db
      .select()
      .from(kanbanCards)
      .where(and(eq(kanbanCards.crmId, board.id), eq(kanbanCards.chatId, chat.id)))
      .limit(1)
    if (columnId === null) {
      if (existing) await this.deleteCard(actor, board.id, existing.id)
      return null
    }
    // Sem coluna: cria na primeira; se já tem card, mantém onde está.
    if (!existing) return this.createCard(actor, board.id, { chatId: chat.id, columnId: columnId ?? null })
    if (columnId === undefined || existing.columnId === columnId) return this.getCard(actor, board.id, existing.id)
    return this.moveCard(actor, board.id, existing.id, { columnId })
  }

  // ---------------------------------------------------------------- internos

  private async board(exec: Exec, companyId: string, id: string, lock = false): Promise<BoardRow> {
    if (!isUuid(id)) throw kanbanNotFound('Quadro')
    const q = exec
      .select()
      .from(kanbanBoards)
      .where(and(eq(kanbanBoards.id, id), eq(kanbanBoards.companyId, companyId)))
    const [row] = lock ? await q.for('update') : await q
    if (!row) throw kanbanNotFound('Quadro')
    return row
  }

  private columns(exec: Exec, crmId: string): Promise<ColumnRow[]> {
    return exec.select().from(kanbanColumns).where(eq(kanbanColumns.crmId, crmId)).orderBy(asc(kanbanColumns.position), asc(kanbanColumns.createdAt))
  }

  private async column(exec: Exec, companyId: string, crmId: string, id: string): Promise<ColumnRow> {
    if (!isUuid(id)) throw kanbanNotFound('Coluna')
    const [row] = await exec
      .select()
      .from(kanbanColumns)
      .where(and(eq(kanbanColumns.id, id), eq(kanbanColumns.crmId, crmId), eq(kanbanColumns.companyId, companyId)))
    if (!row) throw kanbanNotFound('Coluna')
    return row
  }

  /** Coluna de destino informada no corpo: inexistente ou de outro quadro → 422. */
  private async columnOrInvalid(exec: Exec, companyId: string, crmId: string, id: string): Promise<ColumnRow> {
    try {
      return await this.column(exec, companyId, crmId, id)
    } catch (err) {
      if (err instanceof KanbanError && err.kind === 'not_found') throw kanbanInvalid('column_id', 'Coluna não pertence a este quadro')
      throw err
    }
  }

  private async compact(tx: Tx, crmId: string) {
    for (const [i, c] of (await this.columns(tx, crmId)).entries())
      if (c.position !== i) await tx.update(kanbanColumns).set({ position: i, updatedAt: new Date() }).where(eq(kanbanColumns.id, c.id))
  }

  private touchBoard(tx: Tx, crmId: string) {
    return tx.update(kanbanBoards).set({ updatedAt: new Date() }).where(eq(kanbanBoards.id, crmId))
  }

  private async endPosition(exec: Exec, columnId: string, excludeCardId?: string): Promise<number> {
    const [last] = await exec
      .select({ p: max(kanbanCards.position) })
      .from(kanbanCards)
      .where(and(eq(kanbanCards.columnId, columnId), excludeCardId ? ne(kanbanCards.id, excludeCardId) : undefined))
    return (last?.p ?? 0) + POSITION_STEP
  }

  /** Posição logo antes de `beforeId` na coluna (renumera a coluna se não houver espaço). */
  private async positionBefore(tx: Tx, columnId: string, beforeId: string, movingId: string): Promise<number> {
    const find = async () => {
      const [target] = await tx
        .select({ position: kanbanCards.position })
        .from(kanbanCards)
        .where(and(eq(kanbanCards.id, beforeId), eq(kanbanCards.columnId, columnId)))
      if (!target) throw kanbanInvalid('before_card_id', 'O card de referência não está nesta coluna')
      const [prev] = await tx
        .select({ p: max(kanbanCards.position) })
        .from(kanbanCards)
        .where(and(eq(kanbanCards.columnId, columnId), lt(kanbanCards.position, target.position), ne(kanbanCards.id, movingId)))
      return { target: target.position, prev: prev?.p ?? null }
    }
    let { target, prev } = await find()
    if (prev === null) return target - POSITION_STEP
    if (target - prev < MIN_GAP) {
      const cards = await tx.select({ id: kanbanCards.id }).from(kanbanCards).where(eq(kanbanCards.columnId, columnId)).orderBy(asc(kanbanCards.position), asc(kanbanCards.id))
      for (const [i, c] of cards.entries()) await tx.update(kanbanCards).set({ position: (i + 1) * POSITION_STEP }).where(eq(kanbanCards.id, c.id))
      ;({ target, prev } = await find())
      if (prev === null) return target - POSITION_STEP
    }
    return (prev + target) / 2
  }

  /** Card do quadro cujo chat está no escopo do ator (fora do escopo = inexistente). */
  private async card(exec: Exec, actor: ChatActor, crmId: string, id: string): Promise<CardRow> {
    const board = await this.board(exec, actor.companyId, crmId)
    if (!isUuid(id)) throw kanbanNotFound('Card')
    const [row] = await exec
      .select({ card: kanbanCards, departmentId: chats.departmentId, connectionId: chats.connectionId })
      .from(kanbanCards)
      .innerJoin(chats, eq(chats.id, kanbanCards.chatId))
      .where(and(eq(kanbanCards.id, id), eq(kanbanCards.crmId, board.id), eq(kanbanCards.companyId, actor.companyId)))
    if (!row) throw kanbanNotFound('Card')
    const scope = await actorScope(this.db, actor)
    if (!scopeAllows(scope, { department_id: row.departmentId, connection_id: row.connectionId })) throw kanbanNotFound('Card')
    return row.card
  }

  private async chatInScope(actor: ChatActor, chatId: string) {
    if (!isUuid(chatId)) throw kanbanNotFound('Chat')
    const [chat] = await this.db
      .select({ id: chats.id, departmentId: chats.departmentId, connectionId: chats.connectionId })
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.companyId, actor.companyId)))
    if (!chat) throw kanbanNotFound('Chat')
    const scope = await actorScope(this.db, actor)
    if (!scopeAllows(scope, { department_id: chat.departmentId, connection_id: chat.connectionId })) throw kanbanNotFound('Chat')
    return chat
  }

  /** Condições dos cards do quadro (empresa, escopo do chat e filtros, exceto `column_id`). */
  private cardConds(actor: ChatActor, crmId: string, scope: ChatScope, f: CardFilters): SQL[] {
    const from = parseDate(f.updated_from, 'updated_from')
    const to = parseDate(f.updated_to, 'updated_to')
    if (from && to && to < from) throw kanbanInvalid('updated_to', 'O fim do período é antes do início')
    const conds: (SQL | undefined)[] = [eq(kanbanCards.companyId, actor.companyId), eq(kanbanCards.crmId, crmId), scopeCondition(scope)]
    if (from) conds.push(gte(kanbanCards.updatedAt, from))
    if (to) conds.push(lte(kanbanCards.updatedAt, to))
    if (f.assigned_to === 'me') conds.push(actor.userId ? eq(chats.assignedUserId, actor.userId) : sql`false`)
    else if (f.assigned_to === 'none') conds.push(isNull(chats.assignedUserId))
    else if (f.assigned_to) {
      if (!isUuid(f.assigned_to)) throw kanbanInvalid('assigned_to', 'Responsável inválido')
      conds.push(eq(chats.assignedUserId, f.assigned_to))
    }
    if (f.label_ids?.length) {
      const bad = f.label_ids.findIndex((id) => !isUuid(id))
      if (bad >= 0) throw kanbanInvalid(`label_ids.${bad}`, 'Etiqueta inválida')
      // Qualquer uma das etiquetas (OU), 04 §5.22.
      conds.push(sql`exists (select 1 from ${chatLabels} where ${chatLabels.chatId} = ${kanbanCards.chatId} and ${inArray(chatLabels.labelId, f.label_ids)})`)
    }
    return conds.filter((c): c is SQL => c !== undefined)
  }

  private async columnTotals(actor: ChatActor, crmId: string, scope: ChatScope, filters: CardFilters): Promise<ColumnTotal[]> {
    const cols = await this.columns(this.db, crmId)
    const rows = await this.db
      .select({ columnId: kanbanCards.columnId, n: count(), v: sql<string>`coalesce(sum(${kanbanCards.valueCents}), 0)` })
      .from(kanbanCards)
      .innerJoin(chats, eq(chats.id, kanbanCards.chatId))
      .where(and(...this.cardConds(actor, crmId, scope, filters)))
      .groupBy(kanbanCards.columnId)
    const by = new Map(rows.map((r) => [r.columnId, r]))
    return cols.map((c) => ({
      column_id: c.id,
      name: c.name,
      position: c.position,
      conversion_goal: c.conversionGoal,
      total_count: Number(by.get(c.id)?.n ?? 0),
      total_value_cents: Number(by.get(c.id)?.v ?? 0),
    }))
  }

  private cardRows(where: SQL | undefined) {
    return this.db
      .select({
        card: kanbanCards,
        status: chats.status,
        unread: chats.unreadCount,
        preview: chats.lastMessagePreview,
        name: contacts.name,
        phone: contacts.phoneE164,
      })
      .from(kanbanCards)
      .innerJoin(chats, eq(chats.id, kanbanCards.chatId))
      .innerJoin(contacts, eq(contacts.id, chats.contactId))
      .innerJoin(kanbanColumns, eq(kanbanColumns.id, kanbanCards.columnId))
      .where(where)
  }

  private async decorate(rows: Awaited<ReturnType<KanbanService['cardRows']>>): Promise<CardDto[]> {
    const chatIds = [...new Set(rows.map((r) => r.card.chatId))]
    const ls = chatIds.length ? await this.db.select().from(chatLabels).where(inArray(chatLabels.chatId, chatIds)) : []
    return rows.map((r) => ({
      id: r.card.id,
      crm_id: r.card.crmId,
      column_id: r.card.columnId,
      chat_id: r.card.chatId,
      position: r.card.position,
      value_cents: r.card.valueCents,
      value: centsToValue(r.card.valueCents),
      currency: r.card.currency,
      chat: { status: r.status, unread_count: r.unread, last_message_preview: r.preview },
      customer: { name: r.name, phone_e164: r.phone },
      label_ids: ls.filter((l) => l.chatId === r.card.chatId).map((l) => l.labelId).sort(),
      created_at: r.card.createdAt.toISOString(),
      updated_at: r.card.updatedAt.toISOString(),
    }))
  }

  private async boardDto(b: BoardRow, scope: ChatScope): Promise<BoardDto> {
    const cols = await this.columns(this.db, b.id)
    const totals = await this.columnTotals(systemActor(b.companyId), b.id, scope, {})
    const stats = funnelStats(totals)
    const totalValue = totals.reduce((s, c) => s + c.total_value_cents, 0)
    return {
      id: b.id,
      name: b.name,
      columns: cols.map(toColumn),
      quantity_of_columns: cols.length,
      summary: {
        total_cards: stats.total_cards,
        total_value_cents: totalValue,
        total_value: centsToValue(totalValue),
        conversion_count: stats.conversion_count,
        conversion_rate: stats.conversion_rate,
      },
      created_at: b.createdAt.toISOString(),
      updated_at: b.updatedAt.toISOString(),
    }
  }

  /** `kanban.card.*` para a empresa, com o escopo do chat (membro fora do escopo não recebe). */
  private async cardEvent(
    companyId: string,
    type: 'kanban.card.created' | 'kanban.card.updated' | 'kanban.card.moved' | 'kanban.card.deleted',
    card: CardRow,
    chat?: { departmentId: string | null; connectionId: string },
    fromColumnId?: string,
  ) {
    if (!this.opts.publisher) return
    let scope = chat
    if (!scope) {
      const [c] = await this.db.select({ departmentId: chats.departmentId, connectionId: chats.connectionId }).from(chats).where(eq(chats.id, card.chatId))
      scope = c
    }
    await this.opts.publisher
      .publish(
        companyId,
        type,
        { crm_id: card.crmId, card_id: card.id, chat_id: card.chatId, column_id: card.columnId, ...(fromColumnId ? { from_column_id: fromColumnId } : {}) },
        scope ? { scope: { connection_id: scope.connectionId, department_id: scope.departmentId } } : {},
      )
      .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
  }

  private async columnChanged(companyId: string, crmId: string, columnId: string | null, action: 'created' | 'updated' | 'deleted' | 'moved') {
    await this.opts.publisher
      ?.publish(companyId, 'kanban.column.changed', { crm_id: crmId, column_id: columnId, action })
      .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
  }
}

function assertCents(v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw kanbanInvalid('value_cents', 'Valor em centavos deve ser inteiro ≥ 0')
}

/**
 * Para fluxos e webhooks (`create_kanban_card`): cria o card como sistema (sem escopo). Se o chat já tem card no
 * quadro, move para a coluna pedida (idempotente para reentradas do fluxo).
 */
export async function createKanbanCard(
  service: KanbanService,
  ctx: { companyId: string },
  input: { crmId: string; columnId?: string | null; chatId: string; valueCents?: number },
): Promise<CardDto> {
  const actor = systemActor(ctx.companyId)
  try {
    return await service.createCard(actor, input.crmId, input)
  } catch (err) {
    if (err instanceof KanbanError && err.errorCode === 'card_exists' && input.columnId) {
      const card = (await service.setChatColumn(actor, input.chatId, input.crmId, input.columnId))!
      if (input.valueCents !== undefined) return service.updateCard(actor, input.crmId, card.id, { valueCents: input.valueCents })
      return card
    }
    throw err
  }
}

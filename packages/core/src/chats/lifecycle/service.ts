// Ciclo de vida do chat (T48; 03 F15–F22, F52–F57): atribuir, resolver, reabrir, bloquear, transferir,
// notas internas (só CRM, nunca o gateway), etiquetas e linha do tempo (`chat_events`).
import { and, desc, eq, inArray } from 'drizzle-orm'
import { aiAgents, chatEvents, chatLabels, chatNotes, chats, companyMembers, contacts, departments, labels, users, type ChatStatus, type Database } from '@crm/db'
import type { ChatPublisher } from '../ingest/chat-ingest'
import { chatScope, type ChatRow } from '../model/dto'
import { ChatQueryService, type ChatListItem } from '../query/service'
import type { ChatActor } from '../query/context'
import { chatInvalid, ChatsError } from './errors'
import { emitChatResolved } from './hooks'

export const NOTE_MAX = 5000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChatAction = 'assign' | 'unassign' | 'resolve' | 'reopen' | 'block' | 'unblock'

/** Transições válidas por ação (AC-T48-03); o resto é 409. */
export const CHAT_TRANSITIONS: Record<Exclude<ChatAction, 'block' | 'unblock'>, readonly ChatStatus[]> = {
  assign: ['waiting', 'attending'],
  unassign: ['attending'],
  resolve: ['waiting', 'attending'],
  reopen: ['resolved'],
}

export interface NoteDto {
  id: string
  chat_id: string
  body: string
  author: { id: string; name: string } | null
  created_at: string
}

export interface ChatEventDto {
  id: string
  type: string
  actor: { id: string; name: string } | null
  detail: Record<string, unknown> | null
  created_at: string
}

export interface ChatLifecycleOptions {
  db: Database
  publisher?: ChatPublisher
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export class ChatLifecycleService {
  private readonly db: Database
  private readonly publisher?: ChatPublisher
  readonly query: ChatQueryService

  constructor(opts: ChatLifecycleOptions) {
    this.db = opts.db
    this.publisher = opts.publisher
    this.query = new ChatQueryService(opts.db)
  }

  /** Abre (ou devolve) o chat do contato na conexão. */
  async open(actor: ChatActor, input: { contact_id: string; connection_id: string }): Promise<{ chat: ChatListItem; created: boolean }> {
    if (!UUID_RE.test(input.contact_id ?? '')) throw chatInvalid('contact_id', 'Contato inválido')
    if (!UUID_RE.test(input.connection_id ?? '')) throw chatInvalid('connection_id', 'Conexão inválida')
    const [contact] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, actor.companyId), eq(contacts.id, input.contact_id)))
      .limit(1)
    if (!contact) throw chatInvalid('contact_id', 'Contato não encontrado')
    const [inserted] = await this.db
      .insert(chats)
      .values({ companyId: actor.companyId, contactId: input.contact_id, connectionId: input.connection_id })
      .onConflictDoNothing({ target: [chats.companyId, chats.connectionId, chats.contactId] })
      .returning()
    if (inserted) {
      await this.event(this.db, inserted, actor, 'created', null)
      const chat = await this.query.get(actor, inserted.id)
      await this.publish(inserted, 'chat.created', { chat_id: inserted.id, chat })
      return { chat, created: true }
    }
    const [existing] = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.companyId, actor.companyId), eq(chats.connectionId, input.connection_id), eq(chats.contactId, input.contact_id)))
    return { chat: await this.query.get(actor, existing!.id), created: false }
  }

  /** Aceitar/assumir/atribuir. Atribuir a outro ou tirar de outro atendente exige `chat.assign_others`. */
  async assign(actor: ChatActor, chatId: string, input: { user_id?: string | null } = {}): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    const target = input.user_id ?? actor.userId
    if (!target) throw chatInvalid('user_id', 'Informe o atendente')
    this.assertTransition(chat, 'assign')
    const takingFromOther = chat.assignedUserId !== null && chat.assignedUserId !== target
    if ((target !== actor.userId || takingFromOther) && !actor.perms.has('chat.assign_others'))
      throw new ChatsError('forbidden', 'Sem permissão para atribuir chats de outros atendentes', { permission: 'chat.assign_others' })
    await this.assertMember(actor.companyId, target)
    return this.mutate(actor, chat, { status: 'attending', assignedUserId: target }, 'assigned', { from: chat.assignedUserId, to: target })
  }

  async unassign(actor: ChatActor, chatId: string): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    this.assertTransition(chat, 'unassign')
    if (!chat.assignedUserId) throw new ChatsError('invalid_transition', 'O chat não tem atendente', { from: chat.status, action: 'unassign' })
    if (chat.assignedUserId !== actor.userId && !actor.perms.has('chat.assign_others'))
      throw new ChatsError('forbidden', 'Sem permissão para tirar o chat de outro atendente', { permission: 'chat.assign_others' })
    return this.mutate(actor, chat, { status: 'waiting', assignedUserId: null }, 'unassigned', { from: chat.assignedUserId })
  }

  async resolve(actor: ChatActor, chatId: string): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    this.assertTransition(chat, 'resolve')
    const resolved = await this.mutate(actor, chat, { status: 'resolved', resolvedAt: new Date() }, 'resolved', { from: chat.status })
    // T120: "atendimento finalizado" (T61) e outros ouvintes, depois do commit.
    await emitChatResolved({ companyId: actor.companyId, chatId: chat.id, actorUserId: actor.userId ?? null })
    return resolved
  }

  /** resolved → waiting, sem atendente (AC-T48-03). */
  async reopen(actor: ChatActor, chatId: string): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    this.assertTransition(chat, 'reopen')
    return this.mutate(actor, chat, { status: 'waiting', resolvedAt: null, assignedUserId: null, openedAt: new Date() }, 'reopened', null)
  }

  async block(actor: ChatActor, chatId: string, blocked: boolean): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    if (chat.blocked === blocked)
      throw new ChatsError('invalid_transition', blocked ? 'O contato já está bloqueado' : 'O contato não está bloqueado', { action: blocked ? 'block' : 'unblock' })
    return this.mutate(actor, chat, { blocked }, blocked ? 'blocked' : 'unblocked', null)
  }

  /** Transferência (departamento) e agente de IA. Publica com o escopo NOVO: quem perde o escopo deixa de ver (AC-T48-04). */
  async update(actor: ChatActor, chatId: string, input: { department_id?: string | null; ai_agent_id?: string | null }): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    const patch: Partial<typeof chats.$inferInsert> = {}
    const changes: [string, Record<string, unknown>][] = []
    if (input.department_id !== undefined && input.department_id !== chat.departmentId) {
      if (input.department_id !== null) await this.assertOwned(departments, actor.companyId, input.department_id, 'department_id', 'Departamento')
      patch.departmentId = input.department_id
      changes.push(['transferred', { from: chat.departmentId, to: input.department_id }])
    }
    if (input.ai_agent_id !== undefined && input.ai_agent_id !== chat.aiAgentId) {
      if (input.ai_agent_id !== null) await this.assertOwned(aiAgents, actor.companyId, input.ai_agent_id, 'ai_agent_id', 'Agente')
      patch.aiAgentId = input.ai_agent_id
      changes.push(['ai_agent_changed', { from: chat.aiAgentId, to: input.ai_agent_id }])
    }
    if (!changes.length) return this.query.get(actor, chatId)
    return this.mutate(actor, chat, patch, changes)
  }

  async delete(actor: ChatActor, chatId: string): Promise<void> {
    const chat = await this.query.row(actor, chatId)
    await this.db.delete(chats).where(and(eq(chats.companyId, actor.companyId), eq(chats.id, chat.id)))
    await this.publish(chat, 'chat.deleted', { chat_id: chat.id })
  }

  // ---------- notas e etiquetas ----------

  /** Nota interna: só no CRM (nenhuma chamada ao gateway); entra na linha do tempo com o autor (AC-T48-05). */
  async addNote(actor: ChatActor, chatId: string, body: string): Promise<NoteDto> {
    const chat = await this.query.row(actor, chatId)
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) throw chatInvalid('body', 'Escreva a nota')
    if (text.length > NOTE_MAX) throw chatInvalid('body', `No máximo ${NOTE_MAX} caracteres`)
    const note = await this.db.transaction(async (tx) => {
      const [n] = await tx.insert(chatNotes).values({ companyId: actor.companyId, chatId: chat.id, authorUserId: actor.userId, body: text }).returning()
      await this.event(tx, chat, actor, 'note_added', { note_id: n!.id, body: text })
      return n!
    })
    await this.publish(chat, 'chat.updated', { chat_id: chat.id, chat: await this.query.get(actor, chat.id) })
    return (await this.notesBy([note]))[0]!
  }

  async listNotes(actor: ChatActor, chatId: string): Promise<NoteDto[]> {
    const chat = await this.query.row(actor, chatId)
    const rows = await this.db.select().from(chatNotes).where(eq(chatNotes.chatId, chat.id)).orderBy(desc(chatNotes.createdAt), desc(chatNotes.id))
    return this.notesBy(rows)
  }

  /** Linha do tempo (mais novo primeiro). */
  async listEvents(actor: ChatActor, chatId: string): Promise<ChatEventDto[]> {
    const chat = await this.query.row(actor, chatId)
    const rows = await this.db.select().from(chatEvents).where(eq(chatEvents.chatId, chat.id)).orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    const names = await this.userNames(rows.map((r) => r.actorUserId))
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actor: r.actorUserId ? { id: r.actorUserId, name: names.get(r.actorUserId) ?? '' } : null,
      detail: r.detail ?? null,
      created_at: r.createdAt.toISOString(),
    }))
  }

  async addLabel(actor: ChatActor, chatId: string, labelId: string): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    await this.assertOwned(labels, actor.companyId, labelId, 'label_id', 'Etiqueta')
    const added = await this.db.insert(chatLabels).values({ companyId: actor.companyId, chatId: chat.id, labelId }).onConflictDoNothing().returning()
    if (!added.length) return this.query.get(actor, chat.id)
    return this.mutate(actor, chat, {}, 'label_added', { label_id: labelId })
  }

  async removeLabel(actor: ChatActor, chatId: string, labelId: string): Promise<ChatListItem> {
    const chat = await this.query.row(actor, chatId)
    if (!UUID_RE.test(labelId)) return this.query.get(actor, chat.id)
    const removed = await this.db.delete(chatLabels).where(and(eq(chatLabels.chatId, chat.id), eq(chatLabels.labelId, labelId))).returning()
    if (!removed.length) return this.query.get(actor, chat.id)
    return this.mutate(actor, chat, {}, 'label_removed', { label_id: labelId })
  }

  // ---------- internos ----------

  private assertTransition(chat: ChatRow, action: keyof typeof CHAT_TRANSITIONS): void {
    if (!CHAT_TRANSITIONS[action].includes(chat.status))
      throw new ChatsError('invalid_transition', `Não é possível ${action} um chat ${chat.status}`, { from: chat.status, action })
  }

  private async mutate(
    actor: ChatActor,
    chat: ChatRow,
    patch: Partial<typeof chats.$inferInsert>,
    eventOrList: string | [string, Record<string, unknown>][],
    detail?: Record<string, unknown> | null,
  ): Promise<ChatListItem> {
    const events = typeof eventOrList === 'string' ? [[eventOrList, detail ?? null] as const] : eventOrList
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(chats)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(chats.companyId, actor.companyId), eq(chats.id, chat.id)))
        .returning()
      for (const [type, d] of events) await this.event(tx, row!, actor, type, d)
      return row!
    })
    // O ator pode ter perdido o escopo (ex.: transferiu para outro departamento): decora sem checar escopo.
    const dto = (await this.query.decorate([updated]))[0]!
    await this.publish(updated, 'chat.updated', { chat_id: updated.id, chat: dto })
    // T91: mudou o escopo (departamento/conexão)? Avisa também o escopo ANTIGO: quem perdeu o acesso recebe o evento,
    // refaz a lista e o chat some sem recarregar (o servidor já não o devolve).
    if (chat.departmentId !== updated.departmentId || chat.connectionId !== updated.connectionId)
      await this.publish(chat, 'chat.updated', { chat_id: updated.id, chat: dto })
    return dto
  }

  private async event(exec: Database | Tx, chat: Pick<ChatRow, 'id' | 'companyId'>, actor: ChatActor, type: string, detail: Record<string, unknown> | null) {
    await exec.insert(chatEvents).values({ companyId: chat.companyId, chatId: chat.id, type, actorUserId: actor.userId, detail })
  }

  private async publish(chat: ChatRow, type: 'chat.created' | 'chat.updated' | 'chat.deleted', data: Record<string, unknown>) {
    if (!this.publisher) return
    try {
      await this.publisher.publish(chat.companyId, type, data as never, { scope: chatScope(chat) })
    } catch {
      // Realtime é melhor-esforço: a mudança já foi gravada.
    }
  }

  private async assertMember(companyId: string, userId: string): Promise<void> {
    const ok = UUID_RE.test(userId)
      ? await this.db
          .select({ id: companyMembers.id })
          .from(companyMembers)
          .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
          .limit(1)
      : []
    if (!ok.length) throw chatInvalid('user_id', 'Atendente não é membro da empresa')
  }

  private async assertOwned(
    table: typeof departments | typeof aiAgents | typeof labels,
    companyId: string,
    id: string,
    path: string,
    what: string,
  ): Promise<void> {
    const ok = UUID_RE.test(id) ? await this.db.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), eq(table.id, id))).limit(1) : []
    if (!ok.length) throw chatInvalid(path, `${what} não encontrado`)
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))]
    if (!uniq.length) return new Map()
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq))
    return new Map(rows.map((r) => [r.id, r.name]))
  }

  private async notesBy(rows: (typeof chatNotes.$inferSelect)[]): Promise<NoteDto[]> {
    const names = await this.userNames(rows.map((r) => r.authorUserId))
    return rows.map((r) => ({
      id: r.id,
      chat_id: r.chatId,
      body: r.body,
      author: r.authorUserId ? { id: r.authorUserId, name: names.get(r.authorUserId) ?? '' } : null,
      created_at: r.createdAt.toISOString(),
    }))
  }
}

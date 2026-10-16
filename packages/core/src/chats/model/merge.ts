// Fusão de chats quando dois contatos viram um só (`mergeIdentity`, evento `contact.lid_mapping`).
// Plugado como `mergeHook` do ContactsService (T26): roda na mesma transação, antes de o contato absorvido sumir.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { chatEvents, chatLabels, chatNotes, chats, messages } from '@crm/db'
import type { ContactMergeHook } from '../../contacts/service'

type Tx = Parameters<ContactMergeHook>[0]

const OPEN = new Set(['waiting', 'attending'])
const maxDate = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b)
const minDate = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b)

/** Chats afetados por uma fusão (para publicar `chat.updated` depois do commit). */
export interface ChatMergeResult {
  /** Chats que sobreviveram (recebidos ou que só trocaram de contato). */
  chatIds: string[]
  /** Chats absorvidos e apagados. */
  removedChatIds: string[]
}

/**
 * Move os chats do contato `fromId` para `intoId`. Na mesma conexão, o chat do sobrevivente recebe as mensagens,
 * notas, etiquetas e eventos do outro (não lidas somadas, datas combinadas; aberto vence resolvido) e o outro é
 * apagado; em conexões diferentes, o chat só troca de contato.
 */
export async function mergeContactChats(tx: Tx, e: { companyId: string; fromId: string; intoId: string }): Promise<ChatMergeResult> {
  const result: ChatMergeResult = { chatIds: [], removedChatIds: [] }
  const fromChats = await tx.select().from(chats).where(and(eq(chats.companyId, e.companyId), eq(chats.contactId, e.fromId))).for('update')
  if (!fromChats.length) return result
  const intoChats = await tx
    .select()
    .from(chats)
    .where(and(eq(chats.companyId, e.companyId), eq(chats.contactId, e.intoId), inArray(chats.connectionId, fromChats.map((c) => c.connectionId))))
    .for('update')
  const intoByConnection = new Map(intoChats.map((c) => [c.connectionId, c]))

  for (const from of fromChats) {
    const into = intoByConnection.get(from.connectionId)
    if (!into) {
      await tx.update(chats).set({ contactId: e.intoId, updatedAt: new Date() }).where(eq(chats.id, from.id))
      result.chatIds.push(from.id)
      continue
    }
    await tx.update(messages).set({ chatId: into.id }).where(eq(messages.chatId, from.id))
    await tx.update(chatNotes).set({ chatId: into.id }).where(eq(chatNotes.chatId, from.id))
    await tx.update(chatEvents).set({ chatId: into.id }).where(eq(chatEvents.chatId, from.id))
    await tx.execute(sql`
      insert into ${chatLabels} (company_id, chat_id, label_id)
      select company_id, ${into.id}, label_id from ${chatLabels} where chat_id = ${from.id}
      on conflict do nothing`)
    const lastFrom = from.lastMessageAt && (!into.lastMessageAt || from.lastMessageAt > into.lastMessageAt)
    const reopen = !OPEN.has(into.status) && OPEN.has(from.status)
    await tx.delete(chats).where(eq(chats.id, from.id))
    await tx
      .update(chats)
      .set({
        unreadCount: into.unreadCount + from.unreadCount,
        lastMessageAt: maxDate(into.lastMessageAt, from.lastMessageAt),
        lastMessagePreview: lastFrom ? from.lastMessagePreview : into.lastMessagePreview,
        lastInboundAt: maxDate(into.lastInboundAt, from.lastInboundAt),
        openedAt: minDate(into.openedAt, from.openedAt) ?? into.openedAt,
        firstHumanReplyAt: minDate(into.firstHumanReplyAt, from.firstHumanReplyAt),
        firstHumanReplyBy: into.firstHumanReplyBy ?? from.firstHumanReplyBy,
        assignedUserId: into.assignedUserId ?? from.assignedUserId,
        departmentId: into.departmentId ?? from.departmentId,
        aiAgentId: into.aiAgentId ?? from.aiAgentId,
        blocked: into.blocked || from.blocked,
        ...(reopen ? { status: from.status, resolvedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(chats.id, into.id))
    await tx.insert(chatEvents).values({ companyId: e.companyId, chatId: into.id, type: 'merged', detail: { from_chat_id: from.id, from_contact_id: e.fromId } })
    result.chatIds.push(into.id)
    result.removedChatIds.push(from.id)
  }
  return result
}

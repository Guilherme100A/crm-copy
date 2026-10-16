// Formas no fio (snake_case, SPEC 3.6) de chats e mensagens, usadas nos eventos realtime e pela API (T48/T49).
import type { chats, messages } from '@crm/db'

export type ChatRow = typeof chats.$inferSelect
export type MessageRow = typeof messages.$inferSelect

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export interface ChatDto {
  id: string
  connection_id: string
  contact_id: string
  status: ChatRow['status']
  assigned_user_id: string | null
  department_id: string | null
  ai_agent_id: string | null
  unread_count: number
  last_message_preview: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  opened_at: string
  first_human_reply_at: string | null
  first_human_reply_by: string | null
  resolved_at: string | null
  blocked: boolean
  created_at: string
  updated_at: string
}

export function toChatDto(r: ChatRow): ChatDto {
  return {
    id: r.id,
    connection_id: r.connectionId,
    contact_id: r.contactId,
    status: r.status,
    assigned_user_id: r.assignedUserId,
    department_id: r.departmentId,
    ai_agent_id: r.aiAgentId,
    unread_count: r.unreadCount,
    last_message_preview: r.lastMessagePreview,
    last_message_at: iso(r.lastMessageAt),
    last_inbound_at: iso(r.lastInboundAt),
    opened_at: r.openedAt.toISOString(),
    first_human_reply_at: iso(r.firstHumanReplyAt),
    first_human_reply_by: r.firstHumanReplyBy,
    resolved_at: iso(r.resolvedAt),
    blocked: r.blocked,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

export interface MessageDto {
  id: string
  chat_id: string
  direction: MessageRow['direction']
  sender_type: MessageRow['senderType']
  sender_user_id: string | null
  type: string
  wa_type: string | null
  body: string | null
  media: Record<string, unknown> | null
  quoted_wa_message_id: string | null
  status: MessageRow['status']
  error: string | null
  wa_message_id: string | null
  pipeline_message_id: string | null
  historical: boolean
  deleted_at: string | null
  wa_timestamp: string | null
  created_at: string
}

export function toMessageDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    chat_id: r.chatId,
    direction: r.direction,
    sender_type: r.senderType,
    sender_user_id: r.senderUserId,
    type: r.type,
    wa_type: r.waType,
    body: r.body,
    media: r.media,
    quoted_wa_message_id: r.quotedWaMessageId,
    status: r.status,
    error: r.error,
    wa_message_id: r.waMessageId,
    pipeline_message_id: r.pipelineMessageId,
    historical: r.historical,
    deleted_at: iso(r.deletedAt),
    wa_timestamp: iso(r.waTimestamp),
    created_at: r.createdAt.toISOString(),
  }
}

/** Escopo do evento para o filtro `chatScope` do SSE (T16). */
export const chatScope = (r: Pick<ChatRow, 'connectionId' | 'departmentId'>) => ({ connection_id: r.connectionId, department_id: r.departmentId })

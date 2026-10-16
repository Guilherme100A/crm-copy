// Realtime (SPEC 3.7): envelope `{ id, type, company_id, at, data }` e catálogo tipado de eventos `<domínio>.<ação>`.
// Arquivo compartilhado: cada módulo acrescenta seus tipos em REALTIME_EVENTS de forma aditiva.
import * as z from 'zod'
import { idSchema } from '../ids'
import type { PermissionKey } from '../permissions/catalog'

interface RealtimeEventDef<D extends z.ZodType = z.ZodType> {
  /** Schema do `data`. */
  data: D
  /** Permissão exigida para receber o evento (filtro no servidor); `null` = qualquer membro. */
  permission: PermissionKey | null
}

const defineEvent = <D extends z.ZodType>(data: D, permission: PermissionKey | null = null): RealtimeEventDef<D> => ({
  data,
  permission,
})

export const REALTIME_EVENTS = {
  /** Dados da empresa mudaram (nome, fuso, status…): o cliente recarrega a empresa. */
  'company.updated': defineEvent(
    z.object({
      company_id: idSchema.optional(),
      id: idSchema.optional(),
      name: z.string().optional(),
      fields: z.array(z.string()).optional(),
    }),
  ),
  /** Permissões/escopo de um membro mudaram: o cliente desse usuário recarrega o perfil. */
  'member.permissions_changed': defineEvent(
    z.object({
      company_id: idSchema.optional(),
      user_id: idSchema.optional(),
      role: z.enum(['owner', 'admin', 'member']).optional(),
      permission_keys: z.array(z.string()).nullable().optional(),
    }),
  ),
  // ---- T33: chats e mensagens (ChatsChannel do produto de referência; filtrados por chat.view e chatScope) ----
  /** Chat novo (1ª mensagem de um contato na conexão). */
  'chat.created': defineEvent(z.looseObject({ chat_id: idSchema, chat: z.looseObject({ id: idSchema }) }), 'chat.view'),
  /** Campos do chat mudaram (status, não lidas, prévia, atendente…). */
  'chat.updated': defineEvent(z.looseObject({ chat_id: idSchema, chat: z.looseObject({ id: idSchema }).optional() }), 'chat.view'),
  /** Mensagem nova no chat (recebida ou enviada). */
  'message.created': defineEvent(z.looseObject({ chat_id: idSchema, message: z.looseObject({ id: idSchema }) }), 'chat.view'),
  /** Status de entrega/leitura da mensagem (nunca regride). */
  'message.status': defineEvent(
    z.looseObject({ chat_id: idSchema, message_id: idSchema, status: z.string().min(1), error: z.string().nullable().optional() }),
    'chat.view',
  ),
  /** Dados do contato mudaram (identidade LID/PN, atribuição, opt-out). */
  'contact.updated': defineEvent(z.looseObject({ contact_id: idSchema, contact: z.looseObject({ id: idSchema }).optional() }), 'contacts.view'),
  // ---- T49: ações na mensagem ----
  /** Mensagem apagada para todos (`message_deleted` do produto de referência). */
  'message.deleted': defineEvent(z.looseObject({ chat_id: idSchema, message_id: idSchema }), 'chat.view'),
  /** Reação adicionada ou removida (`emoji: ''`). */
  'message.reacted': defineEvent(
    z.looseObject({ chat_id: idSchema, message_id: idSchema, emoji: z.string(), user_id: idSchema.nullable().optional() }),
    'chat.view',
  ),
  /** Saldo de créditos de IA mudou (T24): o cliente atualiza o chip/cartão da carteira. */
  'ai_wallet.updated': defineEvent(
    z.looseObject({
      balance_credits: z.number(),
      status: z.enum(['ok', 'low', 'exhausted']),
      low_threshold_credits: z.number().optional(),
      max_overrun_credits: z.number().optional(),
    }),
  ),
  /** Aviso de IA (T24): saldo baixo/esgotado (`reason: 'balance'`) ou cota `soft` estourada (`reason: 'quota'`). */
  'ai_wallet.low': defineEvent(
    z.looseObject({
      reason: z.enum(['balance', 'quota']),
      balance_credits: z.number().optional(),
      status: z.enum(['ok', 'low', 'exhausted']).optional(),
      period: z.enum(['day', 'month']).optional(),
      metric: z.enum(['credits', 'cost_micros', 'tokens']).optional(),
      used: z.number().optional(),
      limit: z.number().optional(),
    }),
  ),
} as const satisfies Record<string, RealtimeEventDef>

export type RealtimeEventType = keyof typeof REALTIME_EVENTS
export type RealtimeEventData<T extends RealtimeEventType> = z.infer<(typeof REALTIME_EVENTS)[T]['data']>

export const REALTIME_EVENT_TYPES = Object.keys(REALTIME_EVENTS) as RealtimeEventType[]

export const realtimeEventTypeSchema = z.enum(REALTIME_EVENT_TYPES as [RealtimeEventType, ...RealtimeEventType[]])

export function isRealtimeEventType(value: unknown): value is RealtimeEventType {
  return typeof value === 'string' && Object.hasOwn(REALTIME_EVENTS, value)
}

export type RealtimeEnvelope<T extends RealtimeEventType = RealtimeEventType> = {
  [K in T]: {
    /** Id do Redis Stream (`<ms>-<seq>`), também usado como `id:` do SSE. */
    id: string
    type: K
    company_id: string
    /** ISO 8601 UTC. */
    at: string
    data: RealtimeEventData<K>
  }
}[T]

/** Envelope validado: `type` precisa estar no catálogo e `data` no schema do tipo. */
export const realtimeEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: realtimeEventTypeSchema,
    company_id: idSchema,
    at: z.iso.datetime({ offset: true }),
    data: z.unknown(),
  })
  .transform((env, ctx) => {
    const parsed = REALTIME_EVENTS[env.type].data.safeParse(env.data)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['data', ...issue.path] } as never)
      return z.NEVER
    }
    return { ...env, data: parsed.data } as RealtimeEnvelope
  })

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope {
  return realtimeEnvelopeSchema.parse(value)
}

/** Permissão exigida para receber o tipo de evento (`null` = qualquer membro da empresa). */
export function realtimeEventPermission(type: RealtimeEventType): PermissionKey | null {
  return REALTIME_EVENTS[type].permission
}

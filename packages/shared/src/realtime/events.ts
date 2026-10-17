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

/** Dados dos eventos `flow_run.*` (T43). */
const flowRunEventData = () =>
  z.looseObject({
    run_id: idSchema,
    flow_id: idSchema,
    contact_id: idSchema.nullable().optional(),
    chat_id: idSchema.nullable().optional(),
    status: z.string(),
  })

/** Pedido de acesso de suporte nos eventos `support_access.*` (T32). */
const supportAccessRequestEventData = () =>
  z.looseObject({ id: idSchema, status: z.string(), support_user_id: idSchema, company_id: idSchema })

/** Concessão de acesso de suporte nos eventos `support_access.*` (T32). */
const supportAccessGrantEventData = () =>
  z.looseObject({ id: idSchema, support_user_id: idSchema, company_id: idSchema, expires_at: z.string() })

/** Dados dos eventos `kanban.card.*` (T50). */
const kanbanCardEventData = () =>
  z.looseObject({
    crm_id: idSchema,
    card_id: idSchema,
    chat_id: idSchema,
    column_id: idSchema,
    from_column_id: idSchema.optional(),
  })

/** Base dos eventos `connection.*` e `flow.auto_paused|resumed` (T47). */
const connectionEventData = () => z.looseObject({ connection_id: idSchema, session_id: z.string() })

/** Queda de conexão (`connection.disconnected|disconnected_alert|banned_alert`, T47). */
const connectionDropData = () =>
  connectionEventData().extend({
    name: z.string(),
    phone_number: z.string().nullable(),
    reason: z.enum(['transient', 'loggedOut', 'forbidden']).nullable(),
    status_code: z.number().int().nullable(),
    status: z.string(),
    disconnected_at: z.string(),
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
  /** Chat excluído (T48): o cliente remove da lista. */
  'chat.deleted': defineEvent(z.looseObject({ chat_id: idSchema }), 'chat.view'),
  /** Venda nova registrada (T34; manual, fluxo ou webhook): o dashboard atualiza. */
  'sale.recorded': defineEvent(z.looseObject({ sale_id: idSchema, sale: z.looseObject({ id: idSchema }).optional() }), 'dashboard.sales'),
  /** Venda mudou (T112: status da emissão de NF, `invoice_emit_status` de 19 §4.2): a lista de vendas atualiza. */
  'sale.updated': defineEvent(
    z.looseObject({
      sale_id: idSchema,
      invoice_emit_status: z.enum(['pending', 'succeeded', 'failed']).nullable().optional(),
      invoice_last_error: z.string().nullable().optional(),
      /** T113: estado do envio mais recente à UTMify e o último erro (sem credenciais). */
      utmify_status: z.enum(['pending', 'succeeded', 'failed']).nullable().optional(),
      utmify_last_error: z.string().nullable().optional(),
      /** T113: a venda passou a este status (`SalesService`, ex.: `refunded`), com o DTO em `sale`. */
      status: z.enum(['approved', 'refunded', 'chargeback', 'pending']).optional(),
      previous_status: z.enum(['approved', 'refunded', 'chargeback', 'pending']).optional(),
    }),
    'dashboard.sales',
  ),
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
  // ---- T28: editor de fluxos ----
  /** Rascunho do fluxo mudou (`flow_graph_updated` da referência): outros editores aplicam ou recarregam o bundle. */
  'flow.graph_updated': defineEvent(
    z.looseObject({ flow_id: idSchema, actor_id: idSchema.nullable(), mutation: z.string() }),
    'flows.view',
  ),
  /** Contadores do distribuidor mudaram (T41): `outputs[].count` por saída. */
  'flow.distributor_updated': defineEvent(
    z.looseObject({
      flow_id: idSchema,
      node_id: z.string(),
      outputs: z.array(z.looseObject({ id: z.string(), count: z.number() })),
    }),
    'flows.view',
  ),
  // ---- T43: execuções de fluxo (flow_execution_created/cancelled da referência) ----
  /** Run criado (disparo manual, gatilho…). */
  'flow_run.created': defineEvent(flowRunEventData(), 'flows.view'),
  /** Run mudou de estado (esperando, concluído, falhou…). */
  'flow_run.updated': defineEvent(flowRunEventData(), 'flows.view'),
  /** Run cancelado (manual, novo disparo para o contato, cancelar todos da conexão). */
  'flow_run.cancelled': defineEvent(flowRunEventData(), 'flows.view'),
  // ---- T50: Kanban (publicados com o escopo do chat) ----
  'kanban.card.created': defineEvent(kanbanCardEventData(), 'kanban.view'),
  'kanban.card.updated': defineEvent(kanbanCardEventData(), 'kanban.view'),
  /** Card mudou de coluna/posição; `from_column_id` = coluna de origem. */
  'kanban.card.moved': defineEvent(kanbanCardEventData(), 'kanban.view'),
  'kanban.card.deleted': defineEvent(kanbanCardEventData(), 'kanban.view'),
  /** Coluna criada, editada, excluída ou movida (o cliente recarrega as colunas do quadro). */
  'kanban.column.changed': defineEvent(
    z.looseObject({ crm_id: idSchema, column_id: idSchema.nullable().optional(), action: z.enum(['created', 'updated', 'deleted', 'moved']) }),
    'kanban.view',
  ),
  /** Progresso de job de exportação/importação (T27): vai só para o criador (stream do usuário). */
  'job.progress': defineEvent(
    z.looseObject({
      job_id: idSchema,
      kind: z.string(),
      status: z.enum(['queued', 'processing', 'completed', 'failed']),
      progress: z.looseObject({ processed: z.number(), total: z.number().nullable(), percent: z.number().nullable() }),
      row_count: z.number().nullable().optional(),
      error: z.string().nullable().optional(),
    }),
  ),
  /** Disparo em massa mudou (preparação, status, contadores) — T74, no máximo 1/s por disparo. */
  'mass_dispatch.updated': defineEvent(
    z.looseObject({
      mass_dispatch_id: idSchema,
      status: z.string(),
      preparation_progress: z.looseObject({}).optional(),
      total_count: z.number(),
      pending_count: z.number(),
      sent_count: z.number(),
      failed_count: z.number(),
      skipped_count: z.number(),
    }),
    'contacts.view',
  ),
  /** Notificação genérica no app (T63/T84; ex.: push da Venda aprovada): toast e central de notificações. */
  'notification.created': defineEvent(
    z.looseObject({ title: z.string(), body: z.string(), url: z.string().nullable().optional() }),
    'dashboard.sales',
  ),
  // ---- T101: Gerenciador Meta (MetaStructureBundleChannel da referência): progresso do bundle; o cliente relê o GET ----
  'meta.bundle.progress': defineEvent(
    z.looseObject({
      bundle_key: z.string(),
      status: z.enum(['loading', 'partial', 'refreshing', 'ready']),
      targets_done: z.number(),
      targets_total: z.number(),
      errors: z.array(z.looseObject({ ad_account_id: z.string(), error: z.string() })).optional(),
      warnings: z.array(z.string()).optional(),
    }),
    'facebook.campaigns',
  ),
  // ---- T52: base de conhecimento dos agentes (criada, lida, reindexada, excluída) ----
  'ai_knowledge_source.updated': defineEvent(
    z.looseObject({
      agent_id: idSchema,
      source_id: idSchema,
      status: z.enum(['pending', 'ready', 'failed', 'deleted']),
      source: z.looseObject({ id: idSchema }).optional(),
    }),
    'flows.view',
  ),
  // ---- T79: criação assistida de agente (run extract → compose → persist) ----
  'ai_agent.run.updated': defineEvent(
    z.looseObject({
      run: z.looseObject({
        id: idSchema,
        status: z.enum(['queued', 'running', 'completed', 'failed']),
        stage: z.enum(['extract', 'compose', 'persist']).nullable(),
        warnings: z.array(z.string()),
        agent_id: idSchema.nullable(),
        error_message: z.string().nullable(),
      }),
    }),
    'flows.view',
  ),
  // ---- T81: escuta de amostra do webhook de entrada (só no stream do usuário que está escutando) ----
  'webhook.sample_received': defineEvent(
    z.looseObject({
      webhook_id: idSchema,
      request_id: idSchema,
      request: z.looseObject({ raw_body: z.string(), raw_body_truncated: z.boolean() }),
    }),
    'webhooks.view',
  ),
  // ---- T47: conexões (ConnectionsChannel da referência; 08-conexoes.md §7) ----
  'connection.created': defineEvent(connectionEventData(), 'connections.view'),
  'connection.updated': defineEvent(connectionEventData(), 'connections.view'),
  'connection.deleted': defineEvent(connectionEventData(), 'connections.view'),
  /** Status de UI recalculado (estado da sessão + último `session.connection`). */
  'connection.status_changed': defineEvent(
    connectionEventData().extend({
      status: z.string(),
      session_state: z.string().nullable(),
      connection_state: z.enum(['open', 'close']).nullable(),
      badges: z.array(z.string()),
    }),
    'connections.view',
  ),
  /** QR novo (data URL): dá para vincular um aparelho, por isso exige `connections.edit`. */
  'connection.qr_updated': defineEvent(connectionEventData().extend({ qr_code: z.string() }), 'connections.edit'),
  'connection.pairing_code': defineEvent(connectionEventData().extend({ code: z.string() }), 'connections.edit'),
  'connection.connected': defineEvent(
    connectionEventData().extend({ name: z.string(), phone_number: z.string().nullable(), connected_at: z.string() }),
    'connections.view',
  ),
  /** Toda queda (`session.connection` close). */
  'connection.disconnected': defineEvent(connectionDropData(), 'connections.view'),
  /** Alerta da queda (não forbidden), no máximo 1 a cada 5 s por conexão. */
  'connection.disconnected_alert': defineEvent(connectionDropData(), 'connections.view'),
  /** Queda por 403 (forbidden): conexão `banned`. Mesmo dedupe do alerta de queda. */
  'connection.banned_alert': defineEvent(connectionDropData(), 'connections.view'),
  /** Reconectou com runs pausados pela queda: contagens para o modal retomar/cancelar. */
  'connection.reconnected_with_paused_flows': defineEvent(
    connectionEventData().extend({
      name: z.string(),
      paused_count: z.number().int(),
      waiting_count: z.number().int(),
      failed_count: z.number().int(),
      received_count: z.number().int(),
      total_leads: z.number().int(),
    }),
    'connections.view',
  ),
  'connection.health_degraded': defineEvent(connectionEventData().extend({ from: z.string(), to: z.string() }), 'connections.view'),
  /** Runs `waiting` da conexão pausados na queda. */
  'flow.auto_paused': defineEvent(
    connectionEventData().extend({ paused_count: z.number().int(), run_ids: z.array(idSchema), flow_ids: z.array(idSchema) }),
    'flows.view',
  ),
  /** Runs pausados na queda retomados (ação "Retomar" do modal). */
  'flow.resumed': defineEvent(connectionEventData().extend({ resumed_count: z.number().int() }), 'flows.view'),
  // T32: acesso de suporte. Publicados na empresa (owner/admin filtram no cliente) e para o usuário `support`.
  /** Pedido novo ou reenviado: abre o modal global de aprovação. */
  'support_access.requested': defineEvent(z.looseObject({ request: supportAccessRequestEventData() })),
  /** Pedido aprovado: concessão de 12 h criada. */
  'support_access.granted': defineEvent(z.looseObject({ request: supportAccessRequestEventData(), grant: supportAccessGrantEventData() })),
  /** Pedido recusado por owner/admin. */
  'support_access.rejected': defineEvent(z.looseObject({ request: supportAccessRequestEventData() })),
  /** Concessão revogada por owner/admin. */
  'support_access.revoked': defineEvent(z.looseObject({ grant: supportAccessGrantEventData() })),
  /** Pedido cancelado pelo suporte. */
  'support_access.cancelled': defineEvent(z.looseObject({ request: supportAccessRequestEventData() })),
  // ---- T93: assistente de fluxo (publicados só para o dono da sessão, `userId`) ----
  // As edições do assistente saem em `flow.graph_updated` com `actor_id: null`, `source: 'ai'` (opcional; ausente =
  // edição de usuário/API) e `session_id`; o looseObject do T28 aceita os campos extras.
  /** Pedaço da resposta do turno: `kind: 'tool'` (resultado de uma ferramenta) ou `kind: 'text'` (`delta` do texto final). */
  'copilot.delta': defineEvent(
    z.looseObject({
      session_id: idSchema,
      flow_id: idSchema,
      message_id: idSchema,
      kind: z.enum(['text', 'tool']),
      delta: z.string().optional(),
      tool: z.string().optional(),
      ok: z.boolean().optional(),
      error: z.string().optional(),
    }),
    'flows.view',
  ),
  /** Fim do turno: `completed`, `failed` ou `paused_quota` (cota esgotada pausou a sessão). */
  'copilot.completed': defineEvent(
    z.looseObject({
      session_id: idSchema,
      flow_id: idSchema,
      message_id: idSchema,
      status: z.enum(['completed', 'failed', 'paused_quota']),
      graph_changed: z.boolean(),
      error_code: z.string().optional(),
    }),
    'flows.view',
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

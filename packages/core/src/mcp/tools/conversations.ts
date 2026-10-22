// Ferramentas MCP de conversas (via API do CRM): lista com filtros, chat, histórico de mensagens, notas, linha do
// tempo, execuções de fluxo do chat; e, com escrita, enviar texto, anotar, atribuir, resolver/reabrir, etiquetar e
// mover de departamento/quadro. Datas em ISO 8601.
import { z, type ZodRawShape } from 'zod'
import { compact, fail, fromApi, tool, UUID, type McpApiResponse, type ToolSpec } from './shared'

const STATUS = z.enum(['waiting', 'attending', 'resolved']).describe('waiting = aguardando, attending = em atendimento, resolved = resolvido')
const ids = (what: string) => z.array(UUID).max(100).optional().describe(`Filtra por ${what} (ids)`)
const csv = (v: readonly string[] | undefined) => (v && v.length ? v.join(',') : undefined)

/** Campo de mídia curto (mime, nome, tamanho, duração…); some blobs/miniaturas em base64 e objetos aninhados. */
function slimMedia(media: unknown): Record<string, unknown> | null {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(media as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 500) out[k] = v
  }
  return out
}

/** Mensagem só com o que importa para ler a conversa. */
function slimMessage(m: unknown): unknown {
  if (!m || typeof m !== 'object') return m
  const r = m as Record<string, unknown>
  return compact({
    id: r.id,
    direction: r.direction,
    sender_type: r.sender_type,
    sender_user_id: r.sender_user_id ?? undefined,
    type: r.type,
    body: r.body,
    media: r.media ? slimMedia(r.media) : undefined,
    status: r.status,
    error: r.error ?? undefined,
    reactions: Array.isArray(r.reactions) && r.reactions.length ? r.reactions : undefined,
    deleted_at: r.deleted_at ?? undefined,
    wa_timestamp: r.wa_timestamp,
    created_at: r.created_at,
  })
}

export function slimMessages(res: McpApiResponse): McpApiResponse {
  if (res.status !== 200 || !res.body || typeof res.body !== 'object') return res
  const b = res.body as { items?: unknown[]; next_cursor?: unknown }
  if (!Array.isArray(b.items)) return res
  return { status: res.status, body: { items: b.items.map(slimMessage), next_cursor: b.next_cursor ?? null } }
}

export const conversationsTools: readonly ToolSpec<ZodRawShape>[] = [
  tool({
    name: 'list_conversations',
    title: 'Listar conversas',
    description:
      'Conversas (chats de WhatsApp) com filtros, mais recentes primeiro, já com contato, atendente, etiquetas e prévia da última ' +
      'mensagem; traz também os contadores por status. Paginação por cursor: passe next_cursor da resposta em cursor (até 50 por página). ' +
      'created_from/created_to em ISO 8601 (os dois juntos).',
    perm: 'chat.view',
    input: {
      status: STATUS.optional(),
      search: z.string().max(200).optional().describe('Nome ou telefone do contato'),
      assigned_to: z.union([z.literal('none'), UUID]).optional().describe('"none" = sem atendente, ou o id do atendente'),
      response_status: z.enum(['unanswered', 'answered']).optional().describe('unanswered = cliente esperando resposta'),
      read_status: z.enum(['unread', 'read']).optional(),
      created_from: z.string().max(40).optional(),
      created_to: z.string().max(40).optional(),
      contact_id: UUID.optional(),
      connection_ids: ids('conexões de WhatsApp'),
      department_ids: ids('departamentos'),
      label_ids: ids('etiquetas'),
      crm_id: UUID.optional().describe('Só chats com card neste quadro Kanban'),
      crm_column_id: UUID.optional(),
      cursor: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/chats', {
          query: compact({
            ...a,
            connection_ids: csv(a.connection_ids),
            department_ids: csv(a.department_ids),
            label_ids: csv(a.label_ids),
          }),
        }),
      ),
  }),

  tool({
    name: 'get_conversation_counts',
    title: 'Contar conversas por status',
    description: 'Quantas conversas há em waiting, attending e resolved, com os mesmos filtros de list_conversations.',
    perm: 'chat.view',
    input: {
      search: z.string().max(200).optional(),
      assigned_to: z.union([z.literal('none'), UUID]).optional(),
      connection_ids: ids('conexões'),
      department_ids: ids('departamentos'),
      label_ids: ids('etiquetas'),
      created_from: z.string().max(40).optional(),
      created_to: z.string().max(40).optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/chats/counts', {
          query: compact({ ...a, connection_ids: csv(a.connection_ids), department_ids: csv(a.department_ids), label_ids: csv(a.label_ids) }),
        }),
      ),
  }),

  tool({
    name: 'get_conversation',
    title: 'Ver conversa',
    description: 'Uma conversa pelo id: status, contato, conexão, atendente, departamento, agente de IA, etiquetas e não lidas.',
    perm: 'chat.view',
    input: { id: UUID },
    run: async (a, api) => fromApi(await api.request('GET', `/api/chats/${a.id}`)),
  }),

  tool({
    name: 'get_conversation_messages',
    title: 'Ler mensagens da conversa',
    description:
      'Mensagens da conversa em ordem cronológica (a página termina na mais recente). direction: inbound = do cliente, outbound = nossa; ' +
      'sender_type diz se foi usuário, fluxo, IA ou sistema. Para ler mais antigas, passe next_cursor em before. Mídia vem só com ' +
      'metadados (tipo, nome, tamanho), sem o arquivo.',
    perm: 'chat.view',
    input: { id: UUID, before: UUID.optional().describe('next_cursor da página anterior'), limit: z.number().int().min(1).max(100).optional() },
    run: async (a, api) =>
      fromApi(slimMessages(await api.request('GET', `/api/chats/${a.id}/messages`, { query: compact({ before: a.before, limit: a.limit }) }))),
  }),

  tool({
    name: 'get_conversation_notes',
    title: 'Notas internas da conversa',
    description: 'Notas internas da equipe na conversa (o cliente não vê).',
    perm: 'chat.view',
    input: { id: UUID },
    run: async (a, api) => fromApi(await api.request('GET', `/api/chats/${a.id}/notes`)),
  }),

  tool({
    name: 'get_conversation_timeline',
    title: 'Linha do tempo da conversa',
    description: 'Eventos da conversa: aberta, atribuída, transferida, resolvida, reaberta, etiquetas, departamento etc., com quem e quando.',
    perm: 'chat.view',
    input: { id: UUID },
    run: async (a, api) => fromApi(await api.request('GET', `/api/chats/${a.id}/events`)),
  }),

  tool({
    name: 'get_conversation_flow_runs',
    title: 'Fluxos da conversa',
    description:
      'Execuções de fluxo desta conversa (mais recentes primeiro): fluxo, status, bloco atual e datas. Mostra em que ponto do funil do ' +
      'fluxo o contato está. active_only = só as em andamento.',
    perm: 'flows.view',
    input: { id: UUID, active_only: z.boolean().optional() },
    run: async (a, api) => fromApi(await api.request('GET', `/api/chats/${a.id}/flow-runs`, { query: compact({ active: a.active_only ? 1 : undefined }) })),
  }),

  tool({
    name: 'list_labels',
    title: 'Listar etiquetas',
    description: 'Etiquetas da empresa (id, nome, cor), para filtrar conversas ou etiquetar.',
    perm: 'settings.labels.view',
    run: async (_a, api) => fromApi(await api.request('GET', '/api/labels')),
  }),

  tool({
    name: 'send_message',
    title: 'Enviar mensagem',
    description:
      'Envia uma mensagem de texto na conversa, pelo WhatsApp da conexão dela, assinada pelo usuário dono da credencial. Vai de verdade ' +
      'para o cliente. client_message_id torna o envio idempotente: repetir com o mesmo valor não manda de novo.',
    perm: 'chat.view',
    kind: 'write',
    input: {
      id: UUID.describe('id da conversa'),
      text: z.string().min(1).max(65_536),
      client_message_id: z.string().min(1).max(200).optional(),
      quoted_id: UUID.optional().describe('id da mensagem a responder (citar)'),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('POST', `/api/chats/${a.id}/messages`, {
          body: compact({ type: 'text', text: a.text, client_message_id: a.client_message_id, quoted_id: a.quoted_id }),
        }),
      ),
  }),

  tool({
    name: 'add_conversation_note',
    title: 'Adicionar nota interna',
    description: 'Adiciona uma nota interna na conversa (só a equipe vê; não vai para o cliente).',
    perm: 'chat.view',
    kind: 'write',
    input: { id: UUID, body: z.string().min(1).max(20_000) },
    run: async (a, api) => fromApi(await api.request('POST', `/api/chats/${a.id}/notes`, { body: { body: a.body } })),
  }),

  tool({
    name: 'update_conversation',
    title: 'Alterar conversa',
    description:
      'Muda departamento e/ou agente de IA da conversa (null tira) e/ou coloca no quadro Kanban: crm_id + crm_column_id cria ou move o ' +
      'card; crm_column_id null tira do quadro (exige kanban.edit).',
    perm: 'chat.view',
    kind: 'write',
    input: {
      id: UUID,
      department_id: UUID.nullable().optional(),
      ai_agent_id: UUID.nullable().optional(),
      crm_id: UUID.optional(),
      crm_column_id: UUID.nullable().optional(),
    },
    run: async ({ id, ...body }, api) => {
      if (Object.keys(compact(body)).length === 0) return fail({ error: 'Informe ao menos um campo para alterar' })
      return fromApi(await api.request('PATCH', `/api/chats/${id}`, { body: compact(body) }))
    },
  }),

  tool({
    name: 'set_conversation_status',
    title: 'Resolver ou reabrir conversa',
    description: 'resolve = marca como resolvida; reopen = reabre uma resolvida.',
    perm: 'chat.view',
    kind: 'write',
    input: { id: UUID, action: z.enum(['resolve', 'reopen']) },
    run: async (a, api) => fromApi(await api.request('POST', `/api/chats/${a.id}/${a.action}`)),
  }),

  tool({
    name: 'assign_conversation',
    title: 'Atribuir conversa',
    description: 'Atribui a conversa a um atendente (user_id) ou tira o atendente (user_id null).',
    perm: 'chat.view',
    kind: 'write',
    input: { id: UUID, user_id: UUID.nullable() },
    run: async (a, api) =>
      fromApi(
        a.user_id === null
          ? await api.request('POST', `/api/chats/${a.id}/unassign`)
          : await api.request('POST', `/api/chats/${a.id}/assign`, { body: { user_id: a.user_id } }),
      ),
  }),

  tool({
    name: 'label_conversation',
    title: 'Etiquetar conversa',
    description: 'Adiciona (add) ou remove (remove) uma etiqueta da conversa. Ids das etiquetas em list_labels.',
    perm: 'chat.view',
    kind: 'write',
    input: { id: UUID, label_id: UUID, action: z.enum(['add', 'remove']) },
    run: async (a, api) =>
      a.action === 'add'
        ? fromApi(await api.request('POST', `/api/chats/${a.id}/labels`, { body: { label_id: a.label_id } }))
        : fromApi(await api.request('DELETE', `/api/chats/${a.id}/labels/${a.label_id}`)),
  }),
]


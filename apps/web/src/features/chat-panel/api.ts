// Dados do painel lateral (T91; spec 03 F52–F59): contato (T26), kanban (T50), departamentos/atendentes/etiquetas
// (filter-options da T48), agentes (T39), notas e etiquetas do chat (T48), fluxos (T43) e agendamentos (T64).
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { CHAT_LIST_KEY, filterOptionsQuery, type ChatListItem } from '@/features/chat-list/api'
import { applyToCache } from '@/features/chat-list/realtime'
import { api, HttpError } from '@/lib/http'

const enc = encodeURIComponent

/** 403/404 → `null` (o usuário não tem a permissão da seção): a seção some em vez de quebrar o painel. */
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null
    throw err
  }
}

export interface ContactDto {
  id: string
  name: string
  phone_e164: string | null
  email: string | null
  labels: { id: string; name: string; color?: string | null }[]
}

export interface Named {
  id: string
  name: string
}

export interface FlowRunDto {
  id: string
  flow_id: string
  flow_name: string | null
  status: string
  started_at: string
}

export interface NoteDto {
  id: string
  body: string
  author: { id: string; name: string } | null
  created_at: string
}

export interface ScheduleDto {
  id: string
  chat_id: string
  kind: 'message' | 'flow'
  text: string | null
  flow_id: string | null
  run_at: string
  recurrence: 'one_off' | 'daily' | 'weekly' | 'monthly'
  status: 'pending' | 'sent' | 'failed' | 'cancelled'
  last_error: string | null
}

export const panelKey = (chatId: string, part: string) => ['chat-panel', chatId, part] as const

export const contactQuery = (contactId: string | undefined) =>
  queryOptions({
    queryKey: ['chat-panel', 'contact', contactId ?? ''] as const,
    queryFn: () => optional(async () => (await api.get<{ contact: ContactDto }>(`/api/contacts/${enc(contactId!)}`)).contact),
    enabled: !!contactId,
    staleTime: 30_000,
  })

export { filterOptionsQuery }

/** Todos os departamentos (com `settings.departments.view`); sem a permissão, os do escopo (filter-options). */
export const departmentsQuery = () =>
  queryOptions({
    queryKey: ['chat-panel', 'departments'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: Named[] }>('/api/departments/all')).items),
    staleTime: 60_000,
  })

export const agentsQuery = () =>
  queryOptions({
    queryKey: ['chat-panel', 'ai-agents'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: (Named & { status: string })[] }>('/api/ai-agents')).items),
    staleTime: 60_000,
  })

export const boardsQuery = () =>
  queryOptions({
    queryKey: ['chat-panel', 'crms'] as const,
    queryFn: async () => {
      const boards = await optional(async () => (await api.get<{ items: Named[] }>('/api/crms')).items)
      if (!boards) return null
      return Promise.all(
        boards.map(async (b) => ({ ...b, columns: (await optional(async () => (await api.get<{ items: Named[] }>(`/api/crms/${enc(b.id)}/columns`)).items)) ?? [] })),
      )
    },
    staleTime: 60_000,
  })

export type Board = Named & { columns: Named[] }

/** Quadro/etapa do chat: o chat aparece em `GET /api/chats?crm_id&crm_column_id&contact_id` da coluna onde está. */
export const kanbanLocationQuery = (chat: Pick<ChatListItem, 'id' | 'contact_id'> | undefined, boards: Board[] | null | undefined) =>
  queryOptions({
    queryKey: panelKey(chat?.id ?? '', 'kanban'),
    queryFn: async (): Promise<{ crmId: string; columnId: string } | null> => {
      for (const b of boards ?? []) {
        const hits = await Promise.all(
          b.columns.map(async (col) => {
            const r = await api.get<{ items: { id: string }[] }>('/api/chats', { query: { crm_id: b.id, crm_column_id: col.id, contact_id: chat!.contact_id, limit: 50 } })
            return r.items.some((x) => x.id === chat!.id) ? col.id : null
          }),
        )
        const columnId = hits.find(Boolean)
        if (columnId) return { crmId: b.id, columnId }
      }
      return null
    },
    enabled: !!chat && !!boards,
    staleTime: 15_000,
  })

export const notesQuery = (chatId: string) =>
  queryOptions({ queryKey: panelKey(chatId, 'notes'), queryFn: async () => (await api.get<{ items: NoteDto[] }>(`/api/chats/${enc(chatId)}/notes`)).items })

export const flowRunsQuery = (chatId: string) =>
  queryOptions({
    queryKey: panelKey(chatId, 'flow-runs'),
    queryFn: () => optional(async () => (await api.get<{ items: FlowRunDto[] }>(`/api/chats/${enc(chatId)}/flow-runs`, { query: { active: 1 } })).items),
    refetchInterval: 15_000,
  })

/** Fluxos acionáveis: ativos e com versão publicada (T43). */
export const triggerableFlowsQuery = () =>
  queryOptions({
    queryKey: ['chat-panel', 'triggerable-flows'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: Named[] }>('/api/flows/names', { query: { triggerable: 1 } })).items),
    staleTime: 30_000,
  })

export const schedulesQuery = (chatId: string) =>
  queryOptions({
    queryKey: panelKey(chatId, 'schedules'),
    queryFn: async () => (await api.get<{ items: ScheduleDto[] }>(`/api/chats/${enc(chatId)}/schedules`, { query: { status: 'pending' } })).items,
  })

export interface ScheduleInput {
  kind: 'message' | 'flow'
  text?: string
  quick_reply_id?: string | null
  flow_id?: string
  run_at: string
  recurrence: ScheduleDto['recurrence']
}

type ChatResponse = { chat: ChatListItem }

export const panelApi = {
  patchChat: (chatId: string, body: Record<string, unknown>) => api.patch<ChatResponse>(`/api/chats/${enc(chatId)}`, body),
  assign: (chatId: string, userId: string) => api.post<ChatResponse>(`/api/chats/${enc(chatId)}/assign`, { user_id: userId }),
  unassign: (chatId: string) => api.post<ChatResponse>(`/api/chats/${enc(chatId)}/unassign`),
  addLabel: (chatId: string, labelId: string) => api.post<ChatResponse>(`/api/chats/${enc(chatId)}/labels`, { label_id: labelId }),
  removeLabel: (chatId: string, labelId: string) => api.delete<ChatResponse>(`/api/chats/${enc(chatId)}/labels/${enc(labelId)}`),
  addNote: (chatId: string, body: string) => api.post(`/api/chats/${enc(chatId)}/notes`, { body }),
  cancelRun: (runId: string) => api.post(`/api/flow-runs/${enc(runId)}/cancel`),
  trigger: (flowId: string, chatId: string) => api.post(`/api/flows/${enc(flowId)}/trigger`, { chat_id: chatId }),
  createSchedule: (chatId: string, input: ScheduleInput) => api.post<{ schedule: ScheduleDto }>(`/api/chats/${enc(chatId)}/schedules`, input),
  cancelSchedule: (id: string) => api.delete<{ schedule: ScheduleDto }>(`/api/schedules/${enc(id)}`),
}

/** Atualiza o chat em todos os caches (detalhe e listas da T69); o SSE ainda confirma depois. */
export function applyChat(qc: QueryClient, chat: ChatListItem | undefined): void {
  if (!chat) return
  qc.setQueryData(['chat', chat.id], chat)
  applyToCache(qc, chat)
  void qc.invalidateQueries({ queryKey: CHAT_LIST_KEY, refetchType: 'active' })
}

// ---- regras do agendamento ------------------------------------------------------------------------------------

export const SCHEDULE_MAX_DAYS = 31

/** `datetime-local` (hora local) → ISO; `null` se inválido. */
export function localToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** ISO → valor do `datetime-local` na hora local. */
export function isoToLocal(iso: string | Date): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Mesma janela da T64: depois de agora e até 31 dias. */
export function scheduleWindowProblem(iso: string, now = Date.now()): 'past' | 'too_far' | null {
  const t = Date.parse(iso)
  if (t <= now) return 'past'
  if (t - now > SCHEDULE_MAX_DAYS * 24 * 3600_000) return 'too_far'
  return null
}

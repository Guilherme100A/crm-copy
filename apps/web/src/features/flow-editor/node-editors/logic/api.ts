// Dados reais dos editores da T57 (AC-T57-03/04): etiquetas, departamentos, quadros/colunas, agentes, equipe, fluxos,
// campos, variáveis globais, modelos de IA, chaves BYOK e pixels. Sem permissão (403) ou rota ausente (404) a lista
// volta vazia com `denied` — o editor mostra o aviso e continua utilizável (padrão `optional()` da T56).
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'

export interface Listed<T> {
  items: T[]
  denied: boolean
}

async function optional<T>(load: () => Promise<T[]>): Promise<Listed<T>> {
  try {
    return { items: await load(), denied: false }
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return { items: [], denied: true }
    throw err
  }
}

export interface LabelItem {
  id: string
  name: string
  color: string | null
}
export interface DepartmentItem {
  id: string
  name: string
  color: string | null
}
export interface BoardItem {
  id: string
  name: string
}
export interface ColumnItem {
  id: string
  name: string
  position: number
  conversion_goal: boolean
}
export interface AgentItem {
  id: string
  name: string
  status: string
}
export interface MemberItem {
  user_id: string
  name: string
  email: string
}
export interface NamedItem {
  id: string
  name: string
}
export interface GlobalVariableItem {
  name: string
  type: 'text' | 'number' | string
}
export interface ModelOptions {
  providers: { provider: string; available: boolean }[]
  models: { provider: string; model: string }[]
}
export interface AiKeyItem {
  id: string
  provider: string
  name: string
  hint: string
  active: boolean
}
export interface PixelItem {
  id: string
  name: string
  masked_pixel_id: string
}

const KEY = ['flow-node-editors-logic'] as const
const opts = { staleTime: 30_000, retry: false } as const

export const labelsQuery = () =>
  queryOptions({ queryKey: [...KEY, 'labels'], ...opts, queryFn: () => optional(async () => (await api.get<{ items: LabelItem[] }>('/api/labels')).items) })

export const departmentsQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'departments'],
    ...opts,
    queryFn: () => optional(async () => (await api.get<{ items: DepartmentItem[] }>('/api/departments/all')).items),
  })

export const boardsQuery = () =>
  queryOptions({ queryKey: [...KEY, 'boards'], ...opts, queryFn: () => optional(async () => (await api.get<{ items: BoardItem[] }>('/api/crms')).items) })

export const columnsQuery = (crmId: string) =>
  queryOptions({
    queryKey: [...KEY, 'columns', crmId],
    ...opts,
    enabled: !!crmId,
    queryFn: () =>
      optional(async () => [...(await api.get<{ items: ColumnItem[] }>(`/api/crms/${encodeURIComponent(crmId)}/columns`)).items].sort((a, b) => a.position - b.position)),
  })

export const agentsQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'agents'],
    ...opts,
    queryFn: () => optional(async () => (await api.get<{ items: AgentItem[] }>('/api/ai-agents')).items),
  })

export const teamQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'team'],
    ...opts,
    queryFn: () =>
      optional(async () =>
        (await api.get<{ items: { user_id: string; user: { name: string; email: string } }[] }>('/api/team')).items.map((m) => ({ user_id: m.user_id, name: m.user.name, email: m.user.email })),
      ),
  })

export const flowNamesQuery = () =>
  queryOptions({ queryKey: [...KEY, 'flows'], ...opts, queryFn: () => optional(async () => (await api.get<{ items: NamedItem[] }>('/api/flows/names')).items) })

export const customFieldsQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'custom-fields'],
    ...opts,
    queryFn: () => optional(async () => (await api.get<{ items: { key: string }[] }>('/api/custom-fields')).items.map((f) => f.key)),
  })

export const globalVariablesQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'globals'],
    ...opts,
    queryFn: () => optional(async () => (await api.get<{ items: GlobalVariableItem[] }>('/api/global-variables', { query: { limit: 100 } })).items),
  })

/** Provedores com chave (empresa ou plataforma) e o catálogo de modelos (T88). Sem acesso → nenhum disponível. */
export const modelOptionsQuery = () =>
  queryOptions({
    queryKey: [...KEY, 'model-options'],
    ...opts,
    queryFn: async (): Promise<ModelOptions & { denied: boolean }> => {
      try {
        return { ...(await api.get<ModelOptions>('/api/ai-agents/model-options')), denied: false }
      } catch (err) {
        if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return { providers: [], models: [], denied: true }
        throw err
      }
    },
  })

export const aiKeysQuery = () =>
  queryOptions({ queryKey: [...KEY, 'ai-keys'], ...opts, queryFn: () => optional(async () => (await api.get<{ items: AiKeyItem[] }>('/api/ai-keys')).items) })

export const pixelsQuery = () =>
  queryOptions({ queryKey: [...KEY, 'pixels'], ...opts, queryFn: () => optional(async () => (await api.get<{ items: PixelItem[] }>('/api/meta/pixels')).items) })

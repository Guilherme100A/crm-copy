// Dados da lista de fluxos (T44 sobre a API da T28/T43): `GET /api/flows` sem filtro traz todos os fluxos e pastas
// da empresa (a árvore, os contadores e os filtros saem daí), e as ações da lista (06 §5.1). Toda mutação invalida
// `flowsQuery`; o editor (T45) tem o seu próprio FlowDto, sem `folder_id`/`position`.
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'

export const FLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type FlowStatus = (typeof FLOW_STATUSES)[number]
export const FOLDER_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'yellow', 'gray'] as const
export type FolderColor = (typeof FOLDER_COLORS)[number]

export interface FlowDto {
  id: string
  name: string
  description: string | null
  status: FlowStatus
  folder_id: string | null
  position: number
  published_version: number | null
  nodes_count: number
  created_at: string
  updated_at: string
}

export interface FolderDto {
  id: string
  name: string
  color: FolderColor
  parent_id: string | null
  position: number
  created_at: string
  updated_at: string
}

export interface FlowReference {
  kind: 'connection_flow_config' | 'business_hour_config'
  id: string
  name?: string | null
}

export interface DeletionImpact {
  active_runs: number
  total_runs: number
  connection_flow_configs: FlowReference[]
  business_hour_configs: FlowReference[]
  referenced_by_flows: { id: string; name: string; node_ids: string[] }[]
}

export interface ImportResult {
  items: { code: string; flow: FlowDto; warnings: unknown[] }[]
  errors: { code: string; reason: 'invalid_code' }[]
}

export const flowsQueryKey = ['flows', 'list'] as const

export const flowsQuery = () =>
  queryOptions({
    queryKey: flowsQueryKey,
    queryFn: () => api.get<{ items: FlowDto[]; folders: FolderDto[] }>('/api/flows'),
  })

const enc = encodeURIComponent

export const flowsApi = {
  create: (body: { name: string; folder_id: string | null }) =>
    api.post<{ flow: FlowDto }>('/api/flows', body).then((r) => r.flow),
  rename: (id: string, name: string) =>
    api.patch<{ flow: FlowDto }>(`/api/flows/${enc(id)}`, { name }).then((r) => r.flow),
  duplicate: (id: string) => api.post<{ flow: FlowDto }>(`/api/flows/${enc(id)}/duplicate`).then((r) => r.flow),
  setStatus: (id: string, action: 'activate' | 'pause' | 'archive' | 'unarchive') =>
    api.post(`/api/flows/${enc(id)}/${action}`),
  move: (id: string, folderId: string | null) => api.post(`/api/flows/${enc(id)}/move`, { folder_id: folderId }),
  reorder: (id: string, position: number) => api.post(`/api/flows/${enc(id)}/reorder`, { position }),
  impact: (id: string) => api.get<DeletionImpact>(`/api/flows/${enc(id)}/deletion-impact`),
  /** `force` desvincula/desativa as configs que usam o fluxo (decisão do Orquestrador, T44). */
  remove: (id: string, force: boolean) => api.delete(`/api/flows/${enc(id)}`, force ? { query: { force: 1 } } : {}),
  shareCode: (id: string) => api.get<{ code: string }>(`/api/flows/${enc(id)}/share-code`).then((r) => r.code),
  importCodes: (codes: string[]) => api.post<ImportResult>('/api/flows/import', { codes }),
  createFolder: (body: { name: string; color: FolderColor; parent_id: string | null }) =>
    api.post<{ folder: FolderDto }>('/api/flow-folders', body).then((r) => r.folder),
  updateFolder: (id: string, body: Partial<{ name: string; color: FolderColor; position: number }>) =>
    api.patch<{ folder: FolderDto }>(`/api/flow-folders/${enc(id)}`, body).then((r) => r.folder),
  moveFolder: (id: string, parentId: string | null) =>
    api.post(`/api/flow-folders/${enc(id)}/move`, { parent_id: parentId }),
  removeFolder: (id: string) => api.delete(`/api/flow-folders/${enc(id)}`),
}

/** Envia as posições do `reorderPlan` em sequência (o servidor não renumera). */
export async function applyReorder(plan: readonly { id: string; position: number }[]): Promise<void> {
  for (const p of plan) await flowsApi.reorder(p.id, p.position)
}

/** Configs listadas no 409 `flow_referenced` do DELETE (ou `null` se o erro é outro). */
export function referencedConfigs(err: unknown): FlowReference[] | null {
  if (!(err instanceof HttpError) || err.status !== 409) return null
  const d = err.details as { error_code?: string; references?: FlowReference[] } | undefined
  return d?.error_code === 'flow_referenced' ? (d.references ?? []) : null
}

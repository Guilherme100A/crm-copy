// API do editor (T28): pacote do editor (fluxo + rascunho), salvar o rascunho inteiro, ativar/pausar e renomear.
import { queryOptions } from '@tanstack/react-query'
import type { FlowDefinition } from '@crm/shared/flows'
import { api, HttpError } from '@/lib/http'
import type { ValidationIssue } from './model'

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived'

export interface FlowDto {
  id: string
  name: string
  description: string | null
  status: FlowStatus
  published_version: number | null
  nodes_count: number
  updated_at: string
}

export interface EditorBundle {
  flow: FlowDto
  definition: FlowDefinition
}

const enc = encodeURIComponent

export const bundleKey = (id: string) => ['flow-editor', 'bundle', id] as const

export const bundleQuery = (id: string) =>
  queryOptions({ queryKey: bundleKey(id), queryFn: () => api.get<EditorBundle>(`/api/flows/${enc(id)}/editor-bundle`), staleTime: Infinity })

export const flowApi = {
  save: async (id: string, def: FlowDefinition) => (await api.put<{ definition: FlowDefinition }>(`/api/flows/${enc(id)}/definition`, def)).definition,
  rename: async (id: string, name: string) => (await api.patch<{ flow: FlowDto }>(`/api/flows/${enc(id)}`, { name })).flow,
  pause: async (id: string) => (await api.post<{ flow: FlowDto }>(`/api/flows/${enc(id)}/pause`)).flow,
  /** Ativa; fluxo inválido devolve os erros por nó (422 da T28). */
  activate: async (id: string): Promise<{ ok: true; flow: FlowDto } | { ok: false; issues: ValidationIssue[] }> => {
    try {
      return { ok: true, flow: (await api.post<{ flow: FlowDto }>(`/api/flows/${enc(id)}/activate`)).flow }
    } catch (err) {
      const issues = activationIssues(err)
      if (issues) return { ok: false, issues }
      throw err
    }
  },
}

/** Erros do 422 de ativação (`details.errors`), ou `null` se o erro é outro. */
export function activationIssues(err: unknown): ValidationIssue[] | null {
  if (!(err instanceof HttpError) || err.status !== 422) return null
  const raw = (err.details as { errors?: unknown } | undefined)?.errors
  if (!Array.isArray(raw)) return null
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({ nodeId: typeof e.nodeId === 'string' ? e.nodeId : null, code: String(e.code ?? ''), message: String(e.message ?? '') }))
}

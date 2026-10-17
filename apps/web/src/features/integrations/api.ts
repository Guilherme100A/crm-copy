// API das chaves de IA BYOK (T38; 19 §3.3 adaptado aos provedores reais): listar, criar, editar (segredo só quando
// preenchido: em branco mantém o atual), excluir (409 com os agentes/fluxos que usam a chave; `force=1` remove assim
// mesmo) e testar no provedor (latência ou erro, sempre 200). O segredo nunca volta no DTO. Tipos locais (fora do shared).
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export const AI_KEY_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq'] as const
export type AiKeyProvider = (typeof AI_KEY_PROVIDERS)[number]

export interface AiKeyDto {
  id: string
  provider: AiKeyProvider
  name: string
  configured: boolean
  /** Últimos caracteres mascarados (`…abcd`). */
  hint: string
  active: boolean
  in_use: boolean
  last_tested_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

export interface AiKeyTestResult {
  ok: boolean
  latency_ms: number
  error?: string
}

export interface AiKeyInUse {
  agents: { id: string; name: string }[]
  flows: { id: string; name: string }[]
}

export const AI_KEYS_KEY = ['integrations', 'ai-keys'] as const

export const fetchAiKeys = async () => (await api.get<{ items: AiKeyDto[] }>('/api/ai-keys')).items

export const aiKeysQuery = () => queryOptions({ queryKey: AI_KEYS_KEY, queryFn: fetchAiKeys })

export interface AiKeyCreate {
  provider: AiKeyProvider
  name: string
  secret: string
  active?: boolean
}

export interface AiKeyPatch {
  name?: string
  secret?: string
  active?: boolean
}

/** Corpo do PATCH: o segredo só vai quando tem conteúdo (AC-T59-04: em branco mantém o atual). */
export function patchBody(input: { name: string; secret: string; active: boolean }): AiKeyPatch {
  const body: AiKeyPatch = { name: input.name.trim(), active: input.active }
  if (input.secret.trim()) body.secret = input.secret.trim()
  return body
}

const enc = encodeURIComponent

export const aiKeysApi = {
  create: async (input: AiKeyCreate) => (await api.post<{ key: AiKeyDto }>('/api/ai-keys', input)).key,
  update: async (id: string, input: AiKeyPatch) => (await api.patch<{ key: AiKeyDto }>(`/api/ai-keys/${enc(id)}`, input)).key,
  remove: (id: string, force = false) => api.delete<{ ok: true }>(`/api/ai-keys/${enc(id)}`, force ? { query: { force: 1 } } : {}),
  test: (id: string) => api.post<AiKeyTestResult>(`/api/ai-keys/${enc(id)}/test`),
}

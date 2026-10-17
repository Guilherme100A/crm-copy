// Regras puras do grupo externos (T42/T104; 06 §3.6): requisição HTTP (headers e mapeamento de resposta em linhas
// editáveis ↔ `record` do schema), Bloco de IA (provedor do `ai_call` × provedores da API de modelos, chaves BYOK,
// saídas condicionais com `output_key` estável) e o nó Pixel. Réplica dos presets de `nodes/external/handlers.ts`.
import { AI_CALL_PROVIDERS, MAX_AI_OUTPUT_CONDITIONS } from '@crm/shared/flows'
import { defineLocalRules, outputId, setField, type Config, type FieldErrors } from '../logic/rules'

export { AI_CALL_PROVIDERS, MAX_AI_OUTPUT_CONDITIONS }

// ---------------------------------------------------------------- HTTP

export const HTTP_METHODS = ['GET', 'POST', 'PUT'] as const

export interface Row {
  key: string
  value: string
}

export const rowsOf = (record: unknown): Row[] =>
  record && typeof record === 'object' && !Array.isArray(record) ? Object.entries(record as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') })) : []

/**
 * Erros das linhas (nome repetido, valor sem nome) por índice: `{ '1.key': … }`. Linha toda vazia é ignorada.
 * Com erro o `record` não é gravado (o editor bloqueia como no schema).
 */
export function rowsErrors(rows: readonly Row[]): FieldErrors {
  const out: FieldErrors = {}
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    const k = r.key.trim()
    if (!k && !r.value.trim()) return
    if (!k) out[`${i}.key`] = { key: 'required' }
    else if (seen.has(k.toLowerCase())) out[`${i}.key`] = { key: 'duplicateName' }
    else if (!r.value.trim()) out[`${i}.value`] = { key: 'required' }
    seen.add(k.toLowerCase())
  })
  return out
}

/** Sem erros de linha (as linhas podem virar o `record` salvo). */
export const isClean = (errors: FieldErrors) => Object.keys(errors).length === 0

/** Linhas → `record` (sem as vazias); nenhuma linha → `undefined` (a chave sai da config). */
export function recordOf(rows: readonly Row[]): Record<string, string> | undefined {
  const entries = rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Caminho de resposta com ponto (`data.status`, `items.0.id`). */
export const isPath = (path: string) => /^[^\s.]+(\.[^\s.]+)*$/.test(path.trim())

/** Nome de variável do mapeamento: sem espaço nem chaves. */
export const isVariableName = (name: string) => /^[A-Za-z_][\w.]*$/.test(name.trim())

export function mappingErrors(rows: readonly Row[]): FieldErrors {
  const out = rowsErrors(rows)
  rows.forEach((r, i) => {
    if (r.key.trim() && !out[`${i}.key`] && !isVariableName(r.key)) out[`${i}.key`] = { key: 'variableName' }
    if (r.value.trim() && !out[`${i}.value`] && !isPath(r.value)) out[`${i}.value`] = { key: 'path' }
  })
  return out
}

/** Corpo que parece JSON (`{`/`[`) mas não é — só aviso: variáveis sem aspas são válidas no envio. */
export function bodyLooksBroken(body: string): boolean {
  const s = body.trim()
  if (!s || !/^[[{]/.test(s)) return false
  try {
    JSON.parse(s.replace(/\{[A-Za-z_][\w.]*\}/g, '0'))
    return false
  } catch {
    return true
  }
}

export const withMethod = (c: Config, method: (typeof HTTP_METHODS)[number]): Config => setField({ ...c, request_method: method }, 'request_body', method === 'GET' ? undefined : c.request_body)

defineLocalRules('make_http_request', (c): FieldErrors => {
  const url = typeof c.request_url === 'string' ? c.request_url.trim() : ''
  if (url && !/^(https?:\/\/|\{)/i.test(url)) return { request_url: { key: 'url' } }
  return {}
})

// ---------------------------------------------------------------- IA

export type AiProvider = (typeof AI_CALL_PROVIDERS)[number]

/** Provedor do `ai_call` → provedor da API de modelos/chaves (T88/T38). `platform` usa o preset OpenAI da plataforma. */
export const API_PROVIDER: Record<AiProvider, string> = { gpt: 'openai', gemini: 'google', openrouter: 'openrouter', platform: 'openai' }
/** Modelo que o motor usa quando o campo fica vazio. */
export const DEFAULT_MODEL: Record<AiProvider, string> = { gpt: 'gpt-4.1-mini', gemini: 'gemini-2.5-flash', openrouter: 'openai/gpt-4.1-mini', platform: 'gpt-4.1-mini' }
/** Chave BYOK → provedor do `ai_call` (anthropic não tem preset: mantém o atual). */
export const KEY_PROVIDER: Record<string, AiProvider> = { openai: 'gpt', google: 'gemini', openrouter: 'openrouter' }
export const LLM_KEY_PROVIDERS = ['openai', 'google', 'openrouter', 'anthropic'] as const

/** Disponibilidade de cada provedor do enum pela lista da API (`available:false` → desabilitado, "sem chave"). */
export function providerAvailability(providers: readonly { provider: string; available: boolean }[]): Record<AiProvider, boolean> {
  const ok = new Map(providers.map((p) => [p.provider, p.available]))
  return Object.fromEntries(AI_CALL_PROVIDERS.map((p) => [p, ok.get(API_PROVIDER[p]) === true])) as Record<AiProvider, boolean>
}

/** Modelos do catálogo para o provedor do `ai_call` (o modelo salvo fora do catálogo continua na lista). */
export function modelsFor(provider: AiProvider, models: readonly { provider: string; model: string }[], current?: string): string[] {
  const names = models.filter((m) => m.provider === API_PROVIDER[provider]).map((m) => m.model)
  if (current && !names.includes(current)) names.unshift(current)
  return [...new Set(names)]
}

/** Chaves BYOK que servem ao bloco (LLM e ativas). */
export const llmKeys = <K extends { provider: string; active: boolean }>(keys: readonly K[]): K[] => keys.filter((k) => k.active && (LLM_KEY_PROVIDERS as readonly string[]).includes(k.provider))

export const KEY_SOURCES = ['platform', 'integration'] as const
export type KeySource = (typeof KEY_SOURCES)[number] | 'manual'

/** Origem atual: `integration` (chave BYOK), `manual` (legado, chave na config) ou a padrão da empresa/plataforma. */
export const keySourceOf = (c: Config): KeySource => (c.api_key_source === 'integration' ? 'integration' : c.api_key_source === 'manual' ? 'manual' : 'platform')

export function withKeySource(c: Config, source: KeySource): Config {
  let next = { ...c }
  if (source === 'integration') next.api_key_source = 'integration'
  else if (source === 'manual') next.api_key_source = 'manual'
  else next = setField(next, 'api_key_source', undefined)
  if (source !== 'integration') next = setField(next, 'ai_integration_id', undefined)
  if (source !== 'manual') next = setField(next, 'api_key', undefined)
  return next
}

/** Chave BYOK escolhida: o provedor do bloco acompanha a chave (o modelo do outro provedor sai). */
export function withIntegration(c: Config, key: { id: string; provider: string } | undefined): Config {
  let next = setField(c, 'ai_integration_id', key?.id)
  const provider = key ? KEY_PROVIDER[key.provider] : undefined
  if (provider && provider !== c.provider) next = setField({ ...next, provider }, 'model', undefined)
  return next
}

export const withProvider = (c: Config, provider: AiProvider): Config => (provider === c.provider ? c : setField({ ...c, provider }, 'model', undefined))

/** A chave manual nunca volta em texto: o campo mostra só se há uma salva. */
export const hasSavedKey = (c: Config) => typeof c.api_key === 'string' && c.api_key.length > 0

export interface OutputCondition {
  prompt: string
  output_key: string
}

export const conditionsOf = (c: Config): OutputCondition[] =>
  (Array.isArray(c.output_conditions) ? c.output_conditions : [])
    .filter((o): o is Config => !!o && typeof o === 'object')
    .map((o) => ({ prompt: typeof o.prompt === 'string' ? o.prompt : '', output_key: typeof o.output_key === 'string' ? o.output_key : '' }))

export const FALLBACK_KEY = 'outros'

/**
 * Nova saída condicional com `output_key` gerada uma vez (handle `output:<key>`). A primeira cria também a saída
 * padrão (`fallback_output_key`), que o schema exige quando há condições.
 */
export function addOutputCondition(c: Config, random?: () => number): Config {
  const list = conditionsOf(c)
  if (list.length >= MAX_AI_OUTPUT_CONDITIONS) return c
  const fallback = typeof c.fallback_output_key === 'string' && c.fallback_output_key ? c.fallback_output_key : FALLBACK_KEY
  const key = outputId([...list.map((o) => o.output_key), fallback], random, 'saida')
  return { ...c, output_conditions: [...list, { prompt: '', output_key: key }], fallback_output_key: fallback }
}

/** Remove a saída; sem nenhuma, a padrão também sai (volta a `success`/`failure`). */
export function removeOutputCondition(c: Config, key: string): Config {
  const list = conditionsOf(c).filter((o) => o.output_key !== key)
  if (list.length) return { ...c, output_conditions: list }
  return setField(setField(c, 'output_conditions', undefined), 'fallback_output_key', undefined)
}

export const patchOutputPrompt = (c: Config, key: string, prompt: string): Config => ({
  ...c,
  output_conditions: conditionsOf(c).map((o) => (o.output_key === key ? { ...o, prompt } : o)),
})

/** Texto de linhas (pix esperados, nomes) → lista sem vazias. */
export const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

/** Ao abrir: provedor padrão `platform` (créditos de IA da empresa). */
export const defaultAiCall = (): Config => ({ provider: 'platform', user_message: '{last_user_message}', system_prompt: '', response_variable: 'resposta_ia' })

// ---------------------------------------------------------------- Pixel

// Revisão 3: além de Compra e Lead (Leona), os eventos padrão da Meta; valor e moeda opcionais fora da Compra.
export const PIXEL_EVENTS = ['Compra', 'Lead', 'InitiateCheckout', 'AddToCart', 'CompleteRegistration', 'Contact', 'Schedule', 'Subscribe'] as const
export const CURRENCIES = ['BRL', 'USD', 'EUR'] as const
export const defaultPixel = (): Config => ({ pixel_config_id: '', event_type: 'Lead' })

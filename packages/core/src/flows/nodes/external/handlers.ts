// Handlers dos nós externos (T42): Integração HTTP (`make_http_request`, `success`/`failure`) e Bloco de IA
// (`ai_call`, `success`/`failure` ou `output:<chave>` com structured output). Toda chamada de IA passa pelo provedor
// medido da T24 (`feature = 'flow_ai'`). Leituras do passo só por `ctx.repo.db` (regra do STATUS).
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { LlmQuotaExceededError, type LlmMessage, type LlmProvider, type LlmProviderId, type LlmRequest, type LlmResult } from '@crm/ai'
import type { Database } from '@crm/db'
import type { FlowAction } from '@crm/shared'
import { ProviderNotConfiguredError } from '../../../ai-keys/errors'
import type { UsageGuard } from '../../../ai-metering/guard'
import { DEFAULT_OUTPUT_ESTIMATE, estimateInputTokens } from '../../../ai-metering/meter'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import { defaultGlobals } from '../messaging/data'
import { applyGlobals, runMessageAction, type MessagingDeps } from '../messaging/handlers'
import { HttpRequestError, getPath, safeHttpRequest, type SafeHttpOptions } from './http'

export const FLOW_AI_FEATURE = 'flow_ai'

export interface ExternalDeps {
  http?: SafeHttpOptions
  /** LLM das empresas (padrão: `ctx.llm` do motor). */
  llm?: LlmProvider
  /** LLM da integração escolhida (`ai_integration_id`). */
  llmForKey?: (companyId: string, keyId: string) => Promise<{ llm: LlmProvider; provider: LlmProviderId }>
  /** Cota e medição (T24). Com ele, toda chamada vira linha em `ai_usage` com `feature = 'flow_ai'`. */
  guard?: UsageGuard
  /** Repasse aos nós de mensagem (resposta automática da IA). */
  messaging?: MessagingDeps
}

const PROVIDERS: Record<string, { provider: LlmProviderId; model: string }> = {
  gpt: { provider: 'openai', model: 'gpt-4.1-mini' },
  platform: { provider: 'openai', model: 'gpt-4.1-mini' },
  gemini: { provider: 'google', model: 'gemini-2.5-flash' },
  openrouter: { provider: 'openrouter', model: 'openai/gpt-4.1-mini' },
}

type Config = Record<string, unknown>
const configOf = (ctx: NodeContext, type: string): Config => ((ctx.node.actions.find((a: FlowAction) => a.type === type)?.config ?? {}) as Config)

async function renderer(ctx: NodeContext): Promise<(s: string) => string> {
  const globals = /\{\{\s*global\.|\{\s*g_/.test(JSON.stringify(ctx.node.actions)) ? await defaultGlobals(ctx) : {}
  return (s: string) => ctx.render(applyGlobals(s, globals))
}

/** Strings internas renderizadas (corpo em objeto). */
function renderDeep(v: unknown, render: (s: string) => string): unknown {
  if (typeof v === 'string') return render(v)
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, render))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, render)]))
  return v
}

export class ExternalNodeError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'ExternalNodeError'
  }
}

// ---------------------------------------------------------------- HTTP

async function integration(ctx: NodeContext, deps: ExternalDeps): Promise<NodeOutcome> {
  const c = configOf(ctx, 'make_http_request')
  const render = await renderer(ctx)
  const method = String(c.request_method ?? 'GET').toUpperCase()
  const url = render(String(c.request_url ?? '')).trim()
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((c.request_headers ?? {}) as Record<string, unknown>)) if (k.trim()) headers[k.trim()] = render(String(v ?? ''))
  let body: string | null = null
  if (method !== 'GET' && c.request_body !== undefined && c.request_body !== null && c.request_body !== '') {
    if (typeof c.request_body === 'string') {
      body = render(c.request_body)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        let json: boolean
        try {
          JSON.parse(body)
          json = true
        } catch {
          json = false
        }
        headers['content-type'] = json ? 'application/json' : 'text/plain; charset=utf-8'
      }
    } else {
      body = JSON.stringify(renderDeep(c.request_body, render))
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
  }
  ctx.setVar('http_error', null)
  let res
  try {
    res = await safeHttpRequest({ method, url, headers, body }, deps.http)
  } catch (err) {
    const reason = err instanceof HttpRequestError ? err.reason : 'network_error'
    ctx.setVar('http_error', reason)
    throw err instanceof HttpRequestError ? err : new HttpRequestError('network_error', err instanceof Error ? err.message : String(err))
  }
  let data: unknown
  try {
    data = res.body ? JSON.parse(res.body) : null
  } catch {
    data = res.body
  }
  const ok = res.status >= 200 && res.status < 300
  ctx.setVar('response', { status: res.status, ok, headers: res.headers, data })
  for (const [variable, path] of Object.entries((c.response_mapping ?? {}) as Record<string, unknown>))
    if (variable.trim() && typeof path === 'string') ctx.setVar(variable.trim(), getPath(data, path) ?? null)
  for (const path of (c.response_fields ?? []) as unknown[]) if (typeof path === 'string' && path.trim()) ctx.setVar(path.trim(), getPath(data, path) ?? null)
  if (!ok) {
    const reason = `http_status_${res.status}`
    ctx.setVar('http_error', reason)
    throw new ExternalNodeError(reason, `resposta ${res.status}`)
  }
  return { next: 'success' }
}

// ---------------------------------------------------------------- IA

/**
 * LLM medido do nó (T24): reserva → provedor → commit (ou fail sem débito), com `feature = 'flow_ai'` e sem agente
 * (`ai_usage.agent_id` é de agentes de IA; o `meterLlm` usaria o `agentId` do pedido).
 */
function meteredFlowLlm(provider: LlmProvider, guard: UsageGuard, companyId: string): LlmProvider {
  return {
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const base = { provider: req.model.provider, model: req.model.model, kind: 'llm' as const, feature: FLOW_AI_FEATURE, agentId: null, companyId }
      const estimate = { provider: base.provider, model: base.model, usage: { inputTokens: estimateInputTokens(req as LlmRequest), outputTokens: req.maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE } }
      const r = await guard.reserve(companyId, estimate, FLOW_AI_FEATURE, { agentId: null, requestId: randomUUID() })
      let result: LlmResult<T>
      try {
        result = await provider.generate(req)
      } catch (err) {
        await guard.fail({ ...base, requestId: r.requestId, error: err })
        throw err
      }
      if (result.finish === 'error') {
        await guard.fail({ ...base, requestId: r.requestId, usage: result.usage, error: { code: result.error?.code ?? 'LLM_ERROR' } })
        return result
      }
      await guard.commit({ ...base, requestId: r.requestId, usage: result.usage })
      return result
    },
  }
}

/** Últimas N trocas do chat (crm.messages) como histórico do LLM. */
async function history(ctx: NodeContext, interactions: number): Promise<LlmMessage[]> {
  const db = (ctx.repo.db as Database | null) ?? null
  if (!db || !ctx.chatId) return []
  const rows = (
    await db.execute(sql`
      select direction, body from crm.messages
      where chat_id = ${ctx.chatId} and company_id = ${ctx.companyId} and body is not null and body <> ''
      order by created_at desc limit ${interactions * 2}`)
  ).rows as Array<{ direction: string; body: string }>
  return rows.reverse().map((r): LlmMessage => ({ role: r.direction === 'inbound' ? 'user' : 'assistant', content: [{ type: 'text', text: r.body }] }))
}

function failReason(err: unknown): string {
  if (err instanceof LlmQuotaExceededError || (err as { code?: unknown })?.code === 'QUOTA_EXCEEDED' || (err as { name?: unknown })?.name === 'LlmQuotaExceededError') return 'quota_exceeded'
  if (err instanceof ProviderNotConfiguredError || (err as { name?: unknown })?.name === 'ProviderNotConfiguredError') return 'provider_not_configured'
  return 'llm_error'
}

async function aiCall(ctx: NodeContext, deps: ExternalDeps): Promise<NodeOutcome> {
  const c = configOf(ctx, 'ai_call')
  const render = await renderer(ctx)
  const ai: { response: string | null; output: string | null; fail: { reason: string | null } } = { response: null, output: null, fail: { reason: null } }
  const setAi = () => {
    ctx.setVar('ai', ai)
    if (typeof c.response_variable === 'string' && c.response_variable.trim()) ctx.setVar(c.response_variable.trim(), ai.response)
    if (typeof c.fail_reason_variable === 'string' && c.fail_reason_variable.trim()) ctx.setVar(c.fail_reason_variable.trim(), ai.fail.reason)
  }
  const fail = (reason: string, message: string): never => {
    ai.fail.reason = reason
    setAi()
    throw new ExternalNodeError(reason, message)
  }

  const conditions = Array.isArray(c.output_conditions) ? (c.output_conditions as Array<{ prompt: string; output_key: string }>).filter((o) => o?.output_key) : []
  const fallback = typeof c.fallback_output_key === 'string' && c.fallback_output_key ? c.fallback_output_key : null
  const preset = PROVIDERS[String(c.provider ?? 'gpt')] ?? PROVIDERS.gpt!
  let provider: LlmProviderId = preset.provider
  let base: LlmProvider | undefined = deps.llm ?? ctx.llm
  try {
    if (c.api_key_source === 'integration' && typeof c.ai_integration_id === 'string' && c.ai_integration_id && deps.llmForKey) {
      const chosen = await deps.llmForKey(ctx.companyId, c.ai_integration_id)
      base = chosen.llm
      provider = chosen.provider
    }
  } catch (err) {
    fail(failReason(err) === 'llm_error' ? 'provider_not_configured' : failReason(err), err instanceof Error ? err.message : String(err))
  }
  if (!base) fail('provider_not_configured', 'nenhum provedor de IA configurado')
  const model = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : provider === preset.provider ? preset.model : (PROVIDERS[provider === 'google' ? 'gemini' : provider === 'openrouter' ? 'openrouter' : 'gpt']!.model)
  const llm = deps.guard ? meteredFlowLlm(base!, deps.guard, ctx.companyId) : base!

  const userMessage = render(typeof c.user_message === 'string' && c.user_message ? c.user_message : '{last_user_message}')
  const context = c.maintain_context === true ? await history(ctx, typeof c.context_interactions === 'number' ? c.context_interactions : 5) : []
  let instructions = render(typeof c.system_prompt === 'string' ? c.system_prompt : '')
  const keys = [...conditions.map((o) => o.output_key), ...(fallback ? [fallback] : [])]
  if (conditions.length)
    instructions = `${instructions}\n\nClassifique a mensagem do usuário em UMA das saídas abaixo e responda só com a chave escolhida em "output_key".\n${conditions
      .map((o) => `- ${o.output_key}: ${o.prompt}`)
      .join('\n')}${fallback ? `\n- ${fallback}: quando nenhuma das anteriores se aplica` : ''}`.trim()

  const request = {
    model: { provider, model },
    instructions: instructions || 'Você é um assistente.',
    messages: [...context, { role: 'user', content: [{ type: 'text', text: userMessage }] } satisfies LlmMessage],
    tenantId: ctx.companyId,
    agentId: `flow:${ctx.flowId}`,
    ...(conditions.length ? { output: z.object({ output_key: z.string() }) } : {}),
  }
  let result
  try {
    result = await llm.generate(request as never)
  } catch (err) {
    return fail(failReason(err), err instanceof Error ? err.message : String(err))
  }

  if (conditions.length) {
    const chosen = (result!.object as { output_key?: unknown } | undefined)?.output_key
    const valid = typeof chosen === 'string' && keys.includes(chosen) ? chosen : null
    if (!valid && result!.finish === 'error' && result!.error?.code !== 'OUTPUT_VALIDATION' && !fallback) return fail('llm_error', result!.error?.message ?? 'falha do provedor')
    ai.output = valid ?? fallback
    ai.response = result!.text || ai.output
    setAi()
    if (!ai.output) return fail('llm_error', 'saída inválida e sem saída padrão')
    return { next: `output:${ai.output}` }
  }
  if (result!.finish === 'error') return fail('llm_error', result!.error?.message ?? 'falha do provedor')
  ai.response = result!.text
  setAi()
  if (c.auto_send_response === true && ai.response?.trim())
    await runMessageAction(ctx, { id: `${ctx.node.id}:ai-response`, type: 'send_message', order: 0, config: { message_text: ai.response.replace(/\{/g, '\\{') } }, deps.messaging)
  return { next: 'success' }
}

export function externalHandlers(deps: ExternalDeps = {}): Record<'integration' | 'ai', NodeHandler> {
  return {
    integration: { execute: (ctx) => integration(ctx, deps) },
    ai: { execute: (ctx) => aiCall(ctx, deps) },
  }
}

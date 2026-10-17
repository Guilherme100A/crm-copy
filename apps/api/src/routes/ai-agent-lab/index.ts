// Laboratório de agentes (SPEC T79; 07 §5 itens 4–6, §6): teste ao vivo, geração de prompt, criação assistida
// (run em job `ai-agent-lab`), estimativa e transcrição do ditado. Edição com flows.edit; leitura do run com flows.view.
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { LlmProvider, SttProvider } from '@crm/ai'
import {
  AI_AGENT_LAB_QUEUE,
  AgentLabError,
  AgentLabService,
  AiKeysService,
  createCompanyLlmProvider,
  defineQueue,
  RealtimePublisher,
  resolveStt,
  UsageGuard,
  type AgentLabJobData,
  type RunPublisher,
  type SafeHttpOptions,
} from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Serviço pronto (testes). Default: montado com as deps abaixo. */
    aiAgentLab?: AgentLabService
    /** LLM do laboratório. Default: o fake do E2E, senão o LLM da empresa (chaves BYOK). */
    aiLabLlm?: LlmProvider
    /** Medição/cobrança (T24). Default `new UsageGuard({ db, redis })`; `null` desliga. */
    aiLabGuard?: UsageGuard | null
    /** Testes ao vivo por empresa por dia (default 200 ou `AI_AGENT_EVAL_CAP`). */
    aiLabEvalCap?: number
    /** Modelo da criação assistida sem preset `balanced` (default: env `AI_AGENT_CREATE_MODEL=provider:model`). */
    aiLabComposeModel?: { provider: string; model: string }
    /** HTTP SSRF-safe da leitura do site (testes: `allowHosts`). */
    aiLabSiteHttp?: SafeHttpOptions
    /** STT do ditado. Default: Groq com a chave da empresa. */
    aiLabStt?: SttProvider
    /** Publisher do `ai_agent.run.updated`. Default: realtime do Redis. */
    aiLabPublisher?: RunPublisher
    /** Enfileira o run. Default: fila BullMQ `ai-agent-lab`. */
    aiLabEnqueue?: (data: AgentLabJobData) => Promise<void>
    /** Processa o run no próprio processo (testes/E2E). */
    aiAgentLabInline?: boolean
  }
}

export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024

/**
 * LLM do laboratório (T92): `aiLabLlm` > o FakeLlm do E2E > o LLM da empresa. O do E2E é lido A CADA chamada: o
 * `POST /__e2e/reset` e o `/__e2e/llm/script` com `replace` trocam a instância de `deps.e2e.llm`.
 */
export function labLlm(deps: ResolvedDeps, fallback: () => LlmProvider): LlmProvider {
  if (deps.aiLabLlm) return deps.aiLabLlm
  const e2e = () => (deps as { e2e?: { llm?: LlmProvider } }).e2e?.llm
  if (!e2e()) return fallback()
  const current = () => e2e() ?? fallback()
  return { generate: (req) => current().generate(req) }
}

/** Serviço do processo da API (um por app). */
export function aiAgentLabService(deps: ResolvedDeps): AgentLabService {
  if (deps.aiAgentLab) return deps.aiAgentLab
  const keys = () => (deps.aiKeys as AiKeysService | undefined) ?? new AiKeysService({ db: deps.db, ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}) })
  const llm = labLlm(deps, () => createCompanyLlmProvider({ keys: keys() }))
  const capEnv = Number(process.env.AI_AGENT_EVAL_CAP)
  let queue: ReturnType<typeof defineQueue<AgentLabJobData>> | undefined
  deps.aiAgentLab = new AgentLabService({
    db: deps.db,
    redis: deps.redis,
    llm,
    guard: deps.aiLabGuard === undefined ? new UsageGuard({ db: deps.db, redis: deps.redis }) : deps.aiLabGuard,
    stt: deps.aiLabStt ?? ((companyId: string) => resolveStt(companyId, { keys: keys() })),
    publisher: deps.aiLabPublisher ?? (new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }) as unknown as RunPublisher),
    ...(deps.aiLabEvalCap !== undefined ? { evalCap: deps.aiLabEvalCap } : Number.isFinite(capEnv) && capEnv > 0 ? { evalCap: capEnv } : {}),
    ...(deps.aiLabSiteHttp ? { siteHttp: deps.aiLabSiteHttp } : {}),
    ...(deps.aiLabComposeModel ? { composeModel: deps.aiLabComposeModel } : {}),
    ...(deps.aiAgentLabInline
      ? { inline: true }
      : {
          enqueueRun:
            deps.aiLabEnqueue ??
            (async (data: AgentLabJobData) => {
              queue ??= defineQueue<AgentLabJobData>(AI_AGENT_LAB_QUEUE, { defaultJobOptions: { attempts: 1 } })
              await queue.add('create-agent', data, { jobId: `run-${data.runId}` })
            }),
        }),
    logger: deps.logger,
  })
  return deps.aiAgentLab
}

const STATUS: Record<AgentLabError['code'], 'NOT_FOUND' | 'VALIDATION_ERROR' | 'QUOTA_EXCEEDED' | 'CONFLICT'> = {
  not_found: 'NOT_FOUND',
  validation: 'VALIDATION_ERROR',
  not_configured: 'VALIDATION_ERROR',
  invalid_audio: 'VALIDATION_ERROR',
  eval_cap: 'QUOTA_EXCEEDED',
  no_balance: 'QUOTA_EXCEEDED',
  create_in_progress: 'CONFLICT',
}

async function lab<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AgentLabError) throw new ApiError(STATUS[err.code], err.message, { reason: err.code, ...err.details })
    throw err
  }
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

export function aiAgentLabRoutes(deps: ResolvedDeps) {
  const service = aiAgentLabService(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('flows.view')
  const edit = requirePerm('flows.edit')
  const userOf = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  // ---------- criação assistida (antes de /:id) ----------

  app.post('/api/ai-agents/runs/estimate', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await lab(async () => service.estimate(companyId, await jsonBody(c))), 200)
  })

  app.post('/api/ai-agents/runs', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const run = await lab(async () => service.createRun(companyId, userOf(c), await jsonBody(c)))
    setAudit(c, { action: 'ai_agents.assisted_create', targetType: 'ai_agent_run', targetId: run.id })
    return c.json({ run }, 202)
  })

  app.get('/api/ai-agents/runs/:runId', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ run: await lab(() => service.getRun(companyId, c.req.param('runId'))) }, 200)
  })

  app.post(
    '/api/ai-agents/transcriptions',
    edit,
    bodyLimit({ maxSize: TRANSCRIPTION_MAX_BYTES + 64 * 1024, onError: () => { throw new ApiError('PAYLOAD_TOO_LARGE', 'Áudio acima de 25 MB') } }),
    async (c) => {
      const { companyId } = getCompanyCtx(c)
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
      const file = (form as Record<string, unknown>).file
      if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', 'Envie o arquivo de áudio', { reason: 'invalid_audio', fields: [{ path: 'file', message: 'Envie o arquivo de áudio' }] })
      const bytes = new Uint8Array(await file.arrayBuffer())
      return c.json(await lab(() => service.transcribe(companyId, bytes, file.type || 'audio/ogg')), 200)
    },
  )

  // ---------- por agente ----------

  app.post('/api/ai-agents/:id/test-messages', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await lab(async () => service.testMessage(companyId, c.req.param('id'), userOf(c), await jsonBody(c))), 200)
  })

  app.delete('/api/ai-agents/:id/test-messages', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    await lab(() => service.resetTest(companyId, c.req.param('id'), userOf(c)))
    return c.json({ ok: true }, 200)
  })

  app.post('/api/ai-agents/:id/generate-prompt', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const out = await lab(() => service.generatePrompt(companyId, c.req.param('id')))
    setAudit(c, { action: 'ai_agents.generate_prompt', targetType: 'ai_agent', targetId: out.agent.id })
    return c.json(out, 200)
  })

  return app
}

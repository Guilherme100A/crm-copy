// Base de conhecimento dos agentes (SPEC T52; 07 §3.4, §6): fontes por agente com ingestão em job `ai-knowledge`.
// Ler: `flows.view`; criar/reindexar/excluir: `flows.edit` (as mesmas dos agentes, T39). Criação em JSON
// (`site`/`text`/`faq`/`flow`) ou multipart `kind` + `file` (+ `title`) para `pdf`/`text`/`file` (até 8 MB → 413).
import { AiKnowledgeError, AiKnowledgeService, defineQueue, KNOWLEDGE_FILE_MAX_BYTES, RealtimePublisher, type AiKnowledgeJobData, type CreateKnowledgeInput, type SafeHttpOptions } from '@crm/core'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Enfileira a ingestão (default: fila BullMQ `ai-knowledge` pelo `REDIS_URL`/`CRM_QUEUE_PREFIX`). */
    aiKnowledgeEnqueue?: (data: AiKnowledgeJobData, opts: { jobId: string }) => Promise<void>
    /** HTTP SSRF-safe do `site` (testes: `lookup`/`allowHosts`). */
    aiKnowledgeHttp?: SafeHttpOptions
  }
}

export const AI_KNOWLEDGE_QUEUE = 'ai-knowledge'
export const AI_KNOWLEDGE_JOB_OPTS = { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } } as const

const tooLarge = () => new ApiError('PAYLOAD_TOO_LARGE', 'Arquivo acima de 8 MB', { error_code: 'too_large', max_bytes: KNOWLEDGE_FILE_MAX_BYTES })

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof AiKnowledgeError)) throw err
    const code = ({ not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', limit_reached: 'LIMIT_REACHED', payload_too_large: 'PAYLOAD_TOO_LARGE' } as const)[err.code]
    throw new ApiError(code, err.message, err.details)
  }
}

/** JSON ou multipart → entrada do serviço. */
async function readInput(c: Context<AppEnv>): Promise<CreateKnowledgeInput> {
  const type = c.req.header('content-type') ?? ''
  if (/multipart\/form-data/i.test(type)) {
    const body = await c.req.parseBody()
    const file = body['file']
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
    if (file instanceof File && file.size > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge()
    return {
      kind: str('kind'),
      title: str('title'),
      body: str('body'),
      url: str('url'),
      flow_id: str('flow_id'),
      file: file instanceof File ? { filename: file.name || 'arquivo', contentType: file.type || null, data: new Uint8Array(await file.arrayBuffer()) } : null,
    }
  }
  const raw = await c.req.text()
  let json: unknown
  try {
    json = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError('MALFORMED_REQUEST', 'Envie um objeto JSON')
  // Envelope `{ knowledge_source: {...} }` também é aceito.
  const o = ('knowledge_source' in json ? (json as { knowledge_source: unknown }).knowledge_source : json) as Record<string, unknown>
  return { kind: o.kind, url: o.url, title: o.title, body: o.body, items: o.items, replace: o.replace, flow_id: o.flow_id, file: null }
}

export function aiKnowledgeRoutes(deps: ResolvedDeps) {
  let queue: ReturnType<typeof defineQueue<AiKnowledgeJobData>> | undefined
  let service: AiKnowledgeService | undefined
  const svc = () =>
    (service ??= new AiKnowledgeService({
      db: deps.db,
      publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
      enqueue:
        deps.aiKnowledgeEnqueue ??
        (async (data, opts) => {
          queue ??= defineQueue<AiKnowledgeJobData>(AI_KNOWLEDGE_QUEUE, { defaultJobOptions: AI_KNOWLEDGE_JOB_OPTS })
          await queue.add(AI_KNOWLEDGE_QUEUE, data, { jobId: opts.jobId })
        }),
      ...(deps.aiKnowledgeHttp ? { http: deps.aiKnowledgeHttp } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    }))
  const app = new Hono<AppEnv>()
  const view = requirePerm('flows.view')
  const edit = requirePerm('flows.edit')
  const base = '/api/ai-agents/:id/knowledge-sources'
  const limit = bodyLimit({
    maxSize: KNOWLEDGE_FILE_MAX_BYTES + 256 * 1024,
    onError: () => {
      throw tooLarge()
    },
  })

  app.get(base, view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => svc().list(companyId, c.req.param('id'))) }, 200)
  })

  app.post(base, edit, limit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const input = await readInput(c)
    const source = await domain(() => svc().create(companyId, c.req.param('id'), input))
    setAudit(c, { action: 'ai_knowledge.create', targetType: 'ai_knowledge_source', targetId: source.id, detail: { agent_id: source.agent_id, kind: source.kind, slot: source.slot } })
    return c.json({ source }, 201)
  })

  app.get(`${base}/:sid`, view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ source: await domain(() => svc().get(companyId, c.req.param('id'), c.req.param('sid'))) }, 200)
  })

  app.post(`${base}/:sid/reindex`, edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const source = await domain(() => svc().reindex(companyId, c.req.param('id'), c.req.param('sid')))
    setAudit(c, { action: 'ai_knowledge.reindex', targetType: 'ai_knowledge_source', targetId: source.id, detail: { agent_id: source.agent_id } })
    return c.json({ source }, 200)
  })

  app.delete(`${base}/:sid`, edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const sid = c.req.param('sid')
    await domain(() => svc().remove(companyId, c.req.param('id'), sid))
    setAudit(c, { action: 'ai_knowledge.delete', targetType: 'ai_knowledge_source', targetId: sid, detail: { agent_id: c.req.param('id') } })
    return c.body(null, 204)
  })

  return app
}

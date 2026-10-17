// Assistente de fluxo (SPEC T93; 07-agentes-ia.md §6 "Sessões/mensagens"): sessões por fluxo, turnos e retomada.
// Tudo com flows.view; as ferramentas de escrita só entram no turno se o usuário tiver flows.edit NAQUELE momento
// (AC-T93-05). A resposta sai por SSE (`copilot.delta`/`copilot.completed`, só para o dono da sessão).
import { Hono, type Context } from 'hono'
import type { LlmProvider } from '@crm/ai'
import {
  AiKeysService,
  createCompanyLlmProvider,
  FlowCopilotError,
  FlowCopilotService,
  RealtimePublisher,
  UsageGuard,
  type CopilotCtx,
  type CopilotPublisher,
} from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Serviço pronto (testes). Default: montado com as deps abaixo. */
    flowCopilot?: FlowCopilotService
    /** LLM do assistente. Default: o fake do E2E (lido a cada turno), senão o LLM da empresa (chaves BYOK). */
    flowCopilotLlm?: LlmProvider
    /** Medição/cobrança (T24). Default `new UsageGuard({ db, redis })`; `null` desliga. */
    flowCopilotGuard?: UsageGuard | null
    /** Publisher de `copilot.*` e `flow.graph_updated`. Default: realtime do Redis. */
    flowCopilotPublisher?: CopilotPublisher
    /** Modelo sem preset `balanced` (default: env `FLOW_COPILOT_MODEL=provider:model`, senão Sonnet). */
    flowCopilotModel?: { provider: string; model: string }
  }
}

/** Serviço do processo da API (um por app). */
export function flowCopilotService(deps: ResolvedDeps): FlowCopilotService {
  if (deps.flowCopilot) return deps.flowCopilot
  let company: LlmProvider | undefined
  const companyLlm = () =>
    (company ??= createCompanyLlmProvider({
      keys:
        (deps.aiKeys as AiKeysService | undefined) ??
        new AiKeysService({ db: deps.db, ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}) }),
    }))
  deps.flowCopilot = new FlowCopilotService({
    db: deps.db,
    // Lido a cada turno: o harness E2E troca `deps.e2e.llm` no `replace` do roteiro.
    llm: () => deps.flowCopilotLlm ?? (deps as { e2e?: { llm?: LlmProvider } }).e2e?.llm ?? companyLlm(),
    guard:
      deps.flowCopilotGuard === undefined ? new UsageGuard({ db: deps.db, redis: deps.redis }) : deps.flowCopilotGuard,
    publisher:
      deps.flowCopilotPublisher ??
      (deps.realtimePublisher as CopilotPublisher | undefined) ??
      (new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }) as unknown as CopilotPublisher),
    ...(deps.flowCopilotModel ? { model: deps.flowCopilotModel } : {}),
    logger: deps.logger,
  })
  return deps.flowCopilot
}

const STATUS: Record<
  FlowCopilotError['code'],
  'NOT_FOUND' | 'VALIDATION_ERROR' | 'INVALID_TRANSITION' | 'QUOTA_EXCEEDED'
> = {
  not_found: 'NOT_FOUND',
  validation: 'VALIDATION_ERROR',
  invalid_state: 'INVALID_TRANSITION',
  paused_quota: 'QUOTA_EXCEEDED',
  no_balance: 'QUOTA_EXCEEDED',
}

async function copilot<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FlowCopilotError)
      throw new ApiError(STATUS[err.code], err.message, { reason: err.code, ...err.details })
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

export function flowCopilotRoutes(deps: ResolvedDeps) {
  const service = flowCopilotService(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('flows.view')

  const ctxOf = (c: Context<AppEnv>): CopilotCtx => {
    const ctx = getCompanyCtx(c)
    // Token de API sem usuário não conversa com o assistente (as sessões são do usuário).
    if (!ctx.user) throw new ApiError('FORBIDDEN', 'O assistente exige um usuário')
    return { companyId: ctx.companyId, userId: ctx.user.id }
  }
  const canEdit = (c: Context<AppEnv>) => (getCompanyCtx(c).perms as ReadonlySet<string>).has('flows.edit')

  app.get('/api/flow-copilot/sessions', view, async (c) => {
    const flowId = c.req.query('flow_id')
    const includeArchived = ['1', 'true'].includes(c.req.query('include_archived') ?? '')
    const items = await copilot(() =>
      service.listSessions(ctxOf(c), { ...(flowId ? { flow_id: flowId } : {}), include_archived: includeArchived }),
    )
    return c.json({ items, can_edit: canEdit(c), tools: FlowCopilotService.toolNames(canEdit(c)) })
  })

  app.post('/api/flow-copilot/sessions', view, async (c) => {
    const session = await copilot(async () => service.createSession(ctxOf(c), await jsonBody(c)))
    setAudit(c, { action: 'flow_copilot.session_created', targetType: 'flow_copilot_session', targetId: session.id })
    return c.json({ session }, 201)
  })

  app.get('/api/flow-copilot/sessions/:id', view, async (c) => {
    return c.json({ session: await copilot(() => service.getSession(ctxOf(c), c.req.param('id'))) })
  })

  app.patch('/api/flow-copilot/sessions/:id', view, async (c) => {
    const session = await copilot(async () => service.updateSession(ctxOf(c), c.req.param('id'), await jsonBody(c)))
    setAudit(c, { action: 'flow_copilot.session_updated', targetType: 'flow_copilot_session', targetId: session.id })
    return c.json({ session })
  })

  for (const action of ['archive', 'reopen', 'resume'] as const) {
    app.post(`/api/flow-copilot/sessions/:id/${action}`, view, async (c) => {
      const session = await copilot(() => service[action](ctxOf(c), c.req.param('id')))
      setAudit(c, { action: `flow_copilot.${action}`, targetType: 'flow_copilot_session', targetId: session.id })
      return c.json({ session })
    })
  }

  app.get('/api/flow-copilot/sessions/:id/messages', view, async (c) => {
    return c.json({ items: await copilot(() => service.listMessages(ctxOf(c), c.req.param('id'))) })
  })

  app.post('/api/flow-copilot/sessions/:id/messages', view, async (c) => {
    const out = await copilot(async () =>
      service.runTurn(ctxOf(c), c.req.param('id'), await jsonBody(c), { canEdit: canEdit(c) }),
    )
    setAudit(c, {
      action: 'flow_copilot.message',
      targetType: 'flow_copilot_session',
      targetId: out.session.id,
      detail: { graph_changed: out.graph_changed },
    })
    return c.json(out, 201)
  })

  return app
}

// Acesso de suporte (T32; 01 §19, 16 §3.7/§6). Lado do usuário `support` (só sessão, papel de sistema `support`):
//   GET  /api/support/access-requests → { requests }
//   POST /api/support/access-requests/lookup { email } → { accounts }  (empresas em que o e-mail é owner/admin)
//   POST /api/support/access-requests { email, company_id? } → 201 { request }
//   POST /api/support/access-requests/:id/resend → { request };  DELETE /api/support/access-requests/:id → { request }
//   GET  /api/support/access-grants → { grants };  GET /api/support/access-grants/:companyId/flows → { flows }
// Lado da empresa ativa (owner/admin; member → 403):
//   GET  /api/support-access/requests?status=pending|approved|rejected|cancelled|all → { requests }
//   POST /api/support-access/requests/:id/approve → { request, grant };  POST …/:id/reject → { request }
//   GET  /api/support-access/grants → { grants };  DELETE /api/support-access/grants/:supportUserId → { grant }
// Corpos aceitam o envelope do produto de referência (`{ access_request: { email, account_id } }`).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { RealtimePublisher, setSupportAccessClock, SupportAccessError, SupportAccessService, type SupportAccessErrorKind } from '@crm/core'
import { SUPPORT_ACCESS_REQUEST_STATUSES } from '@crm/db'
import { emailSchema, idSchema, type ErrorCode } from '@crm/shared'
import { clientIp, getCompanyCtx, getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePlatformRole } from '../../middleware/authorize'

export interface SupportAccessOptions {
  /** Relógio (testes): vale para a concessão criada e para a checagem de expiração a cada requisição. */
  now?: () => Date
  /** Validade da concessão (default 12 h). */
  grantTtlMs?: number
}

declare module '../../lib/types' {
  interface AppDeps {
    supportAccess?: SupportAccessOptions
  }
}

const KIND_CODES: Record<SupportAccessErrorKind, ErrorCode> = {
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  conflict: 'CONFLICT',
  invalid_transition: 'INVALID_TRANSITION',
  validation: 'VALIDATION_ERROR',
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof SupportAccessError)) throw err
    const details = err.errorCode || err.details ? { ...err.details, ...(err.errorCode ? { error_code: err.errorCode } : {}) } : undefined
    throw new ApiError(KIND_CODES[err.kind], err.message, details)
  }
}

const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'access_request' in v && typeof (v as { access_request: unknown }).access_request === 'object'
    ? (v as { access_request: unknown }).access_request
    : v

const lookupSchema = z.preprocess(unwrap, z.object({ email: emailSchema }))
const createSchema = z.preprocess(
  unwrap,
  z.object({ email: emailSchema, company_id: idSchema.nullish(), account_id: idSchema.nullish() }),
)
const listQuery = z.object({ status: z.enum([...SUPPORT_ACCESS_REQUEST_STATUSES, 'all']).default('pending') })

/** Usuário `support` da sessão. */
function supportUser(c: Context<AppEnv>) {
  const ctx = getCtx(c)
  if (!ctx.user || ctx.auth.kind !== 'session') throw new ApiError('FORBIDDEN', 'Disponível apenas para sessões de usuário')
  return ctx.user
}

/** Owner/admin da empresa ativa (16 §5: aba e modal de suporte são `ownerAdminOnly`). */
function ownerAdmin(c: Context<AppEnv>) {
  const ctx = getCompanyCtx(c)
  const role = ctx.member?.role
  if (!ctx.user || ctx.auth.kind !== 'session' || (role !== 'owner' && role !== 'admin'))
    throw new ApiError('FORBIDDEN', 'Apenas owner ou admin da empresa', { error_code: 'owner_admin_only' })
  return { companyId: ctx.companyId, userId: ctx.user.id }
}

export function supportAccessRoutes(deps: ResolvedDeps) {
  const opts = deps.supportAccess ?? {}
  setSupportAccessClock(deps.db, opts.now)
  const svc = new SupportAccessService({
    db: deps.db,
    publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
    logger: deps.logger,
    grantTtlMs: opts.grantTtlMs,
    now: opts.now,
  })
  const app = new Hono<AppEnv>()

  /** Ação do suporte gravada na auditoria da empresa alvo (o suporte não tem empresa ativa). */
  async function auditSupport(c: Context<AppEnv>, action: string, request: { id: string; company_id: string }) {
    setAudit(c, { skip: true })
    await deps.audit
      .record({
        companyId: request.company_id,
        actorUserId: supportUser(c).id,
        action,
        targetType: 'support_access_request',
        targetId: request.id,
        detail: { request_id: c.get('requestId') },
        ip: clientIp(c, deps.trustProxy),
      })
      .catch((err: unknown) => c.get('logger')?.error({ err, action }, 'failed to write audit log'))
  }

  // ---------- lado do suporte ----------
  const support = requirePlatformRole('support')

  app.get('/api/support/access-requests', support, async (c) => c.json({ requests: await svc.listMyRequests(supportUser(c).id) }))

  app.post('/api/support/access-requests/lookup', support, validate('json', lookupSchema), async (c) => {
    supportUser(c)
    setAudit(c, { skip: true }) // consulta, não muda estado
    return c.json({ accounts: await svc.lookup(c.req.valid('json').email) })
  })

  app.post('/api/support/access-requests', support, validate('json', createSchema), async (c) => {
    const b = c.req.valid('json')
    const request = await run(() => svc.createRequest(supportUser(c).id, { email: b.email, companyId: b.company_id ?? b.account_id ?? null }))
    await auditSupport(c, 'support_access.request', request)
    return c.json({ request }, 201)
  })

  app.post('/api/support/access-requests/:id/resend', support, async (c) => {
    const request = await run(() => svc.resendRequest(supportUser(c).id, c.req.param('id')))
    await auditSupport(c, 'support_access.resend', request)
    return c.json({ request })
  })

  app.delete('/api/support/access-requests/:id', support, async (c) => {
    const request = await run(() => svc.cancelRequest(supportUser(c).id, c.req.param('id')))
    await auditSupport(c, 'support_access.cancel', request)
    return c.json({ request })
  })

  app.get('/api/support/access-grants', support, async (c) => c.json({ grants: await svc.listMyGrants(supportUser(c).id) }))

  app.get('/api/support/access-grants/:companyId/flows', support, async (c) =>
    c.json({ flows: await run(() => svc.listGrantFlows(supportUser(c).id, c.req.param('companyId'))) }),
  )

  // ---------- lado da empresa (owner/admin) ----------

  app.get('/api/support-access/requests', validate('query', listQuery), async (c) => {
    const { companyId } = ownerAdmin(c)
    return c.json({ requests: await svc.listCompanyRequests(companyId, c.req.valid('query').status) })
  })

  app.post('/api/support-access/requests/:id/approve', async (c) => {
    const { companyId, userId } = ownerAdmin(c)
    const out = await run(() => svc.approve(companyId, c.req.param('id'), userId))
    setAudit(c, {
      action: 'support_access.approve',
      targetType: 'support_access_request',
      targetId: out.request.id,
      detail: { support_user_id: out.request.support_user_id, support_grant_id: out.grant.id, expires_at: out.grant.expires_at },
    })
    return c.json(out)
  })

  app.post('/api/support-access/requests/:id/reject', async (c) => {
    const { companyId, userId } = ownerAdmin(c)
    const request = await run(() => svc.reject(companyId, c.req.param('id'), userId))
    setAudit(c, { action: 'support_access.reject', targetType: 'support_access_request', targetId: request.id, detail: { support_user_id: request.support_user_id } })
    return c.json({ request })
  })

  app.get('/api/support-access/grants', async (c) => {
    const { companyId } = ownerAdmin(c)
    return c.json({ grants: await svc.listCompanyGrants(companyId) })
  })

  app.delete('/api/support-access/grants/:supportUserId', async (c) => {
    const { companyId, userId } = ownerAdmin(c)
    const grant = await run(() => svc.revoke(companyId, c.req.param('supportUserId'), userId))
    setAudit(c, { action: 'support_access.revoke', targetType: 'support_access_grant', targetId: grant.id, detail: { support_user_id: grant.support_user_id } })
    return c.json({ grant })
  })

  return app
}

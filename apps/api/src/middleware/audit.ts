// Auditoria das mutações bem-sucedidas (SPEC 3.6): grava `crm.audit_logs` ANTES de responder, sem segredos.
// Ação padrão `<MÉTODO> <rota>` (ex.: `POST /api/contacts/:id`); a rota refina com `setAudit`/`auditAction`.
import type { Context, MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import type { AuditService } from '@crm/core'
import { clientIp } from '../lib/context'
import type { AppEnv, AuditInfo } from '../lib/types'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Refina o que será auditado nesta requisição (campos se somam; `detail` é mesclado). */
export function setAudit(c: Context<AppEnv>, info: AuditInfo): void {
  const prev = c.get('audit')
  c.set('audit', { ...prev, ...info, detail: { ...prev?.detail, ...info.detail } })
}

/** Middleware de rota: `app.post('/api/x', auditAction('x.create', { targetType: 'x' }), handler)`. */
export function auditAction(action: string, info: Omit<AuditInfo, 'action'> = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    setAudit(c, { ...info, action })
    await next()
  }
}

/** Alvo derivado da URL: `/api/contacts/abc/tags` → `contacts` / `abc`. */
export function deriveTarget(path: string): { targetType: string; targetId: string | null } {
  const segs = path.split('/').filter(Boolean)
  const rest = segs[0] === 'api' ? segs.slice(1) : segs
  return { targetType: rest[0] ?? 'api', targetId: rest[1] ?? null }
}

export interface AuditMiddlewareOptions {
  audit: AuditService
  trustProxy?: boolean
}

export function auditMiddleware(opts: AuditMiddlewareOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    if (!MUTATING.has(c.req.method) || c.res.status < 200 || c.res.status >= 300) return
    const ctx = c.get('ctx')
    const info = c.get('audit') ?? {}
    if (!ctx || info.skip) return

    let route = c.req.path
    try {
      route = routePath(c) || route
    } catch {
      // sem rota casada: usa o caminho
    }
    const derived = deriveTarget(c.req.path)
    const entry = {
      companyId: ctx.companyId,
      actorUserId: ctx.user?.id ?? null,
      action: info.action ?? `${c.req.method} ${route}`,
      targetType: info.targetType ?? derived.targetType,
      targetId: info.targetId ?? derived.targetId,
      detail: { request_id: c.get('requestId'), status: c.res.status, ...(ctx.auth.tokenId ? { api_token_id: ctx.auth.tokenId } : {}), ...(ctx.auth.mcpCredentialId ? { mcp_credential_id: ctx.auth.mcpCredentialId } : {}), ...info.detail },
      ip: clientIp(c, opts.trustProxy),
    }
    try {
      await opts.audit.record(entry)
    } catch (err) {
      c.get('logger')?.error({ err, action: entry.action }, 'failed to write audit log')
    }
  }
}

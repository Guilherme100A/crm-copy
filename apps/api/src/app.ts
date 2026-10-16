// App Hono da API (SPEC T08). `createApp(deps)` não abre porta: teste com `app.request(...)`.
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { AuditService, SessionService } from '@crm/core'
import { createLogger } from '@crm/node-kit'
import { notFound, onError } from './lib/errors'
import type { AppDeps, AppEnv, ResolvedDeps } from './lib/types'
import { auditMiddleware } from './middleware/audit'
import { companyContext } from './middleware/company'
import { csrfGuard } from './middleware/csrf'
import type { PublicRoute } from './middleware/public-routes'
import { requestLogger } from './middleware/request-logger'
import { sessionAuth } from './middleware/auth'
import { registerRoutes } from './routes/index'

export interface CreateAppOptions {
  /** Rotas públicas extras, além das da SPEC 3.6. */
  publicRoutes?: readonly PublicRoute[]
}

export function resolveDeps(deps: AppDeps): ResolvedDeps {
  return {
    ...deps,
    logger: deps.logger ?? createLogger(),
    sessions: deps.sessions ?? new SessionService({ db: deps.db, ttlDays: deps.sessionTtlDays }),
    audit: deps.audit ?? new AuditService(deps.db),
  }
}

export function createApp(appDeps: AppDeps, opts: CreateAppOptions = {}) {
  const deps = resolveDeps(appDeps)
  const cookieSecure = deps.cookieSecure ?? process.env.NODE_ENV === 'production'
  const app = new Hono<AppEnv>()

  // Middlewares no app raiz: valem também para rotas registradas depois de createApp.
  app.use('*', requestId({ headerName: 'x-request-id' }))
  app.use('*', requestLogger(deps.logger))
  app.use('/api/*', sessionAuth({ sessions: deps.sessions, cookieSecure, publicRoutes: opts.publicRoutes }))
  app.use('/api/*', csrfGuard())
  app.use('/api/*', companyContext(deps.db))
  app.use('/api/*', auditMiddleware({ audit: deps.audit, trustProxy: deps.trustProxy }))

  app.onError(onError)
  app.notFound(notFound)

  registerRoutes(app, deps)
  return app
}

export type App = ReturnType<typeof createApp>

// Superfície pública da API (também reexportada por src/index.ts).
export { ApiError, errorBody, fieldErrors, notFound, onError, toWireError, validationError } from './lib/errors'
export type { WireError } from './lib/errors'
export { validate } from './lib/validate'
export { clientIp, getCompanyCtx, getCtx } from './lib/context'
export type { CompanyRequestContext } from './lib/context'
export { clearSessionCookie, setSessionCookie } from './lib/cookies'
export { RateLimiter } from './lib/rate-limiter'
export type { RateLimiterOptions, RateLimitResult } from './lib/rate-limiter'
export type { AppDeps, AppEnv, AuditInfo, RedisClient, ResolvedDeps } from './lib/types'
export { auditAction, auditMiddleware, deriveTarget, setAudit } from './middleware/audit'
export { requirePerm, requirePlatformRole } from './middleware/authorize'
export { COMPANY_HEADER, companyContext } from './middleware/company'
export { CSRF_HEADER, CSRF_HEADER_VALUE, csrfGuard } from './middleware/csrf'
export { PUBLIC_API_ROUTES, isPublicApiRoute } from './middleware/public-routes'
export type { PublicRoute } from './middleware/public-routes'
export { rateLimit } from './middleware/rate-limit'
export type { RateLimitOptions } from './middleware/rate-limit'
export { requestLogger } from './middleware/request-logger'
export { parseBearer, sessionAuth } from './middleware/auth'
export { healthRoutes, probe } from './routes/health/index'

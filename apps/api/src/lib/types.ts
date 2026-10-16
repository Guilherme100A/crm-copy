// Tipos compartilhados da API: dependências injetáveis e variáveis de contexto do Hono (padrão ai-manager).
// Tarefas posteriores acrescentam dependências por *declaration merging* em `AppDeps`.
import type { AuditService, RequestContext, SessionService } from '@crm/core'
import type { Database } from '@crm/db'
import type { Logger, redisConnection } from '@crm/node-kit'

/** Cliente ioredis (`redisConnection()` do @crm/node-kit). */
export type RedisClient = ReturnType<typeof redisConnection>

export interface AppDeps {
  /** `createDb(url)` do @crm/db. */
  db: Database
  redis: RedisClient
  /** Logger pino com redação (default: `createLogger()` do @crm/node-kit). */
  logger?: Logger
  /** Default: `new SessionService({ db, ttlDays: sessionTtlDays })`. */
  sessions?: SessionService
  /** Default: `new AuditService(db)`. */
  audit?: AuditService
  /** `AUTH_SESSION_TTL_DAYS` (default 30). */
  sessionTtlDays?: number
  /** Cookie `Secure` (default: `NODE_ENV === 'production'`). */
  cookieSecure?: boolean
  /** Usa `X-Forwarded-For` para o IP do cliente (atrás de proxy confiável). Default false. */
  trustProxy?: boolean
  /** Timeout de cada check do `/health` em ms (default 1000). */
  healthTimeoutMs?: number
}

/** Metadados de auditoria que uma rota pode definir com `setAudit(c, …)` ou `auditAction(…)`. */
export interface AuditInfo {
  action?: string
  targetType?: string
  targetId?: string
  detail?: Record<string, unknown>
  /** `true` para não auditar esta requisição (ex.: rotas que gravam a própria auditoria). */
  skip?: boolean
}

export interface AppEnv {
  Variables: {
    requestId: string
    logger: Logger
    /** Contexto autenticado; ausente em rotas públicas. */
    ctx: RequestContext | undefined
    audit: AuditInfo | undefined
  }
}

/** Dependências resolvidas por `createApp` (defaults aplicados). */
export interface ResolvedDeps extends AppDeps {
  logger: Logger
  sessions: SessionService
  audit: AuditService
}

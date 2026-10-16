// Apoio comum das rotas de empresas, equipe e convites (T22): dependências injetáveis, serviços e erros.
import type { Context } from 'hono'
import {
  CompanyService,
  InvitationService,
  RealtimePublisher,
  TeamError,
  TeamService,
  type Actor,
  type CompanySessionsSource,
  type TeamErrorKind,
} from '@crm/core'
import { createMailer } from '@crm/node-kit'
import type { ErrorCode } from '@crm/shared'
import type { WaGateway } from '@crm/wa-port'
import { getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'

export interface InvitationOptions {
  /** Validade do convite (default 7 dias). */
  ttlDays?: number
  /** Reenvios por dia, no fuso da empresa (default 3). */
  maxResendsPerDay?: number
  /** Intervalo mínimo entre envios do mesmo convite (default 60 000 ms). */
  resendCooldownMs?: number
  /** Relógio (testes). */
  now?: () => Date
}

declare module '../../lib/types' {
  interface AppDeps {
    /** Gateway WhatsApp (SPEC 3.2): `wa-gateway-rpc` em produção, `FakeWaGateway` em teste. */
    waGateway?: WaGateway
    /** Sessões WhatsApp da empresa, além das fontes registradas com `registerCompanySessionsSource`. */
    companySessions?: CompanySessionsSource
    invitations?: InvitationOptions
    /** Default: `new RealtimePublisher({ redis, prefix: realtime?.prefix })`. */
    realtimePublisher?: RealtimePublisher
  }
}

export interface TeamServices {
  companies: CompanyService
  team: TeamService
  invitations: InvitationService
}

const cache = new WeakMap<ResolvedDeps, TeamServices>()

/** Serviços de T22 para estas dependências (um conjunto por app). */
export function teamServices(deps: ResolvedDeps): TeamServices {
  let s = cache.get(deps)
  if (!s) {
    const publisher = deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix })
    s = {
      companies: new CompanyService({
        db: deps.db,
        waGateway: deps.waGateway,
        sessionsSources: deps.companySessions ? [deps.companySessions] : [],
        publisher,
        logger: deps.logger,
      }),
      team: new TeamService({ db: deps.db, publisher, logger: deps.logger }),
      invitations: new InvitationService({
        db: deps.db,
        mailer: deps.mailer ?? createMailer(),
        sessions: deps.sessions,
        audit: deps.audit,
        appName: deps.appName ?? (process.env.APP_NAME || 'CRM'),
        webPublicUrl: deps.webPublicUrl ?? (process.env.WEB_PUBLIC_URL || 'http://localhost:5173'),
        ttlDays: deps.invitations?.ttlDays,
        maxResendsPerDay: deps.invitations?.maxResendsPerDay,
        resendCooldownMs: deps.invitations?.resendCooldownMs,
        now: deps.invitations?.now,
        logger: deps.logger,
      }),
    }
    cache.set(deps, s)
  }
  return s
}

const KIND_CODES: Record<TeamErrorKind, ErrorCode> = {
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  conflict: 'CONFLICT',
  validation: 'VALIDATION_ERROR',
  gone: 'GONE',
  rate_limit: 'RATE_LIMIT',
  unauthorized: 'UNAUTHORIZED',
}

/** `TeamError` → `ApiError` (SPEC 3.5), com `error_code` e detalhes em `error.details`. */
export function toApi(err: unknown): unknown {
  if (!(err instanceof TeamError)) return err
  const details = err.errorCode || err.details ? { ...err.details, ...(err.errorCode ? { error_code: err.errorCode } : {}) } : undefined
  return new ApiError(KIND_CODES[err.kind], err.message, details)
}

export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApi(err)
  }
}

/** Usuário da sessão como ator (tokens de API não gerenciam empresas/equipe). */
export function actorOf(c: Context<AppEnv>): Actor & { name: string } {
  const ctx = getCtx(c)
  if (!ctx.user || ctx.auth.kind !== 'session') throw new ApiError('FORBIDDEN', 'Disponível apenas para sessões de usuário')
  return { userId: ctx.user.id, systemRole: ctx.user.systemRole, name: ctx.user.name }
}

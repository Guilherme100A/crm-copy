// `GET /api/events?company_id=` (SPEC 3.7, T16): canal SSE único da empresa ativa. Autenticado pelo cookie de
// sessão (ou token de API); `company_id` validado contra a membership (outra empresa → 404).
// Replay por `Last-Event-ID` (ou `?last_event_id=`), heartbeat `ping` e fechamento no logout.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  DEFAULT_HEARTBEAT_MS,
  RealtimeConnection,
  RealtimeHub,
  checkConnectionAccess,
  findMembership,
  permissionsOf,
  type CompanyMember,
} from '@crm/core'
import { getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, RedisClient, ResolvedDeps } from '../../lib/types'

export interface RealtimeDeps {
  /** Intervalo do `event: ping` e da reconferência da sessão (default 20 000 ms). */
  heartbeatMs?: number
  /** Prefixo das chaves Redis (default `crm:rt`). */
  prefix?: string
  /** Hub próprio (testes); sem ele, um hub por cliente Redis é criado na primeira conexão. */
  hub?: RealtimeHub
}

declare module '../../lib/types' {
  interface AppDeps {
    realtime?: RealtimeDeps
  }
}

const hubs = new WeakMap<RedisClient, RealtimeHub>()

function hubFor(deps: ResolvedDeps): RealtimeHub {
  if (deps.realtime?.hub) return deps.realtime.hub
  let hub = hubs.get(deps.redis)
  if (!hub) {
    hub = new RealtimeHub({ redis: deps.redis, prefix: deps.realtime?.prefix, logger: deps.logger })
    hubs.set(deps.redis, hub)
  }
  return hub
}

/** Fecha o subscriber criado para este cliente Redis (desligamento do processo e testes). */
export async function stopRealtimeHub(redis: RedisClient): Promise<void> {
  const hub = hubs.get(redis)
  hubs.delete(redis)
  await hub?.close()
}

const notFound = () => new ApiError('NOT_FOUND', 'Empresa não encontrada')

export function eventsRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()

  app.get('/api/events', async (c) => {
    const ctx = getCtx(c)
    const requested = c.req.query('company_id')?.trim() || null

    let companyId: string | null
    let member: CompanyMember | null
    let perms: ReadonlySet<string>
    if (ctx.auth.kind === 'api_token') {
      if (requested && requested.toLowerCase() !== ctx.companyId?.toLowerCase()) throw notFound()
      companyId = ctx.companyId
      member = null
      perms = ctx.perms
    } else if (requested) {
      if (!ctx.user) throw new ApiError('UNAUTHORIZED', 'Não autenticado')
      member = await findMembership(deps.db, ctx.user.id, requested)
      if (!member) throw notFound()
      companyId = member.companyId
      perms = permissionsOf(member, ctx.user)
    } else {
      companyId = ctx.companyId
      member = ctx.member
      perms = ctx.perms
    }
    if (!companyId) throw new ApiError('FORBIDDEN', 'Nenhuma empresa ativa')

    const hub = hubFor(deps)
    await hub.start()
    const logger = c.get('logger')
    const user = ctx.user
    const activeCompany = companyId
    const lastEventId = c.req.header('last-event-id') ?? c.req.query('last_event_id') ?? null

    // Sem buffer em proxy reverso (nginx) para o SSE.
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(
      c,
      async (stream) => {
        const conn = new RealtimeConnection({
          hub,
          companyId: activeCompany,
          userId: user?.id ?? null,
          auth: ctx.auth,
          member,
          perms,
          lastEventId,
          heartbeatMs: deps.realtime?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
          checkAccess: () => checkConnectionAccess(deps.db, { auth: ctx.auth, user, companyId: activeCompany, perms }),
          send: (m) => stream.writeSSE(m),
          onError: (err) => logger.warn({ err }, 'realtime stream error'),
        })
        stream.onAbort(() => conn.close())
        await conn.run()
      },
      async (err) => {
        logger.error({ err }, 'realtime stream failed')
      },
    )
  })

  return app
}

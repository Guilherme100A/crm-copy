// Rotas do harness E2E (T17; SPEC 3.10): `/__e2e/*` só existem com `E2E=1` no momento do `createApp`
// (sem a flag, nem são montadas → 404). Fora de `/api/*`: sem sessão, sem CSRF, sem auditoria.
import { Hono } from 'hono'
import { z } from 'zod'
import { FakeLlm, type FakeLlmStep } from '@crm/ai/testing'
import { resetAndSeed, SEED_BASE, type RunSeedsOptions } from '@crm/db'
import { MemoryMailer } from '@crm/node-kit'
import { safeParseWaEvent, type WaEvent } from '@crm/wa-port'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ApiError } from '../lib/errors'
import type { AppEnv, RedisClient, ResolvedDeps } from '../lib/types'

/** Evento entregue a um handler do worker (gravado pelo worker in-process do `serve.mjs`). */
export interface HandledEvent {
  stream_id: string
  type: string
  event_key: string
  at: string
}

export interface E2eDeps {
  /** Roteiro do `/__e2e/llm/script`. Default: `new FakeLlm()`. */
  llm?: FakeLlm
  /** Entregas observadas no worker (o `scripts/e2e/api.ts` liga a um handler espião). */
  deliveries?: HandledEvent[]
  /** Opções do seed no reset (ex.: só o base). */
  seed?: RunSeedsOptions
}

declare module '../lib/types' {
  interface AppDeps {
    e2e?: E2eDeps
  }
}

export const E2E_PREFIX = '/__e2e'
export const DEFAULT_WA_EVENTS_STREAM = 'wsm:events'
export const WA_CONSUMER_GROUP = 'crm'
export const WA_EVENT_FIELD = 'event'

/** Só `E2E=1` liga o harness; produção nunca decide por `NODE_ENV`. */
export function isE2eEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.E2E === '1'
}

/** Garante os fakes nas deps (antes das outras rotas lerem `mailer`/`waGateway`). */
export function prepareE2eDeps(deps: ResolvedDeps): asserts deps is ResolvedDeps & { mailer: MemoryMailer; e2e: E2eDeps & { llm: FakeLlm } } {
  deps.mailer ??= new MemoryMailer()
  if (!(deps.mailer instanceof MemoryMailer)) throw new Error('E2E=1 exige MemoryMailer (MAIL_TRANSPORT=memory)')
  deps.waGateway ??= new FakeWaGateway()
  deps.e2e ??= {}
  deps.e2e.llm ??= new FakeLlm()
}

/** Chaves Redis de teste apagadas no reset (filas BullMQ `crm:*` preservam o `:meta`). */
async function clearRedis(redis: RedisClient, stream: string): Promise<number> {
  let removed = 0
  try {
    await redis.xtrim(stream, 'MAXLEN', 0)
  } catch {
    // stream inexistente
  }
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'crm:*', 'COUNT', 500)
    cursor = next
    const doomed = keys.filter((k) => !k.endsWith(':meta'))
    if (doomed.length) removed += await redis.del(...doomed)
  } while (cursor !== '0')
  return removed
}

const stepSchema: z.ZodType<FakeLlmStep> = z.union([
  z.object({ kind: z.literal('text'), text: z.string(), usage: z.record(z.string(), z.number()).optional() }),
  z.object({ kind: z.literal('output'), value: z.unknown(), usage: z.record(z.string(), z.number()).optional() }),
  z.object({ kind: z.literal('length'), text: z.string().default(''), usage: z.record(z.string(), z.number()).optional() }),
  z.object({ kind: z.literal('refusal'), text: z.string().default(''), usage: z.record(z.string(), z.number()).optional() }),
  z.object({
    kind: z.literal('tool-calls'),
    calls: z.array(z.object({ name: z.string(), input: z.unknown(), id: z.string().optional() })).min(1),
    usage: z.record(z.string(), z.number()).optional(),
  }),
  z.object({ kind: z.literal('fail'), error: z.string() }).transform((s) => ({ kind: 'fail' as const, error: new Error(s.error) })),
]) as unknown as z.ZodType<FakeLlmStep>

const scriptSchema = z.object({ steps: z.array(stepSchema), replace: z.boolean().optional() })

function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint]
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint]
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1
}

export function e2eRoutes(rawDeps: ResolvedDeps) {
  prepareE2eDeps(rawDeps)
  const deps = rawDeps
  const stream = process.env.WA_EVENTS_STREAM || DEFAULT_WA_EVENTS_STREAM
  const app = new Hono<AppEnv>()
  const json = async (c: { req: { json(): Promise<unknown> } }) => {
    try {
      return await c.req.json()
    } catch {
      throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
    }
  }

  app.get(`${E2E_PREFIX}`, (c) => c.json({ seed: SEED_BASE, stream, group: WA_CONSUMER_GROUP }))

  // Restaura o seed-base e limpa streams/filas de teste (AC-T17-03).
  app.post(`${E2E_PREFIX}/reset`, async (c) => {
    const t0 = Date.now()
    const { applied } = await resetAndSeed(deps.db, deps.e2e.seed)
    const redisKeys = await clearRedis(deps.redis, stream)
    deps.mailer.clear()
    if (deps.waGateway instanceof FakeWaGateway) deps.waGateway.reset()
    deps.e2e.llm = new FakeLlm()
    if (deps.e2e.deliveries) deps.e2e.deliveries.length = 0
    return c.json({ ok: true, applied, redis_keys: redisKeys, ms: Date.now() - t0 }, 200)
  })

  // Injeta um WaEvent no FakeWaGateway e no stream que o worker consome (AC-T17-04).
  app.post(`${E2E_PREFIX}/wa/emit`, async (c) => {
    const body = (await json(c)) as { event?: unknown } | null
    const raw = body && typeof body === 'object' && 'event' in body ? body.event : body
    const parsed = safeParseWaEvent(raw)
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'WaEvent inválido', { fields: [{ path: 'event', message: parsed.error.message }] })
    const event: WaEvent = parsed.data
    if (deps.waGateway instanceof FakeWaGateway) await deps.waGateway.emit(event)
    const id = await deps.redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event))
    return c.json({ stream_id: id, stream }, 202)
  })

  // Estado de entrega no consumer group `crm` (e, com o worker in-process, os handlers que receberam).
  app.get(`${E2E_PREFIX}/wa/deliveries`, async (c) => {
    const id = c.req.query('stream_id')
    if (!id || !/^\d+-\d+$/.test(id)) throw new ApiError('VALIDATION_ERROR', 'stream_id obrigatório', { fields: [{ path: 'stream_id', message: 'formato <ms>-<seq>' }] })
    const waitMs = Math.min(10_000, Math.max(0, Number(c.req.query('wait_ms') ?? 0) || 0))
    const until = Date.now() + waitMs
    const state = async () => {
      let lastDelivered: string | null = null
      try {
        const groups = (await deps.redis.xinfo('GROUPS', stream)) as unknown[][]
        for (const g of groups) {
          const f: Record<string, unknown> = {}
          for (let i = 0; i + 1 < g.length; i += 2) f[String(g[i])] = g[i + 1]
          if (f.name === WA_CONSUMER_GROUP) lastDelivered = String(f['last-delivered-id'])
        }
      } catch {
        // stream ou grupo inexistente
      }
      const delivered = lastDelivered !== null && compareIds(lastDelivered, id) >= 0
      let pending = false
      if (delivered) {
        const rows = (await deps.redis.xpending(stream, WA_CONSUMER_GROUP, id, id, 1)) as unknown[]
        pending = rows.length > 0
      }
      const handled = (deps.e2e.deliveries ?? []).filter((d) => d.stream_id === id)
      return { stream, group: WA_CONSUMER_GROUP, stream_id: id, delivered, pending, acked: delivered && !pending, handled }
    }
    let s = await state()
    while (!s.acked && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50))
      s = await state()
    }
    return c.json(s, 200)
  })

  app.get(`${E2E_PREFIX}/mail`, (c) =>
    c.json({
      items: deps.mailer.messages.map((m) => ({
        to: m.to,
        subject: m.subject,
        html: m.html ?? null,
        text: m.text ?? null,
        from: m.from,
        message_id: m.messageId,
        sent_at: m.sentAt.toISOString(),
      })),
    }),
  )
  app.delete(`${E2E_PREFIX}/mail`, (c) => {
    deps.mailer.clear()
    return c.json({ ok: true })
  })

  app.get(`${E2E_PREFIX}/llm/script`, (c) => c.json({ remaining: deps.e2e.llm.remaining, calls: deps.e2e.llm.callCount }))
  app.post(`${E2E_PREFIX}/llm/script`, async (c) => {
    const parsed = scriptSchema.safeParse(await json(c))
    if (!parsed.success)
      throw new ApiError('VALIDATION_ERROR', 'Roteiro inválido', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      })
    if (parsed.data.replace) deps.e2e.llm = new FakeLlm()
    deps.e2e.llm.enqueue(...parsed.data.steps)
    return c.json({ remaining: deps.e2e.llm.remaining })
  })

  return app
}

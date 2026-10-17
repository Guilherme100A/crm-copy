// Rotas do harness E2E (T17; SPEC 3.10): `/__e2e/*` só existem com `E2E=1` no momento do `createApp`
// (sem a flag, nem são montadas → 404). Fora de `/api/*`: sem sessão, sem CSRF, sem auditoria.
import { Hono } from 'hono'
import { z } from 'zod'
import { FakeLlm, type FakeLlmStep } from '@crm/ai/testing'
import { resetAndSeed, SEED_BASE, type RunSeedsOptions } from '@crm/db'
import { MemoryMailer } from '@crm/node-kit'
import { DISCONNECT_KINDS, safeParseWaEvent, WA_EVENT_VERSION, type WaEvent } from '@crm/wa-port'
import { FAKE_PAIRING_CODE, FakeWaGateway } from '@crm/wa-port/testing'
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
  // T85: nota de voz sem ffmpeg no harness (só com E2E=1; produção continua com toPttOgg).
  deps.pttConverter ??= e2ePttConverter
}

/** Conversor PTT do harness: devolve os bytes como estão, rotulados como Ogg/Opus. */
export const e2ePttConverter = async (audio: Uint8Array) => ({ audio, mime: 'audio/ogg; codecs=opus', seconds: 0 })

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

/**
 * Corpo do `POST /__e2e/wa/sessions/:sessionId/state` (T71):
 * - `qr`: gera o QR (`startQr`); com `qr`, o evento leva esse valor (o `GET /:id/qr` segue com o do fake);
 * - `connecting`: sessão de volta a `NEW` aguardando pareamento + `session.pairing_code` (`code` ou o do fake);
 * - `open`: sessão em `session_state` (padrão `STABLE`) + `session.connection open`;
 * - `close`: sessão `DISCONNECTED` + `session.connection close` com `reason`/`status_code`.
 */
export const sessionStateSchema = z.object({
  to: z.enum(['qr', 'connecting', 'open', 'close']),
  qr: z.string().min(1).optional(),
  code: z.string().min(1).max(32).optional(),
  session_state: z.enum(['WARMING', 'STABLE', 'DEGRADED']).optional(),
  reason: z.enum(DISCONNECT_KINDS).optional(),
  status_code: z.number().int().optional(),
})
export type SessionStateInput = z.infer<typeof sessionStateSchema>

/** Aplica a transição no fake e devolve, em ordem, os eventos que ela gerou (os que irão para o stream). */
export async function driveFakeSession(fake: FakeWaGateway, sessionId: string, input: SessionStateInput): Promise<WaEvent[]> {
  const captured: WaEvent[] = []
  const off = fake.subscribe((e) => {
    if (e.session_id === sessionId) captured.push(e)
  })
  const at = () => new Date().toISOString()
  const connection = (state: 'open' | 'close') => captured.find((e) => e.type === 'session.connection' && e.state === state)
  try {
    switch (input.to) {
      case 'qr':
        await fake.sessions.startQr(sessionId)
        if (input.qr) await fake.emit({ v: WA_EVENT_VERSION, type: 'session.qr', session_id: sessionId, at: at(), qr: input.qr })
        break
      case 'connecting':
        await fake.setSessionState(sessionId, 'NEW')
        await fake.emit({ v: WA_EVENT_VERSION, type: 'session.pairing_code', session_id: sessionId, at: at(), code: input.code ?? FAKE_PAIRING_CODE })
        break
      case 'open':
        await fake.setSessionState(sessionId, input.session_state ?? 'STABLE')
        if (!connection('open')) await fake.emit({ v: WA_EVENT_VERSION, type: 'session.connection', session_id: sessionId, at: at(), state: 'open' })
        break
      case 'close':
        await fake.setSessionState(sessionId, 'DISCONNECTED')
        if (!connection('close')) await fake.emit({ v: WA_EVENT_VERSION, type: 'session.connection', session_id: sessionId, at: at(), state: 'close' })
        break
    }
  } finally {
    off()
  }
  // O fake fecha sem motivo: o motivo pedido vai no evento publicado.
  return captured.map((e) =>
    e.type === 'session.connection' && e.state === 'close'
      ? { ...e, ...(input.reason ? { reason: input.reason } : {}), ...(input.status_code !== undefined ? { status_code: input.status_code } : {}) }
      : e,
  )
}

/** Timeout do `POST /__e2e/reset` (T124): `E2E_RESET_TIMEOUT_MS`, padrão 60000 (lido a cada reset). */
export const DEFAULT_E2E_RESET_TIMEOUT_MS = 60_000
export function resetTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.E2E_RESET_TIMEOUT_MS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_E2E_RESET_TIMEOUT_MS
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

  // Restaura o seed-base e limpa streams/filas de teste (AC-T17-03). T124: um reset por vez (o seguinte espera o
  // anterior terminar, nunca começa por cima: chave duplicada no seed); estourado o timeout, responde 504 mas o
  // reset continua e segura a fila até acabar.
  const doReset = async () => {
    const t0 = Date.now()
    const { applied } = await resetAndSeed(deps.db, deps.e2e.seed)
    const redisKeys = await clearRedis(deps.redis, stream)
    deps.mailer.clear()
    if (deps.waGateway instanceof FakeWaGateway) deps.waGateway.reset()
    deps.e2e.llm = new FakeLlm()
    if (deps.e2e.deliveries) deps.e2e.deliveries.length = 0
    return { applied, redisKeys, ms: Date.now() - t0 }
  }
  let queue: Promise<unknown> = Promise.resolve()
  app.post(`${E2E_PREFIX}/reset`, async (c) => {
    const timeoutMs = resetTimeoutMs()
    const queuedAt = Date.now()
    let startedAt = queuedAt
    const run = queue.then(() => {
      startedAt = Date.now()
      return doReset()
    })
    queue = run.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const result = await Promise.race([run, timeout])
      if (result === 'timeout') return c.json({ ok: false, error: 'reset_timeout', timeout_ms: timeoutMs, waited_ms: startedAt - queuedAt }, 504)
      return c.json({ ok: true, applied: result.applied, redis_keys: result.redisKeys, ms: result.ms, waited_ms: startedAt - queuedAt }, 200)
    } finally {
      clearTimeout(timer)
    }
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

  // T71: leva a sessão do FakeWaGateway a um estado de pareamento/conexão E publica no stream os eventos que o fake
  // gerou (`session.qr|pairing_code|state|connection`), para a projeção da T47 e o SSE refletirem de verdade.
  app.post(`${E2E_PREFIX}/wa/sessions/:sessionId/state`, async (c) => {
    const parsed = sessionStateSchema.safeParse(await json(c))
    if (!parsed.success)
      throw new ApiError('VALIDATION_ERROR', 'Estado inválido', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      })
    const fake = deps.waGateway
    if (!(fake instanceof FakeWaGateway)) throw new ApiError('CONFLICT', 'Só com o FakeWaGateway')
    const sessionId = c.req.param('sessionId')
    try {
      await fake.sessions.get(sessionId)
    } catch {
      throw new ApiError('NOT_FOUND', 'Sessão não encontrada no FakeWaGateway')
    }
    const events = await driveFakeSession(fake, sessionId, parsed.data)
    const out: Array<{ type: string; stream_id: string | null }> = []
    for (const event of events) out.push({ type: event.type, stream_id: await deps.redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event)) })
    return c.json({ session: await fake.sessions.get(sessionId), events: out, stream }, 202)
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

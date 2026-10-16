// Servidor interno do wa-worker (ai-manager apps/worker/src/boot/internal-server.ts):
//  - POST /internal/rpc { target, method, args }: ponte CRM ↔ engine, Bearer INTERNAL_TOKEN, lista fechada.
//    Sucesso → 200 { result }; erro de domínio → { error } serializado, com o HTTP do próprio erro.
//  - /internal/fake/*: controle do FakeTransport, montado SÓ com WA_TRANSPORT=fake.
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import type { FakeControl } from '../boot/fake-control'
import { httpStatusOf, isDomainError, serializeError } from './errors'
import { resolveHandler, type RpcHandlers } from './targets'

export function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!m || !token) return false
  const a = Buffer.from(m[1]!.trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface InternalAppOptions {
  token: string
  handlers: RpcHandlers
  /** Presente só com WA_TRANSPORT=fake. */
  fake?: FakeControl
  /** Fake: `POST /internal/fake/shutdown` dispara o mesmo encerramento do SIGTERM. */
  onShutdown?: () => void
  logger?: { error(obj: object, msg?: string): void }
}

type Status = 200 | 202 | 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 501 | 502 | 503

const readBody = async (c: Context): Promise<Record<string, unknown>> => {
  const text = await c.req.text()
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

const bad = (message: string) => Object.assign(new Error(message), { name: 'SyntaxError', code: 'VALIDATION_ERROR', status: 400 })

export function createInternalApp(opts: InternalAppOptions) {
  const app = new Hono()

  app.use('/internal/*', async (c, next) => {
    if (!tokenOk(c.req.header('authorization'), opts.token)) {
      return c.json({ error: { name: 'RpcError', code: 'UNAUTHORIZED', message: 'invalid internal token' } }, 401)
    }
    await next()
  })

  app.post('/internal/rpc', async (c) => {
    let req: Record<string, unknown>
    try {
      req = await readBody(c)
    } catch {
      return c.json({ error: { name: 'SyntaxError', code: 'MALFORMED_REQUEST', message: 'malformed JSON' } }, 400)
    }
    const fn = resolveHandler(opts.handlers, req.target, req.method)
    if (!fn) {
      return c.json({ error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: `unknown method ${String(req.target)}.${String(req.method)}` } }, 400)
    }
    try {
      const result = await fn(Array.isArray(req.args) ? req.args : [])
      return c.json({ result: result ?? null })
    } catch (err) {
      const e = serializeError(err)
      if (!isDomainError(e)) opts.logger?.error({ err: e, target: req.target, method: req.method }, 'internal rpc failed')
      return c.json({ error: e }, httpStatusOf(e) as Status)
    }
  })

  const fake = opts.fake
  if (fake) {
    const id = (c: Context) => c.req.param('id') ?? ''
    const run = async (c: Context, fn: (b: Record<string, unknown>) => unknown | Promise<unknown>) => {
      try {
        const out = await fn(await readBody(c))
        return c.json(out === undefined ? { ok: true } : (out as object))
      } catch (err) {
        const e = serializeError(err)
        const status = e.code === 'FAKE_TRANSPORT_NOT_FOUND' ? 404 : e.name === 'SyntaxError' ? 400 : 500
        return c.json({ error: e }, status)
      }
    }
    app.get('/internal/fake/boot', (c) => c.json({ bootId: fake.bootId }))
    app.get('/internal/fake/sessions/:id/state', (c) => c.json(fake.state(id(c))))
    app.get('/internal/fake/sessions/:id/sent-history', (c) => run(c, async () => ({ items: await fake.history(id(c)) })))
    app.post('/internal/fake/sessions/:id/qr', (c) => run(c, (b) => fake.qr(id(c), b.qr === undefined ? undefined : String(b.qr))))
    app.post('/internal/fake/sessions/:id/pairing-code', (c) => run(c, (b) => fake.pairingCode(id(c), b.code === undefined ? undefined : String(b.code))))
    app.post('/internal/fake/sessions/:id/open', (c) => run(c, () => fake.open(id(c))))
    app.post('/internal/fake/sessions/:id/close', (c) =>
      run(c, (b) => {
        const reason = String(b.reason ?? 'transient')
        if (!['loggedOut', 'forbidden', 'transient'].includes(reason)) throw bad('reason must be loggedOut, forbidden or transient')
        return fake.close(id(c), reason as 'loggedOut' | 'forbidden' | 'transient', b.statusCode === undefined ? undefined : Number(b.statusCode))
      }),
    )
    app.post('/internal/fake/sessions/:id/receive', (c) =>
      run(c, (b) => {
        if (typeof b.from !== 'string' || !b.from) throw bad('from is required')
        const msg: { from: string; text?: string; fromMe?: boolean; type?: string } = { from: b.from }
        if (typeof b.text === 'string') msg.text = b.text
        if (typeof b.fromMe === 'boolean') msg.fromMe = b.fromMe
        if (typeof b.type === 'string') msg.type = b.type
        return fake.receive(id(c), msg)
      }),
    )
    app.post('/internal/fake/sessions/:id/receipt', (c) =>
      run(c, (b) => {
        const status = String(b.status ?? 'delivered')
        if (typeof b.messageId !== 'string' || !['delivered', 'read'].includes(status)) throw bad('messageId and status (delivered|read) are required')
        return fake.receipt(id(c), b.messageId, status as 'delivered' | 'read')
      }),
    )
    app.post('/internal/fake/sessions/:id/fail-next-send', (c) =>
      run(c, (b) => {
        const o: { message?: string; statusCode?: number } = {}
        if (typeof b.message === 'string') o.message = b.message
        if (b.statusCode !== undefined) o.statusCode = Number(b.statusCode)
        return fake.failNextSend(id(c), o)
      }),
    )
    app.post('/internal/fake/shutdown', (c) => {
      // Responde antes: o encerramento fecha este servidor.
      setTimeout(() => opts.onShutdown?.(), 10)
      return c.json({ ok: true, shuttingDown: Boolean(opts.onShutdown) }, 202)
    })
  }

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `route not found: ${c.req.method} ${c.req.path}` } }, 404))
  return app
}

export interface InternalServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startInternalServer(opts: InternalAppOptions & { port: number; host?: string }): Promise<InternalServer> {
  const app = createInternalApp(opts)
  // Loopback por padrão (o RPC interno não deve ficar exposto em todas as interfaces).
  const host = opts.host ?? '127.0.0.1'
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: host }, () => resolve(s))
    s.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  const sockets = server as unknown as { closeAllConnections?: () => void }
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        sockets.closeAllConnections?.()
      }),
  }
}

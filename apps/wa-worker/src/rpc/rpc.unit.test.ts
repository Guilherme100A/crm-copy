import { SendRejectedError } from '@crm/wa-port'
import { describe, expect, it, vi } from 'vitest'
import { ClientMessageDedupe } from './dedupe'
import { httpStatusOf, RpcError, serializeError } from './errors'
import { createInternalApp, tokenOk } from './server'
import { resolveHandler, type RpcHandlers } from './targets'

const TOKEN = 'internal-secret'
const handlers: RpcHandlers = {
  sessions: { get: async ([id]) => ({ id, status: 'NEW' }) },
  messages: {
    enqueue: async () => {
      throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'contact not allowed: no_consent', { reason: 'no_consent' })
    },
    boom: async () => {
      throw new Error('kaput')
    },
  },
}
const app = createInternalApp({ token: TOKEN, handlers })
const rpc = (body: unknown, token: string | null = TOKEN) =>
  app.request('/internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('RPC interno', () => {
  it('sem Bearer válido → 401', async () => {
    expect((await rpc({ target: 'sessions', method: 'get', args: ['s'] }, null)).status).toBe(401)
    expect((await rpc({ target: 'sessions', method: 'get', args: ['s'] }, 'outro')).status).toBe(401)
    expect(tokenOk('Bearer internal-secret', TOKEN)).toBe(true)
    expect(tokenOk('internal-secret', TOKEN)).toBe(false)
    expect(tokenOk('Bearer x', '')).toBe(false)
  })

  it.each([
    ['sessions', 'constructor'],
    ['sessions', 'toString'],
    ['sessions', '__proto__'],
    ['sessions', 'hasOwnProperty'],
    ['constructor', 'name'],
    ['__proto__', 'get'],
    ['sessions', 'nope'],
    ['nope', 'get'],
  ])('%s.%s fora da lista → 400 UNKNOWN_METHOD', async (target, method) => {
    const res = await rpc({ target, method, args: [] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'UNKNOWN_METHOD' } })
  })

  it('sucesso → 200 { result }; JSON quebrado → 400 MALFORMED_REQUEST', async () => {
    const ok = await rpc({ target: 'sessions', method: 'get', args: ['s1'] })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ result: { id: 's1', status: 'NEW' } })
    const bad = await rpc('{x')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'MALFORMED_REQUEST' } })
  })

  it('SendRejectedError volta com o mesmo code, status e HTTP', async () => {
    const res = await rpc({ target: 'messages', method: 'enqueue', args: [{}] })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { name: 'SendRejectedError', message: 'contact not allowed: no_consent', code: 'CONTACT_NOT_ALLOWED', status: 403, details: { reason: 'no_consent' } },
    })
  })

  it('erro inesperado → 500 e log', async () => {
    const error = vi.fn()
    const logged = createInternalApp({ token: TOKEN, handlers, logger: { error } })
    const res = await logged.request('/internal/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ target: 'messages', method: 'boom' }),
    })
    expect(res.status).toBe(500)
    expect(error).toHaveBeenCalled()
  })

  it('rotas /internal/fake/* não existem sem WA_TRANSPORT=fake', async () => {
    const res = await app.request('/internal/fake/boot', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(404)
  })
})

describe('errors', () => {
  it('HTTP pelo status do erro ou pelo código', () => {
    expect(httpStatusOf(serializeError(new SendRejectedError('RATE_LIMIT', 'x')))).toBe(429)
    expect(httpStatusOf({ name: 'SessionError', message: '', code: 'SESSION_NOT_FOUND' })).toBe(404)
    expect(httpStatusOf({ name: 'InvalidTransitionError', message: '', code: 'INVALID_TRANSITION' })).toBe(409)
    expect(httpStatusOf(serializeError(new RpcError('NOT_SUPPORTED', 'x')))).toBe(501)
    expect(httpStatusOf({ name: 'Error', message: '' })).toBe(500)
    expect(serializeError('texto')).toEqual({ name: 'Error', message: 'texto' })
  })
})

describe('resolveHandler', () => {
  it('só métodos próprios', () => {
    expect(resolveHandler(handlers, 'sessions', 'get')).toBeTypeOf('function')
    expect(resolveHandler(handlers, 'sessions', 'constructor')).toBeUndefined()
    expect(resolveHandler(handlers, 1, 'get')).toBeUndefined()
  })
})

class MemRedis {
  readonly data = new Map<string, string>()
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes('NX') && this.data.has(key)) return null
    this.data.set(key, value)
    return 'OK'
  }
  async get(key: string) {
    return this.data.get(key) ?? null
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0
  }
}

describe('ClientMessageDedupe', () => {
  it('mesmo id → mesma mensagem e um único envio; sem id sempre envia', async () => {
    const redis = new MemRedis()
    const dedupe = new ClientMessageDedupe(redis, { prefix: 't' })
    let n = 0
    const send = async () => ({ id: `m${++n}` })
    const lookup = async (id: string) => ({ id })
    expect(await dedupe.run('s1', 'c1', send, lookup)).toEqual({ id: 'm1' })
    expect(await dedupe.run('s1', 'c1', send, lookup)).toEqual({ id: 'm1' })
    expect(await dedupe.run('s2', 'c1', send, lookup)).toEqual({ id: 'm2' })
    expect(await dedupe.run('s1', undefined, send, lookup)).toEqual({ id: 'm3' })
    expect(redis.data.get('t:client-msg:s1:c1')).toBe('m1')
  })

  it('envios concorrentes com o mesmo id: um envia, o outro espera e recebe a mesma mensagem', async () => {
    const dedupe = new ClientMessageDedupe(new MemRedis(), { pollMs: 5 })
    let n = 0
    const send = async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { id: `m${++n}` }
    }
    const [a, b] = await Promise.all([dedupe.run('s', 'c', send, async (id) => ({ id })), dedupe.run('s', 'c', send, async (id) => ({ id }))])
    expect(a).toEqual(b)
    expect(n).toBe(1)
  })

  it('falha no envio libera a reserva (próxima tentativa envia)', async () => {
    const redis = new MemRedis()
    const dedupe = new ClientMessageDedupe(redis)
    await expect(dedupe.run('s', 'c', async () => Promise.reject(new SendRejectedError('RATE_LIMIT', 'x')), async (id) => ({ id }))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    })
    expect(redis.data.size).toBe(0)
    expect(await dedupe.run('s', 'c', async () => ({ id: 'ok' }), async (id) => ({ id }))).toEqual({ id: 'ok' })
  })
})

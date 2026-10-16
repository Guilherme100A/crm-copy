// Gateway RPC sem worker: fetch falso (formato do POST /internal/rpc), erros re-hidratados, timeout, worker fora do
// ar, capacidade ausente e repasse dos campos de envio.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SendRejectedError, TransportNotConnectedError, WaGatewayError, defaultCapabilities } from '@crm/wa-port'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityNotSupportedError, RemoteRpcError, WorkerUnavailableError } from './errors'
import { createRpcGateway } from './gateway'
import { crmProfile, registerGatewayProfile, resolveGatewayProfile, UnknownGatewayProfileError, type GatewayProfile } from './profiles'
import type { FetchLike } from './rpc-client'

interface Call {
  url: string
  headers: Record<string, string>
  body: { target: string; method: string; args: unknown[] }
  signal: AbortSignal | undefined
}

/** fetch falso: devolve `respond(call)` como `{ status, body }`. */
function fakeFetch(respond: (call: Call) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fn: FetchLike = async (url, init) => {
    const call: Call = { url, headers: init.headers, body: JSON.parse(init.body) as Call['body'], signal: init.signal }
    calls.push(call)
    const r = await respond(call)
    return { status: r.status ?? 200, json: async () => r.body }
  }
  return { fn: vi.fn(fn), calls }
}

const ok = (result: unknown) => ({ body: { result } })
const gw = (fetch: FetchLike, extra: Partial<Parameters<typeof createRpcGateway>[0]> = {}) =>
  createRpcGateway({ url: 'http://worker.test:3100/', token: 'tkn', fetch, ...extra })

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe('RPC: formato da chamada e perfil crm', () => {
  it('POST /internal/rpc com Bearer e { target, method, args }; resultado em `result`', async () => {
    const f = fakeFetch(() => ok([{ id: 's1' }]))
    const list = await gw(f.fn).sessions.list()
    expect(list).toEqual([{ id: 's1' }])
    expect(f.calls[0]).toMatchObject({
      url: 'http://worker.test:3100/internal/rpc',
      headers: { authorization: 'Bearer tkn', 'content-type': 'application/json' },
      body: { target: 'sessions', method: 'list', args: [] },
    })
  })

  it('cada método da porta cai no alvo do wa-worker (perfil crm completo)', async () => {
    const f = fakeFetch(({ body }) => ok(body.target === 'media' ? { data: Buffer.from('xyz').toString('base64') } : body.target === 'profile' ? { name: 'N', status: null, pictureUrl: null, phone: '+55' } : {}))
    const g = gw(f.fn)
    const handle = { session_id: 's', message_id: 'm', mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' as const }
    await g.sessions.create({ name: 'a' })
    await g.sessions.get('s')
    await g.sessions.startQr('s')
    await g.sessions.getQr('s')
    await g.sessions.requestPairingCode('s')
    await g.sessions.pause('s')
    await g.sessions.resume('s')
    await g.sessions.restart('s')
    await g.sessions.logout('s')
    await g.sessions.remove('s')
    await g.cancel('m1')
    await g.fetchGroups('s')
    expect(Array.from((await g.downloadMedia('s', handle)) as Uint8Array)).toEqual(Array.from(Buffer.from('xyz')))
    await g.presence('s', '+5511999990000', 'composing')
    await g.react({ sessionId: 's', phone: '+55', messageId: 'w1', emoji: '👍', actor: 'crm:u' })
    await g.deleteForEveryone({ sessionId: 's', phone: '+55', messageId: 'w1', actor: 'crm:u' })
    await g.listContacts('s')
    await g.recordConsent({ phone: '+55', source: 'inbound' })
    await g.optOut({ phone: '+55' })
    await g.markRead!('s', '55@s.whatsapp.net', ['a', 'b'])
    expect(await g.profile!.get('s')).toEqual({ name: 'N', status: null, pictureUrl: null })
    await g.profile!.setName!('s', 'Loja')
    expect(f.calls.map((c) => `${c.body.target}.${c.body.method}`)).toEqual([
      'sessions.create',
      'sessions.get',
      'sessions.startQr',
      'sessions.getQr',
      'sessions.requestPairingCode',
      'sessions.pause',
      'sessions.resume',
      'sessions.restart',
      'sessions.logout',
      'sessions.remove',
      'messages.cancel',
      'sessions.fetchGroups',
      'media.download',
      'presence.update',
      'messages.react',
      'messages.deleteForEveryone',
      'contacts.list',
      'contacts.recordConsent',
      'contacts.optOut',
      'messages.markRead',
      'profile.get',
      'profile.setName',
    ])
    expect(f.calls.find((c) => c.body.method === 'requestPairingCode')!.body.args).toEqual(['s', null])
    expect(f.calls.find((c) => c.body.method === 'markRead')!.body.args).toEqual(['s', '55@s.whatsapp.net', ['a', 'b']])
    expect(f.calls.find((c) => c.body.target === 'presence')!.body.args).toEqual(['s', '+5511999990000', 'composing'])
  })

  it('send/sendGroup repassam clientMessageId, quoted e viewOnce ao messages.enqueue/sendGroup', async () => {
    const f = fakeFetch(() => ok({ id: 'q1', status: 'queued' }))
    const g = gw(f.fn)
    const req = { sessionId: 's', phone: '+5511999990000', content: { image: { url: 'blob:abc' } }, actor: 'crm:u1', contactId: 'c1', clientMessageId: 'cm-1', quoted: 'wamid.X', viewOnce: true }
    expect(await g.send(req)).toEqual({ id: 'q1', status: 'queued' })
    await g.sendGroup({ sessionId: 's', groupId: '1@g.us', content: { text: 'oi' }, actor: 'crm:u1', clientMessageId: 'cm-2', quoted: 'wamid.Y', viewOnce: false })
    expect(f.calls[0]!.body).toEqual({ target: 'messages', method: 'enqueue', args: [req] })
    expect(f.calls[1]!.body.args[0]).toMatchObject({ clientMessageId: 'cm-2', quoted: 'wamid.Y', viewOnce: false })
  })
})

describe('AC-T46-02 erros re-hidratados', () => {
  it('rejeição do pipeline volta como SendRejectedError com o mesmo code, status e gate', async () => {
    for (const [code, status] of [
      ['UNAUTHORIZED', 401],
      ['VALIDATION_ERROR', 400],
      ['SESSION_NOT_FOUND', 404],
      ['SESSION_NOT_CONNECTED', 409],
      ['CONTACT_NOT_ALLOWED', 403],
      ['WARMUP_LIMIT', 429],
      ['RATE_LIMIT', 429],
    ] as const) {
      const f = fakeFetch(() => ({ status, body: { error: { name: 'SendRejectedError', code, status, gate: 'rateLimit', message: `nope ${code}`, details: { retryAfterMs: 10 } } } }))
      const err = await gw(f.fn)
        .send({ sessionId: 's', phone: '+55', content: { text: 'x' }, actor: 'crm:u' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SendRejectedError)
      expect(err).toMatchObject({ name: 'SendRejectedError', code, status, gate: 'rateLimit', message: `nope ${code}`, details: { retryAfterMs: 10 } })
    }
  })

  it('erros de sessão/mensagem viram WaGatewayError; transporte desconectado e erro desconhecido preservam nome e código', async () => {
    const reply = (error: object, status: number) => fakeFetch(() => ({ status, body: { error } })).fn
    await expect(gw(reply({ name: 'SessionError', code: 'SESSION_NOT_FOUND', message: 'x' }, 404)).sessions.get('s')).rejects.toSatisfy(
      (e) => e instanceof WaGatewayError && e.code === 'SESSION_NOT_FOUND' && e.status === 404,
    )
    await expect(gw(reply({ name: 'InvalidTransitionError', code: 'INVALID_TRANSITION', message: 'x' }, 409)).sessions.pause('s')).rejects.toMatchObject({
      name: 'WaGatewayError',
      code: 'INVALID_TRANSITION',
      status: 409,
    })
    await expect(gw(reply({ name: 'RpcError', code: 'NOT_SUPPORTED', message: 'sem suporte' }, 501)).profile!.setName!('s', 'n')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      status: 501,
    })
    await expect(gw(reply({ name: 'TransportNotConnectedError', code: 'TRANSPORT_NOT_CONNECTED', message: 'off' }, 409)).fetchGroups('s')).rejects.toBeInstanceOf(
      TransportNotConnectedError,
    )
    const other = await gw(reply({ name: 'ProxyError', code: 'PROXY_IN_USE', message: 'em uso' }, 409))
      .sessions.remove('s')
      .catch((e: unknown) => e)
    expect(other).toBeInstanceOf(RemoteRpcError)
    expect(other).toMatchObject({ name: 'ProxyError', code: 'PROXY_IN_USE', status: 409, message: 'em uso' })
  })

  it('UNKNOWN_METHOD do worker vira CapabilityNotSupportedError remoto', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: 'unknown' } } }))
    await expect(gw(f.fn).listContacts('s')).rejects.toMatchObject({ name: 'CapabilityNotSupportedError', method: 'contacts.list', remote: true, status: 501 })
  })
})

describe('AC-T46-03 worker fora do ar', () => {
  it('porta fechada → WorkerUnavailableError (unreachable) rápido e sem exceção não tratada', async () => {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const g = createRpcGateway({ url: `http://127.0.0.1:${port}`, token: 't', timeoutMs: 2000 })
      const started = Date.now()
      const err = await g.sessions.list().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WorkerUnavailableError)
      expect(err).toMatchObject({ code: 'WORKER_UNAVAILABLE', status: 503, reason: 'unreachable' })
      expect(Date.now() - started).toBeLessThanOrEqual(2000)
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('worker que não responde → WorkerUnavailableError (timeout) em ≤ timeoutMs', async () => {
    const s = createServer(() => undefined) // aceita e nunca responde
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const g = createRpcGateway({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: 't', timeoutMs: 300 })
    const started = Date.now()
    const err = await g.send({ sessionId: 's', phone: '+55', content: { text: 'x' }, actor: 'crm:u' }).catch((e: unknown) => e)
    const elapsed = Date.now() - started
    expect(err).toMatchObject({ name: 'WorkerUnavailableError', reason: 'timeout' })
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(300 + 250)
    s.closeAllConnections()
  })

  it('pareamento usa o timeout próprio (60 s por padrão), o resto o timeout comum', async () => {
    const seen: { method: string; timeoutMs: number }[] = []
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const f = fakeFetch(({ body }) => {
      seen.push({ method: body.method, timeoutMs: spy.mock.calls.at(-1)![0] })
      return ok({ code: 'ABCD-1234' })
    })
    const g = gw(f.fn, { timeoutMs: 1500 })
    expect(await g.sessions.requestPairingCode('s', '+5511999990000')).toEqual({ code: 'ABCD-1234' })
    await g.sessions.get('s')
    expect(seen).toEqual([
      { method: 'requestPairingCode', timeoutMs: 60_000 },
      { method: 'get', timeoutMs: 1500 },
    ])
    const g2 = gw(f.fn, { timeoutMs: 1500, pairingTimeoutMs: 5000 })
    await g2.sessions.requestPairingCode('s')
    expect(seen.at(-1)).toEqual({ method: 'requestPairingCode', timeoutMs: 5000 })
    spy.mockRestore()
  })

  it('token recusado (401 do middleware) e resposta que não é do RPC → WorkerUnavailableError', async () => {
    const bad = fakeFetch(() => ({ status: 401, body: { error: { name: 'RpcError', code: 'UNAUTHORIZED', message: 'invalid internal token' } } }))
    await expect(gw(bad.fn).sessions.list()).rejects.toMatchObject({ name: 'WorkerUnavailableError', reason: 'unauthorized' })
    const html: FetchLike = async () => ({ status: 502, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) })
    await expect(gw(html).sessions.list()).rejects.toMatchObject({ name: 'WorkerUnavailableError', reason: 'invalid_response' })
    const noResult = fakeFetch(() => ({ status: 503, body: {} }))
    await expect(gw(noResult.fn).sessions.list()).rejects.toMatchObject({ name: 'WorkerUnavailableError', reason: 'invalid_response' })
  })
})

describe('AC-T46-04 capacidade ausente no perfil', () => {
  const partial: GatewayProfile = {
    ...crmProfile,
    name: 'parcial',
    methods: { ...crmProfile.methods, fetchGroups: undefined, react: undefined, markRead: undefined, 'profile.get': undefined, capabilities: undefined },
  }

  it('método obrigatório sem rota lança CapabilityNotSupportedError sem chamar a rede', async () => {
    const f = fakeFetch(() => ok(null))
    const g = gw(f.fn, { profile: partial })
    await expect(g.fetchGroups('s')).rejects.toBeInstanceOf(CapabilityNotSupportedError)
    await expect(g.react({ sessionId: 's', phone: '+55', messageId: 'm', emoji: '👍', actor: 'crm:u' })).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      method: 'react',
      profile: 'parcial',
      remote: false,
    })
    expect(f.fn).not.toHaveBeenCalled()
  })

  it('métodos opcionais sem rota não existem no gateway (o CRM degrada: markRead, profile)', () => {
    const g = gw(fakeFetch(() => ok(null)).fn, { profile: partial })
    expect(g.markRead).toBeUndefined()
    expect(g.profile).toBeUndefined()
    const full = gw(fakeFetch(() => ok(null)).fn)
    expect(typeof full.markRead).toBe('function')
    expect(typeof full.profile?.get).toBe('function')
  })
})

describe('capacidades', () => {
  it('começam com as do perfil; refreshCapabilities consulta o worker e atualiza no lugar', async () => {
    const f = fakeFetch(() => ok({ businessProfile: true, calls: 'x' }))
    const g = gw(f.fn)
    expect(g.capabilities).toEqual(defaultCapabilities())
    const caps = g.capabilities
    await g.refreshCapabilities()
    expect(f.calls[0]!.body).toMatchObject({ target: 'meta', method: 'capabilities' })
    expect(caps).toEqual({ ...defaultCapabilities(), businessProfile: true })
  })

  it('worker sem a consulta (UNKNOWN_METHOD) ou perfil sem rota mantém as do perfil; rede fora propaga', async () => {
    const unknown = fakeFetch(() => ({ status: 400, body: { error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: 'x' } } }))
    expect(await gw(unknown.fn).refreshCapabilities()).toEqual(defaultCapabilities())
    const noRoute = fakeFetch(() => ok({ calls: true }))
    const g = gw(noRoute.fn, { profile: { ...crmProfile, methods: { ...crmProfile.methods, capabilities: undefined } } })
    expect(await g.refreshCapabilities()).toEqual(defaultCapabilities())
    expect(noRoute.fn).not.toHaveBeenCalled()
    const down: FetchLike = async () => Promise.reject(new TypeError('fetch failed'))
    await expect(gw(down).refreshCapabilities()).rejects.toBeInstanceOf(WorkerUnavailableError)
  })
})

describe('perfis', () => {
  it('crm é o padrão; nome desconhecido falha com a lista; registerGatewayProfile acrescenta', () => {
    expect(resolveGatewayProfile()).toBe(crmProfile)
    expect(() => resolveGatewayProfile('nao-existe')).toThrow(UnknownGatewayProfileError)
    const custom: GatewayProfile = { name: 'teste-t46', methods: { 'sessions.list': 'sessions.list' }, capabilities: defaultCapabilities() }
    registerGatewayProfile(custom)
    expect(resolveGatewayProfile('teste-t46')).toBe(custom)
  })

  it('rota com adaptadores de argumentos e resultado', async () => {
    const f = fakeFetch(({ body }) => ok({ items: body.args }))
    const profile: GatewayProfile = {
      name: 'adaptado',
      methods: { 'sessions.list': { rpc: 'sessions.listAll', args: () => [{ all: true }], result: (raw) => (raw as { items: unknown }).items } },
      capabilities: defaultCapabilities(),
    }
    expect(await gw(f.fn, { profile }).sessions.list()).toEqual([{ all: true }])
    expect(f.calls[0]!.body).toMatchObject({ target: 'sessions', method: 'listAll' })
  })

  it('subscribe sem redis falha com mensagem clara', () => {
    expect(() => gw(fakeFetch(() => ok(null)).fn).subscribe(() => undefined)).toThrow(/redis/)
  })
})

// AC-T46-02..04 e repasses do adapter (clientMessageId, quoted, viewOnce, markRead), contra o wa-worker filho.
import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fake, newWorkerEnv, phone, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'
import { ACTOR, gatewayFor, harnessFor, rpcMod } from './support'

let env: WorkerEnv
let w: Worker
let M: any
let SendRejectedError: any
const gateways: any[] = []

beforeAll(async () => {
  env = newWorkerEnv()
  w = await startWorker(env)
  M = await rpcMod()
  ;({ SendRejectedError } = await import('@crm/wa-port'))
}, 180_000)

afterAll(async () => {
  for (const g of gateways) await g.close?.().catch(() => {})
  await w?.shutdown().catch(() => w?.kill())
  env?.cleanup()
}, 60_000)

async function gw(extra: Record<string, unknown> = {}) {
  const g = await gatewayFor(w, env, extra)
  gateways.push(g)
  return g
}

/** Sessão conectada no wa-worker (via harness da suíte de contrato). */
async function connected() {
  const h = await harnessFor(w, env)
  gateways.push(h.gateway)
  const s = await h.gateway.sessions.create({ name: `t46-${Math.random().toString(36).slice(2, 6)}` })
  await h.connect(s.id)
  return { g: h.gateway, sessionId: s.id as string }
}

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: any) => e)

describe('T46 — rejeições re-hidratadas (AC-T46-02)', () => {
  it('AC-T46-02 contato sem consentimento → SendRejectedError CONTACT_NOT_ALLOWED 403', async () => {
    const { g, sessionId } = await connected()
    const err = await caught(g.send({ sessionId, phone: phone(), content: { text: 'x' }, actor: ACTOR }))
    expect(err).toBeInstanceOf(SendRejectedError)
    expect([err.code, err.status]).toEqual(['CONTACT_NOT_ALLOWED', 403])
  })

  it('AC-T46-02 sem actor → UNAUTHORIZED 401; sessão inexistente → SESSION_NOT_FOUND 404; pausada → SESSION_NOT_CONNECTED 409', async () => {
    const { g, sessionId } = await connected()
    const to = phone()
    await g.recordConsent({ phone: to, source: 'manual' })
    const noActor = await caught(g.send({ sessionId, phone: to, content: { text: 'x' } }))
    expect(noActor).toBeInstanceOf(SendRejectedError)
    expect([noActor.code, noActor.status]).toEqual(['UNAUTHORIZED', 401])
    const missing = await caught(g.send({ sessionId: '00000000-0000-4000-8000-000000000000', phone: to, content: { text: 'x' }, actor: ACTOR }))
    expect([missing?.code, missing?.status]).toEqual(['SESSION_NOT_FOUND', 404])
    await g.sessions.pause(sessionId)
    const paused = await caught(g.send({ sessionId, phone: to, content: { text: 'x' }, actor: ACTOR }))
    expect(paused).toBeInstanceOf(SendRejectedError)
    expect([paused.code, paused.status]).toEqual(['SESSION_NOT_CONNECTED', 409])
  })
})

describe('T46 — worker fora do ar (AC-T46-03)', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => void unhandled.push(e)
  let hanging: Server
  const sockets = new Set<import('node:net').Socket>()

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled)
    // servidor que aceita a conexão e nunca responde (worker travado)
    hanging = createServer((s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', () => r()))
  })

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled)
    // o servidor 'travado' nunca responde: destrói as conexões para conseguir fechar
    for (const s of sockets) s.destroy()
    await new Promise<void>((r) => hanging.close(() => r()))
  })

  it('AC-T46-03 porta sem ninguém ouvindo → WorkerUnavailableError dentro do timeout', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as any).port
        s.close(() => resolve(p))
      })
    })
    const { createRpcGateway, WorkerUnavailableError } = M
    const g = createRpcGateway({ url: `http://127.0.0.1:${free}`, token: env.token, profile: 'crm', timeoutMs: 300 })
    gateways.push(g)
    const t0 = Date.now()
    const err = await caught(g.sessions.list())
    expect(err).toBeInstanceOf(WorkerUnavailableError)
    expect(err.code).toBe('WORKER_UNAVAILABLE')
    expect(Date.now() - t0).toBeLessThanOrEqual(300 + 700)
  })

  it('AC-T46-03 worker que não responde → WorkerUnavailableError em ≤ timeout, sem rejeição não tratada', async () => {
    const { createRpcGateway, WorkerUnavailableError } = M
    const port = (hanging.address() as any).port
    const g = createRpcGateway({ url: `http://127.0.0.1:${port}`, token: env.token, profile: 'crm', timeoutMs: 300 })
    gateways.push(g)
    const t0 = Date.now()
    const err = await caught(g.send({ sessionId: 's', phone: '+5511999990000', content: { text: 'x' }, actor: ACTOR }))
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(WorkerUnavailableError)
    expect(took).toBeGreaterThanOrEqual(250)
    expect(took).toBeLessThanOrEqual(300 + 700)
    await new Promise((r) => setTimeout(r, 300))
    expect(unhandled).toEqual([])
  })
})

describe('T46 — capacidade ausente no perfil (AC-T46-04)', () => {
  it('AC-T46-04 método sem mapeamento → CapabilityNotSupportedError sem chamar a rede', async () => {
    const { createRpcGateway, crmProfile, CapabilityNotSupportedError } = M
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const profile = { ...crmProfile, methods: { ...crmProfile.methods, fetchGroups: undefined } }
    const g = createRpcGateway({ url: w.url, token: env.token, profile, fetch: fetchSpy })
    gateways.push(g)
    const err = await caught(Promise.resolve().then(() => g.fetchGroups('qualquer')))
    expect(err).toBeInstanceOf(CapabilityNotSupportedError)
    expect(err.code).toBe('CAPABILITY_NOT_SUPPORTED')
    // nenhuma requisição carregou o método sem mapeamento
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[1]?.body ?? '').includes('fetchGroups'))).toBe(false)
  })

  it('AC-T46-04 com o mapeamento presente o mesmo método funciona pela rede', async () => {
    const { g, sessionId } = await connected()
    expect(Array.isArray(await g.fetchGroups(sessionId))).toBe(true)
  })
})

describe('T46 — repasse pelo adapter (clientMessageId, quoted, viewOnce, markRead)', () => {
  it('T46 clientMessageId, quoted e viewOnce chegam ao worker; o mesmo clientMessageId devolve a mesma mensagem', async () => {
    const bodies: any[] = []
    const spy = async (url: any, init: any) => {
      if (String(url).includes('/internal/rpc') && init?.body) bodies.push(JSON.parse(String(init.body)))
      return fetch(url, init)
    }
    const h = await harnessFor(w, env)
    gateways.push(h.gateway)
    const s = await h.gateway.sessions.create({ name: 't46-repasse' })
    await h.connect(s.id)
    const g = await gw({ fetch: spy })
    const to = phone()
    await g.recordConsent({ phone: to, source: 'inbound' })
    const req = { sessionId: s.id, phone: to, content: { text: 'com repasse' }, actor: ACTOR, clientMessageId: `cmid-${Date.now()}`, quoted: 'WA-QUOTED-1', viewOnce: true }
    const a = await g.send(req)
    const b = await g.send(req)
    expect(b.id).toBe(a.id)
    const sent = bodies.find((x) => x.method === 'enqueue' || String(x.method).includes('enqueue'))
    expect(sent, JSON.stringify(bodies.map((x) => `${x.target}.${x.method}`))).toBeDefined()
    expect(sent.args[0]).toMatchObject({ clientMessageId: req.clientMessageId, quoted: 'WA-QUOTED-1', viewOnce: true })
  })

  it('T46 markRead(sessionId, chatJid, ids) passa pelo adapter e chega ao transporte do worker', async () => {
    const { g, sessionId } = await connected()
    expect(typeof g.markRead).toBe('function')
    const chat = `${phone().slice(1)}@s.whatsapp.net`
    await g.markRead(sessionId, chat, ['WA-R1', 'WA-R2'])
    const state = (await fake(w, env, `sessions/${sessionId}/state`, undefined, 'GET')).body
    const reads = JSON.stringify(state.reads ?? [])
    expect(reads).toContain('WA-R1')
    expect(reads).toContain(chat)
  })

  it('T46 eventos do stream chegam aos assinantes do gateway (subscribe)', async () => {
    const { g, sessionId } = await connected()
    const got: any[] = []
    const off = g.subscribe((e: any) => void got.push(e))
    await fake(w, env, `sessions/${sessionId}/receive`, { from: `${phone().slice(1)}@s.whatsapp.net`, text: 'chegou pelo stream' })
    await waitFor(() => got.some((e) => e.type === 'message.inbound' && e.message?.text === 'chegou pelo stream'), 15_000, 'message.inbound no subscribe')
    off?.()
  })
})

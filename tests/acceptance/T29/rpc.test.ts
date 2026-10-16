// AC-T29-01..04 e pendências da T29, contra o wa-worker rodando como processo filho (WA_TRANSPORT=fake).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  connectedSession,
  fake,
  jidOf,
  newRedis,
  newWorkerEnv,
  phone,
  rand,
  rpc,
  startWorker,
  streamEvents,
  waitFor,
  type Worker,
  type WorkerEnv,
} from './support'

let env: WorkerEnv
let w: Worker
let redis: any

beforeAll(async () => {
  env = newWorkerEnv()
  w = await startWorker(env)
  redis = await newRedis()
}, 180_000)

afterAll(async () => {
  await w?.shutdown().catch(() => w?.kill())
  await redis?.del(env.stream).catch(() => {})
  await redis?.quit().catch(() => {})
  env?.cleanup()
}, 60_000)

const ACTOR = 'crm:user-t29'

describe('T29 — autenticação e lista fechada (AC-T29-01)', () => {
  it('AC-T29-01 sem Bearer ou com token inválido → 401', async () => {
    for (const token of [null, 'errado', `${env.token}x`, '']) {
      const r = await rpc(w, env, 'sessions', 'list', [], token)
      expect(r.status, `token ${JSON.stringify(token)}`).toBe(401)
    }
    expect((await rpc(w, env, 'sessions', 'list')).status).toBe(200)
  })

  it('AC-T29-01 rotas /internal/fake/* também exigem o Bearer', async () => {
    const r = await fetch(`${w.url}/internal/fake/boot`)
    expect(r.status).toBe(401)
  })

  it('AC-T29-01 método fora da lista (constructor, propriedades herdadas, alvo inexistente) → 400 UNKNOWN_METHOD', async () => {
    for (const [target, method] of [
      ['sessions', 'constructor'],
      ['sessions', 'toString'],
      ['sessions', '__proto__'],
      ['sessions', 'hasOwnProperty'],
      ['messages', 'valueOf'],
      ['constructor', 'name'],
      ['__proto__', 'constructor'],
      ['sessions', 'getTransport'],
      ['naoexiste', 'list'],
    ]) {
      const r = await rpc(w, env, target!, method!)
      expect(r.status, `${target}.${method}`).toBe(400)
      expect(r.body?.error?.code, `${target}.${method}`).toBe('UNKNOWN_METHOD')
    }
  })
})

describe('T29 — sessão fake até WARMING (AC-T29-02)', () => {
  it('AC-T29-02 criar sessão → QR → abrir conexão → sessions.get = WARMING e session.state no stream', async () => {
    const s = await call(w, env, 'sessions', 'create', { name: `t29-${rand(3)}` })
    expect(typeof s.id).toBe('string')
    await call(w, env, 'sessions', 'startQr', s.id)
    await waitFor(async () => (await fake(w, env, `sessions/${s.id}/qr`, {})).status === 200, 20_000, 'QR fake')
    const qr = await waitFor(async () => call(w, env, 'sessions', 'getQr', s.id), 20_000, 'getQr')
    expect(qr).toBeTruthy()
    expect((await fake(w, env, `sessions/${s.id}/open`)).status).toBe(200)
    const got = await waitFor(async () => {
      const v = await call(w, env, 'sessions', 'get', s.id)
      return v.status === 'WARMING' ? v : undefined
    }, 20_000, 'WARMING')
    expect(got.status).toBe('WARMING')

    const events = await waitFor(async () => {
      const evs = (await streamEvents(redis, env.stream)).filter((e) => e.session_id === s.id)
      return evs.some((e) => e.type === 'session.state' && e.to === 'WARMING') ? evs : undefined
    }, 20_000, 'session.state → WARMING no stream')
    expect(events.some((e) => e.type === 'session.qr')).toBe(true)
    expect(events.some((e) => e.type === 'session.connection' && e.state === 'open')).toBe(true)
  })
})

describe('T29 — envio de ponta a ponta (AC-T29-03)', () => {
  it('AC-T29-03 messages.enqueue para contato consentido vai a sent e delivered (receipt fake) com message.status no stream', async () => {
    const sid = await connectedSession(w, env)
    const to = phone()
    await call(w, env, 'contacts', 'recordConsent', { phone: to, source: 'inbound' })
    const view = await call(w, env, 'messages', 'enqueue', { sessionId: sid, phone: to, content: { text: 'olá do CRM' }, actor: ACTOR })
    expect(view.status).toBe('queued')

    const sent = await waitFor(async () => {
      const m = await call(w, env, 'messages', 'get', view.id)
      return m.status === 'sent' ? m : undefined
    }, 30_000, 'sent')
    expect(sent.transportMessageId).toBeTruthy()
    const state = (await fake(w, env, `sessions/${sid}/state`, undefined, 'GET')).body
    expect(JSON.stringify(state.sent)).toContain('olá do CRM')

    expect((await fake(w, env, `sessions/${sid}/receipt`, { messageId: sent.transportMessageId, status: 'delivered' })).status).toBe(200)
    await waitFor(async () => (await call(w, env, 'messages', 'get', view.id)).status === 'delivered', 20_000, 'delivered')

    const statuses = await waitFor(async () => {
      const s = (await streamEvents(redis, env.stream)).filter((e) => e.type === 'message.status' && e.message_id === view.id).map((e) => e.status)
      return s.includes('sent') && s.includes('delivered') ? s : undefined
    }, 20_000, 'message.status sent e delivered no stream')
    expect(statuses.indexOf('sent')).toBeLessThan(statuses.indexOf('delivered'))
  })
})

describe('T29 — rejeições do pipeline (AC-T29-04)', () => {
  const expectRejected = (r: { status: number; body: any }, code: string, status: number) => {
    expect(r.status, JSON.stringify(r.body)).toBe(status)
    expect(r.body?.error?.code).toBe(code)
    expect(r.body?.error?.status).toBe(status)
    expect(r.body?.error?.name).toBe('SendRejectedError')
  }

  it('AC-T29-04 contato sem consentimento → CONTACT_NOT_ALLOWED 403 pela RPC', async () => {
    const sid = await connectedSession(w, env)
    const r = await rpc(w, env, 'messages', 'enqueue', [{ sessionId: sid, phone: phone(), content: { text: 'x' }, actor: ACTOR }])
    expectRejected(r, 'CONTACT_NOT_ALLOWED', 403)
    expect(r.body.error.gate).toBe('contactAllowed')
  })

  it('AC-T29-04 sem actor → UNAUTHORIZED 401; sessão inexistente → SESSION_NOT_FOUND 404', async () => {
    const to = phone()
    await call(w, env, 'contacts', 'recordConsent', { phone: to, source: 'manual' })
    const sid = await connectedSession(w, env)
    expectRejected(await rpc(w, env, 'messages', 'enqueue', [{ sessionId: sid, phone: to, content: { text: 'x' } }]), 'UNAUTHORIZED', 401)
    expectRejected(
      await rpc(w, env, 'messages', 'enqueue', [{ sessionId: '00000000-0000-4000-8000-000000000000', phone: to, content: { text: 'x' }, actor: ACTOR }]),
      'SESSION_NOT_FOUND',
      404,
    )
  })

  it('AC-T29-04 sessão pausada → SESSION_NOT_CONNECTED 409; opt-out → CONTACT_NOT_ALLOWED 403', async () => {
    const to = phone()
    await call(w, env, 'contacts', 'recordConsent', { phone: to, source: 'manual' })
    const sid = await connectedSession(w, env)
    await call(w, env, 'contacts', 'optOut', { phone: to })
    expectRejected(await rpc(w, env, 'messages', 'enqueue', [{ sessionId: sid, phone: to, content: { text: 'x' }, actor: ACTOR }]), 'CONTACT_NOT_ALLOWED', 403)

    const other = phone()
    await call(w, env, 'contacts', 'recordConsent', { phone: other, source: 'manual' })
    await call(w, env, 'sessions', 'pause', sid)
    expectRejected(await rpc(w, env, 'messages', 'enqueue', [{ sessionId: sid, phone: other, content: { text: 'x' }, actor: ACTOR }]), 'SESSION_NOT_CONNECTED', 409)
  })
})

describe('T29 — pendências combinadas (dedupe, markRead)', () => {
  it('T29 messages.enqueue com o mesmo clientMessageId devolve a mesma mensagem e envia uma vez', async () => {
    const sid = await connectedSession(w, env)
    const to = phone()
    await call(w, env, 'contacts', 'recordConsent', { phone: to, source: 'inbound' })
    const req = { sessionId: sid, phone: to, content: { text: `idempotente ${rand(2)}` }, actor: ACTOR, clientMessageId: `cmid-${rand()}` }
    const a = await call(w, env, 'messages', 'enqueue', req)
    const b = await call(w, env, 'messages', 'enqueue', req)
    expect(b.id).toBe(a.id)
    await waitFor(async () => (await call(w, env, 'messages', 'get', a.id)).status === 'sent', 30_000, 'sent')
    const state = (await fake(w, env, `sessions/${sid}/state`, undefined, 'GET')).body
    const copies = (state.sent ?? []).filter((m: any) => JSON.stringify(m).includes(req.content.text))
    expect(copies).toHaveLength(1)
  })

  it('T29 messages.markRead(sessionId, chatJid, ids) chega ao transporte', async () => {
    const sid = await connectedSession(w, env)
    const chat = jidOf(phone())
    await call(w, env, 'messages', 'markRead', sid, chat, ['WA-R1', 'WA-R2'])
    const state = (await fake(w, env, `sessions/${sid}/state`, undefined, 'GET')).body
    const reads = JSON.stringify(state.reads ?? [])
    expect(reads).toContain('WA-R1')
    expect(reads).toContain('WA-R2')
    expect(reads).toContain(chat)
  })
})

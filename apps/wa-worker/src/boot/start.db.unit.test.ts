/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON do RPC lidas como dados soltos no teste */
// wa-worker completo em processo: Postgres descartável, Redis real (prefixo e stream aleatórios), WA_TRANSPORT=fake.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, generateCredentialsKey, redisConnection } from '@crm/node-kit'
import { parseWaEvent, type WaEvent } from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startWaWorker, type WaWorkerHandle } from './start'

const TOKEN = 'test-internal-token'
let tmp: TempDatabase
let redis: Redis
let storageDir: string
const workers: WaWorkerHandle[] = []
const keys: string[] = []

beforeAll(async () => {
  tmp = await createTempDatabase()
  redis = redisConnection()
  storageDir = mkdtempSync(join(tmpdir(), 'crm-wa-worker-'))
}, 120_000)

afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop()
})

afterAll(async () => {
  for (const pattern of keys) {
    const found = await redis.keys(pattern)
    if (found.length) await redis.del(...found)
  }
  await redis.quit()
  await tmp?.drop()
  rmSync(storageDir, { recursive: true, force: true })
})

function envFor(prefix: string, stream: string): Record<string, string> {
  return {
    DATABASE_URL: tmp.url,
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379/1',
    CREDENTIALS_KEY,
    INTERNAL_TOKEN: TOKEN,
    WA_TRANSPORT: 'fake',
    WA_RPC_PORT: '0',
    WA_RPC_HOST: '127.0.0.1',
    WA_QUEUE_PREFIX: prefix,
    WA_EVENTS_STREAM: stream,
    STORAGE_DIR: storageDir,
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'silent',
  }
}
const CREDENTIALS_KEY = generateCredentialsKey()

async function boot(prefix: string, stream: string): Promise<WaWorkerHandle> {
  const w = await startWaWorker({ env: envFor(prefix, stream), healthIntervalMs: 0 })
  workers.push(w)
  return w
}

function names() {
  const id = randomBytes(4).toString('hex')
  const prefix = `wsm_test_${id}`
  const stream = `test:wsm:events:${id}`
  keys.push(`${prefix}:*`, stream)
  return { prefix, stream }
}

const call = async (w: WaWorkerHandle, target: string, method: string, ...args: unknown[]) => {
  const res = await fetch(`${w.url}/internal/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target, method, args }),
  })
  return { status: res.status, body: (await res.json()) as { result?: any; error?: any } }
}
const rpc = async (w: WaWorkerHandle, target: string, method: string, ...args: unknown[]) => {
  const r = await call(w, target, method, ...args)
  if (r.body.error) throw Object.assign(new Error(`${target}.${method}: ${JSON.stringify(r.body.error)}`), r.body.error)
  return r.body.result
}
const fakePost = (w: WaWorkerHandle, path: string, body: unknown = {}) =>
  fetch(`${w.url}/internal/fake/${path}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const fakeGet = async (w: WaWorkerHandle, path: string) =>
  (await (await fetch(`${w.url}/internal/fake/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

const streamEvents = async (stream: string): Promise<WaEvent[]> =>
  ((await redis.xrange(stream, '-', '+')) as [string, string[]][]).map(([, f]) => parseWaEvent(f[1]!))

async function connectedSession(w: WaWorkerHandle): Promise<string> {
  const s = await rpc(w, 'sessions', 'create', { name: `s-${randomBytes(2).toString('hex')}` })
  await rpc(w, 'sessions', 'startQr', s.id)
  await waitFor(() => fakePost(w, `sessions/${s.id}/qr`), (r) => r.status === 200)
  expect((await fakePost(w, `sessions/${s.id}/open`)).status).toBe(200)
  await waitFor(() => rpc(w, 'sessions', 'get', s.id), (v) => v.status === 'WARMING')
  return s.id
}

describe('wa-worker (WA_TRANSPORT=fake)', () => {
  it('AC-01: Bearer obrigatório e lista fechada de métodos', async () => {
    const { prefix, stream } = names()
    const w = await boot(prefix, stream)
    const noAuth = await fetch(`${w.url}/internal/rpc`, { method: 'POST', body: JSON.stringify({ target: 'sessions', method: 'list' }) })
    expect(noAuth.status).toBe(401)
    for (const [target, method] of [['sessions', 'constructor'], ['sessions', '__proto__'], ['messages', 'toString'], ['manager', 'stop']]) {
      const r = await call(w, target!, method!)
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('UNKNOWN_METHOD')
    }
    expect((await call(w, 'sessions', 'list')).status).toBe(200)
  })

  it('AC-02/03/04: sessão → QR → aberta (WARMING) e envio até sent/delivered com eventos no stream', async () => {
    const { prefix, stream } = names()
    const w = await boot(prefix, stream)
    const sessionId = await connectedSession(w)
    // session.connection sai depois do state WARMING (awaits entre os dois no onOpen): esperar os dois.
    const events = await waitFor(
      () => streamEvents(stream),
      (ev) => ev.some((e) => e.type === 'session.state' && e.to === 'WARMING') && ev.some((e) => e.type === 'session.connection'),
    )
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['session.qr', 'session.state', 'session.connection']))

    const phone = '+5511999990501'
    // AC-04: rejeições do pipeline voltam com o mesmo code e HTTP.
    const noActor = await call(w, 'messages', 'enqueue', { sessionId, phone, content: { text: 'x' } })
    expect(noActor.status).toBe(401)
    expect(noActor.body.error).toMatchObject({ name: 'SendRejectedError', code: 'UNAUTHORIZED', status: 401, gate: 'auth' })
    const noConsent = await call(w, 'messages', 'enqueue', { sessionId, phone, content: { text: 'x' }, actor: 'crm:u1' })
    expect(noConsent.status).toBe(403)
    expect(noConsent.body.error).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403, gate: 'contactAllowed' })

    await rpc(w, 'contacts', 'recordConsent', { phone, source: 'inbound' })
    const queued = await rpc(w, 'messages', 'enqueue', { sessionId, phone, content: { text: 'olá' }, actor: 'crm:u1' })
    expect(queued.status).toBe('queued')
    const sent = await waitFor(() => rpc(w, 'messages', 'get', queued.id), (m) => m.status === 'sent')
    expect((await fakePost(w, `sessions/${sessionId}/receipt`, { messageId: sent.transportMessageId, status: 'delivered' })).status).toBe(200)
    await waitFor(() => rpc(w, 'messages', 'get', queued.id), (m) => m.status === 'delivered')
    const statuses = await waitFor(
      () => streamEvents(stream),
      (ev) => ev.some((e) => e.type === 'message.status' && e.message_id === queued.id && e.status === 'delivered'),
    )
    const mine = statuses.filter((e): e is Extract<WaEvent, { type: 'message.status' }> => e.type === 'message.status' && e.message_id === queued.id)
    expect(mine.map((e) => e.status)).toEqual(['queued', 'processing', 'sent', 'delivered'])
    expect(mine.find((e) => e.status === 'sent')?.transport_message_id).toBe(sent.transportMessageId)

    // Recebida → message.inbound; markRead → transporte; clientMessageId → mesma mensagem.
    const received = (await (await fakePost(w, `sessions/${sessionId}/receive`, { from: '5511999990501@s.whatsapp.net', text: 'oi' })).json()) as { id: string }
    await waitFor(() => streamEvents(stream), (ev) => ev.some((e) => e.type === 'message.inbound' && e.message.id === received.id))
    await rpc(w, 'messages', 'markRead', sessionId, '5511999990501@s.whatsapp.net', [received.id])
    expect((await fakeGet(w, `sessions/${sessionId}/state`)).reads).toEqual([{ chatJid: '5511999990501@s.whatsapp.net', ids: [received.id] }])
    const req = { sessionId, phone, content: { text: 'uma vez' }, actor: 'crm:u1', clientMessageId: 'cli-1' }
    const a = await rpc(w, 'messages', 'enqueue', req)
    const b = await rpc(w, 'messages', 'enqueue', req)
    expect(b.id).toBe(a.id)
    expect(a.clientMessageId).toBe('cli-1')
    await waitFor(() => rpc(w, 'messages', 'get', a.id), (m) => m.status === 'sent')
    expect((await fakeGet(w, `sessions/${sessionId}/state`)).sent.filter((m: { content: { text?: string } }) => m.content.text === 'uma vez')).toHaveLength(1)
  })

  it('mídia blob:<sha256> do BlobStore compartilhado é entregue como bytes', async () => {
    const { prefix, stream } = names()
    const w = await boot(prefix, stream)
    const sessionId = await connectedSession(w)
    const info = await new FsBlobStore({ dir: storageDir }).put(Buffer.from('imagem-fake'), 'image/png')
    const phone = '+5511999990502'
    await rpc(w, 'contacts', 'recordConsent', { phone, source: 'manual' })
    const m = await rpc(w, 'messages', 'enqueue', { sessionId, phone, content: { image: { url: `blob:${info.key}` }, caption: 'c' }, actor: 'crm:u1' })
    await waitFor(() => rpc(w, 'messages', 'get', m.id), (v) => v.status === 'sent')
    const sent = (await fakeGet(w, `sessions/${sessionId}/state`)).sent.at(-1)
    expect(sent.content.image.data).toBeDefined()
    expect(Buffer.from(Object.values(sent.content.image.data as Record<string, number>)).toString()).toBe('imagem-fake')
    expect((await rpc(w, 'messages', 'get', m.id)).content).toEqual({ image: { url: `blob:${info.key}` }, caption: 'c' })
  })

  it('AC-05: encerramento gracioso e novo boot entregam as mensagens pendentes uma única vez', async () => {
    const { prefix, stream } = names()
    const w1 = await boot(prefix, stream)
    const sessionId = await connectedSession(w1)
    const phone = '+5511999990503'
    await rpc(w1, 'contacts', 'recordConsent', { phone, source: 'manual' })
    expect((await fakePost(w1, `sessions/${sessionId}/close`, { reason: 'transient' })).status).toBe(200)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await rpc(w1, 'messages', 'enqueue', { sessionId, phone, content: { text: `p${i}` }, actor: 'crm:u1' })).id)
    await new Promise((r) => setTimeout(r, 200))
    for (const id of ids) expect((await rpc(w1, 'messages', 'get', id)).status).toBe('queued')
    const first = (await fakeGet(w1, 'boot')).bootId
    await w1.stop()
    workers.splice(workers.indexOf(w1), 1)

    const w2 = await boot(prefix, stream)
    expect((await fakeGet(w2, 'boot')).bootId).not.toBe(first)
    await waitFor(() => fakePost(w2, `sessions/${sessionId}/open`), (r) => r.status === 200)
    for (const id of ids) await waitFor(() => rpc(w2, 'messages', 'get', id), (m) => m.status === 'sent', 15_000)
    const history = (await (await fetch(`${w2.url}/internal/fake/sessions/${sessionId}/sent-history`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as {
      items: { content: { text: string } }[]
    }
    const texts = history.items.map((h) => h.content.text).filter((t) => /^p\d$/.test(t))
    expect(texts.sort()).toEqual(['p0', 'p1', 'p2'])
  }, 60_000)
})

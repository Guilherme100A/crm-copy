/* eslint-disable @typescript-eslint/no-explicit-any -- estado do FakeTransport lido como dado solto */
// AC-T46-01: a suíte de contrato da `@crm/wa-port` contra o wa-worker REAL (Postgres descartável, Redis real,
// WA_TRANSPORT=fake) usando o gateway RPC. Mais: rejeição do pipeline real (AC-T46-02), repasse de clientMessageId /
// markRead até o transporte e eventos reais do worker chegando pelo subscribe.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, redisConnection } from '@crm/node-kit'
import { SendRejectedError, type WaEvent } from '@crm/wa-port'
import { defineWaGatewayContract } from '@crm/wa-port/contract'
import { startWaWorker, type WaWorkerHandle } from '@crm/wa-worker'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRpcGateway, type RpcWaGateway } from './gateway'
import { createWorkerContractHarness } from './testing'

const TOKEN = `t46-${randomBytes(6).toString('hex')}`
const id = randomBytes(4).toString('hex')
const PREFIX = `wsm_t46_${id}`
const STREAM = `test:t46:wsm:events:${id}`

let tmp: TempDatabase
let redis: Redis
let storageDir: string
let worker: WaWorkerHandle

beforeAll(async () => {
  tmp = await createTempDatabase()
  redis = redisConnection()
  storageDir = mkdtempSync(join(tmpdir(), 'crm-t46-'))
  worker = await startWaWorker({
    env: {
      DATABASE_URL: tmp.url,
      REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379/1',
      CREDENTIALS_KEY: generateCredentialsKey(),
      INTERNAL_TOKEN: TOKEN,
      WA_TRANSPORT: 'fake',
      WA_RPC_PORT: '0',
      WA_RPC_HOST: '127.0.0.1',
      WA_QUEUE_PREFIX: PREFIX,
      WA_EVENTS_STREAM: STREAM,
      STORAGE_DIR: storageDir,
      ANTIBAN_MODE: 'passthrough',
      LOG_LEVEL: 'silent',
    },
    healthIntervalMs: 0,
  })
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  const keys = await redis.keys(`${PREFIX}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.del(STREAM)
  await redis.quit()
  await tmp?.drop()
  rmSync(storageDir, { recursive: true, force: true })
})

const gatewayFor = (): RpcWaGateway => createRpcGateway({ url: worker.url, token: TOKEN, profile: 'crm', redis, stream: STREAM, blockMs: 100, timeoutMs: 15_000 })
const harnessFor = (gateway: RpcWaGateway, holdSends = false) =>
  createWorkerContractHarness({ gateway, url: worker.url, token: TOKEN, fake: worker.fake!, eventTimeoutMs: 5000, ...(holdSends ? { queue: worker.queue } : {}) })

// Envios seguram na fila da sessão: o contrato espera `queued` e cancela em seguida.
defineWaGatewayContract('rpc → wa-worker (WA_TRANSPORT=fake)', () => harnessFor(gatewayFor(), true))

describe('gateway RPC sobre o wa-worker real', () => {
  const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  async function connected(gateway: RpcWaGateway): Promise<string> {
    const s = await gateway.sessions.create({ name: `t46-${randomBytes(2).toString('hex')}` })
    await harnessFor(gateway).connect!(s.id)
    return s.id
  }

  it('AC-T46-02: rejeição do pipeline real chega como SendRejectedError com code/status/gate', async () => {
    const gateway = gatewayFor()
    try {
      const sessionId = await connected(gateway)
      const p = phone()
      await gateway.recordConsent({ phone: p, source: 'manual', actor: 'crm:t46' })
      await gateway.optOut({ phone: p, actor: 'crm:t46' })
      const err = await gateway.send({ sessionId, phone: p, content: { text: 'x' }, actor: 'crm:t46' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SendRejectedError)
      expect(err).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403, gate: 'contactAllowed' })
    } finally {
      await gateway.close()
    }
  })

  it('send com clientMessageId/quoted/viewOnce chega ao transporte uma vez; markRead vira recibo no transporte', async () => {
    const gateway = gatewayFor()
    try {
      const sessionId = await connected(gateway)
      const p = phone()
      await gateway.recordConsent({ phone: p, source: 'manual', actor: 'crm:t46' })
      const req = { sessionId, phone: p, content: { text: 'idempotente' }, actor: 'crm:t46', clientMessageId: `cm-${id}`, quoted: 'wamid.ORIG', viewOnce: false }
      const first = await gateway.send(req)
      const again = await gateway.send(req)
      expect(again.id).toBe(first.id)
      expect(first.clientMessageId).toBe(`cm-${id}`)
      const state = async () => (await (await fetch(`${worker.url}/internal/fake/sessions/${sessionId}/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any
      const deadline = Date.now() + 10_000
      while ((await state()).sent.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect((await state()).sent.filter((m: any) => m.content?.text === 'idempotente')).toHaveLength(1)

      const chat = `${p.slice(1)}@s.whatsapp.net`
      await gateway.markRead!(sessionId, chat, ['IN-1', 'IN-2'])
      expect((await state()).reads).toEqual([{ chatJid: chat, ids: ['IN-1', 'IN-2'] }])
    } finally {
      await gateway.close()
    }
  })

  it('subscribe recebe os eventos que o próprio worker publica (session.state, message.inbound)', async () => {
    const gateway = gatewayFor()
    const events: WaEvent[] = []
    const off = gateway.subscribe((e) => {
      events.push(e)
    })
    try {
      const sessionId = await connected(gateway)
      worker.fake!.require(sessionId).receive({ from: '5511988887777@s.whatsapp.net', text: 'oi do worker' })
      const deadline = Date.now() + 10_000
      while (!events.some((e) => e.type === 'message.inbound' && e.session_id === sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30))
      expect(events.some((e) => e.type === 'session.state' && e.session_id === sessionId)).toBe(true)
      expect(events.find((e) => e.type === 'message.inbound' && e.session_id === sessionId)).toMatchObject({ message: { text: 'oi do worker', from_me: false } })
    } finally {
      off()
      await gateway.close()
    }
  })

  it('profile.get funciona; setName responde NOT_SUPPORTED (501) como no transporte atual', async () => {
    const gateway = gatewayFor()
    try {
      const sessionId = await connected(gateway)
      expect(await gateway.profile!.get(sessionId)).toEqual({ name: null, status: null, pictureUrl: null })
      await expect(gateway.profile!.setName!(sessionId, 'Loja')).rejects.toMatchObject({ code: 'NOT_SUPPORTED', status: 501 })
      expect(await gateway.refreshCapabilities()).toMatchObject({ businessProfile: false })
    } finally {
      await gateway.close()
    }
  })
})

// Montagem de produção (WA_GATEWAY=rpc) com o wa-worker de verdade (WA_TRANSPORT=fake, processo filho):
// - API do CRM (createApp) com o WaGateway criado por createWaGatewayFromEnv;
// - worker do CRM com configureWorkerProduction({ db, gateway }) + startWorker consumindo o stream do wa-worker.
// Prova: mensagem recebida no wa-worker vira chat pelo worker do CRM; envio pela API chega ao wa-worker.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/exec'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'
import { REDIS_URL, fake, newWorkerEnv, phone, startWorker, waitFor, type Worker, type WorkerEnv } from '../helpers/wa-worker'
import { harnessFor, rpcMod } from './support'

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

let wenv: WorkerEnv
let w: Worker
let tmp: any
let db: any
let redis: any
let gateway: any
let built: any
let app: any
let workerHandle: any
let storageDir: string

beforeAll(async () => {
  wenv = newWorkerEnv()
  w = await startWorker(wenv)

  const { createDb }: any = await import('@crm/db')
  const { createTempDatabase }: any = await import('@crm/db/testing')
  const kit: any = await import('@crm/node-kit')
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url)
  redis = kit.redisConnection({ url: REDIS_URL })
  redis.on?.('error', () => {})
  storageDir = mkdtempSync(join(tmpdir(), 'crm-t46-api-'))

  const { createWaGatewayFromEnv } = await rpcMod()
  built = createWaGatewayFromEnv(
    { WA_GATEWAY: 'rpc', WA_RPC_URL: w.url, INTERNAL_TOKEN: wenv.token, WA_RPC_PROFILE: 'crm', WA_EVENTS_STREAM: wenv.stream, REDIS_URL },
    { redis: REDIS_URL },
  )
  gateway = built.gateway

  const api: any = await import('@crm/api')
  app = api.createApp({
    db,
    redis,
    mailer: new kit.MemoryMailer(),
    blobStore: new kit.FsBlobStore(storageDir),
    waGateway: gateway,
    appName: 'ProdutoTesteT46',
    webPublicUrl: 'http://web.t46.test',
    trustProxy: true,
  })

  const wk: any = await import('@crm/worker')
  const configure =
    wk.configureWorkerProduction ??
    (await import(pathToFileURL(resolve(ROOT, 'apps/worker/src/boot/production.ts')).href)).configureWorkerProduction
  const out = await configure({ db, waGateway: gateway })
  const registry = out?.registry ?? wk.registry
  workerHandle = await wk.startWorker({
    registry,
    db,
    redis,
    prefix: `t46${randomBytes(3).toString('hex')}`,
    consumer: { stream: wenv.stream, group: `t46-${randomBytes(3).toString('hex')}`, blockMs: 100 },
    handleSignals: false,
    exitProcess: false,
  })
}, 240_000)

afterAll(async () => {
  await workerHandle?.stop?.().catch(() => {})
  await built?.close?.().catch(() => {})
  await w?.shutdown().catch(() => w?.kill())
  await Promise.resolve(redis?.quit?.()).catch(() => {})
  await db?.$client?.end?.().catch(() => {})
  await tmp?.drop?.().catch(() => {})
  if (storageDir) rmSync(storageDir, { recursive: true, force: true })
  wenv?.cleanup()
}, 90_000)

async function owner() {
  const c = createClient({ fetcher: (path, init) => app.request(path, init) })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t46')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t46')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, companyId }
}

const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows

describe('T46 — montagem de produção WA_GATEWAY=rpc', () => {
  it('T46 createWaGatewayFromEnv(WA_GATEWAY=rpc) monta o gateway RPC (não o fake)', async () => {
    expect(built.mode).toBe('rpc')
    expect(gateway).toBeTruthy()
    expect(gateway.constructor?.name).not.toBe('FakeWaGateway')
    expect(gateway.gatewayProfile).toBeTruthy()
    expect(Array.isArray(await gateway.sessions.list())).toBe(true)
  })

  it('T46 mensagem recebida no wa-worker vira chat pelo worker do CRM, e o envio pela API chega ao wa-worker', async () => {
    const o = await owner()
    // conexão criada pela API: a sessão nasce no wa-worker real
    const created = await o.c.post('/api/connections', { name: 'Produção T46' })
    expect(created.status, created.text).toBe(201)
    const sessionId = created.body.connection.session_id
    const h = await harnessFor(w, wenv)
    await h.connect(sessionId)
    await h.gateway.close?.()

    // lado WhatsApp: chega uma mensagem
    const from = phone()
    const text = `olá pelo wa-worker ${randomBytes(2).toString('hex')}`
    const rec = await fake(w, wenv, `sessions/${sessionId}/receive`, { from: `${from.slice(1)}@s.whatsapp.net`, text })
    expect(rec.status, JSON.stringify(rec.body)).toBe(200)

    const chat = await waitFor(async () => {
      const rows = await q(
        `SELECT ch.id FROM crm.chats ch JOIN crm.messages m ON m.chat_id = ch.id WHERE ch.company_id = $1 AND m.body = $2 LIMIT 1`,
        [o.companyId, text],
      ).catch(() => [])
      return rows[0]
    }, 30_000, 'chat criado pelo worker do CRM')
    expect(chat.id).toBeTruthy()

    // resposta pela API → gateway RPC → wa-worker → transporte fake
    const reply = `resposta pela API ${randomBytes(2).toString('hex')}`
    const sent = await o.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: reply })
    expect(sent.status, sent.text).toBeLessThan(300)
    await waitFor(
      async () => JSON.stringify((await fake(w, wenv, `sessions/${sessionId}/state`, undefined, 'GET')).body.sent ?? []).includes(reply),
      30_000,
      'mensagem enviada no transporte do wa-worker',
    )
  })
})

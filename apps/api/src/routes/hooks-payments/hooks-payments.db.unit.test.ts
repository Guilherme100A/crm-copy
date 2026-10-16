/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// POST /api/hooks/payments/:gateway/:integrationId (AC-T111-04) contra o FakeXPag: 202 + 1 job por evento; integração
// inexistente/de outro gateway → 404; token errado/ausente → 401 sem enfileirar; o log de acesso não leva o token.
import { FakeXPag, PaymentIntegrationsService, type PaymentWebhookJobData } from '@crm/core'
import { companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const CLIENT_ID = 'cli-hooks'
const SECRET = 'sk_xpag_HOOKSSECRET_wxyz'
const fake = new FakeXPag({ clientId: CLIENT_ID, clientSecret: SECRET })
const cipher = createCipher({ key: generateCredentialsKey() })
const env = () => ({ XPAG_API_URL: fake.url, API_PUBLIC_URL: 'https://api.crm.test' })
const jobs: { data: PaymentWebhookJobData; jobId: string }[] = []
const logLines: string[] = []

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  await fake.start()
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    logger: createLogger({ level: 'info', destination: { write: (s: string) => void logLines.push(s) } as never }),
    credentialsCipher: cipher,
    paymentsEnv: env(),
    paymentWebhookEnqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
  })
}, 120_000)

afterAll(async () => {
  await fake.stop()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

/** Integração XPag + uma cobrança no fake; devolve o webhook que a XPag mandaria. */
async function charged() {
  const [co] = await db.insert(companies).values({ name: 'C', slug: `c-t111-${randomBytes(4).toString('hex')}` }).returning({ id: companies.id })
  const svc = new PaymentIntegrationsService({ db, cipher, env: env() })
  const integration = await svc.create(co!.id, { label: 'XPag', gateway: 'xpag', client_id: CLIENT_ID, client_secret: SECRET })
  const charge = await (await svc.gatewayFor(co!.id, integration.id)).createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 1000 })
  const hook = fake.webhookFor(charge.transaction_id)
  const url = new URL(hook.url!)
  return { companyId: co!.id, integration, charge, url, rawBody: hook.rawBody, token: url.searchParams.get('token')! }
}
const post = (path: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => app.request(path, { method: 'POST', headers, body })

describe('POST /api/hooks/payments/:gateway/:integrationId', () => {
  it('token certo na query → 202 e 1 job por evento (sem sessão nem CSRF); o log de acesso não contém o token', async () => {
    const w = await charged()
    expect(w.url.pathname).toBe(`/api/hooks/payments/xpag/${w.integration.id}`)
    logLines.length = 0
    jobs.length = 0
    const res = await post(`${w.url.pathname}${w.url.search}`, w.rawBody)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: 1 })
    expect(jobs).toEqual([
      {
        data: { companyId: w.companyId, integrationId: w.integration.id, gateway: 'xpag', event: expect.objectContaining({ type: 'payment.approved', transaction_id: w.charge.transaction_id, amount_cents: 1000 }) },
        jobId: `xpag-${w.charge.transaction_id}-payment.approved`.replace(/[^\w.-]/g, '_'),
      },
    ])
    const access = logLines.join('\n')
    expect(access).toContain(w.url.pathname)
    expect(access).not.toContain(w.token)
  })

  it('AC-T111-04: integração inexistente ou de outro gateway → 404; token errado ou ausente → 401; nada enfileirado', async () => {
    const w = await charged()
    jobs.length = 0
    expect((await post(`/api/hooks/payments/xpag/${'00000000-0000-4000-8000-000000000000'}?token=${w.token}`, w.rawBody)).status).toBe(404)
    expect((await post(`/api/hooks/payments/zenith/${w.integration.id}?token=${w.token}`, w.rawBody)).status).toBe(404)
    expect((await post(`/api/hooks/payments/xpag/nao-uuid?token=${w.token}`, w.rawBody)).status).toBe(404)
    const bad = await post(`${w.url.pathname}?token=errado`, w.rawBody)
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as any).error.code).toBe('UNAUTHORIZED')
    expect((await post(w.url.pathname, w.rawBody)).status).toBe(401)
    expect(jobs).toHaveLength(0)
    expect(logLines.join('\n')).not.toContain(w.token)
  })

  it('JSON inválido com token certo → 400; corpo acima de 256 KB → 413', async () => {
    const w = await charged()
    expect((await post(`${w.url.pathname}${w.url.search}`, '{nao json')).status).toBe(400)
    expect((await post(`${w.url.pathname}${w.url.search}`, `{"x":"${'a'.repeat(300 * 1024)}"}`)).status).toBe(413)
  })
})

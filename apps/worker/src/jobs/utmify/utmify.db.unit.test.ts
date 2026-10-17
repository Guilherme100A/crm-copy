// Job `utmify` (T113) com BullMQ e Redis reais (prefixo único por arquivo), Postgres descartável e FakeUtmify local.
// O backoff entre chamadas à UTMify é injetado curto (`retryBaseMs`), sem sleep real nos asserts.
import { randomBytes } from 'node:crypto'
import {
  FakeUtmify,
  SaleNotVisibleError,
  SalesService,
  UtmifyIntegrationsService,
  utmifyJobId,
  UtmifyRetryError,
  type UtmifyJobData,
} from '@crm/core'
import { companies, createDb, saleUtmifyEvents, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker, type WorkerApp } from '../../boot/start'
import { createRegistry } from '../../registry'
import { registerUtmifyJob, UTMIFY_QUEUE, UTMIFY_QUEUE_OPTS, UTMIFY_RETRY_BASE_MS, utmifyBackoff } from './index'

let temp: TempDatabase
let db: Database
let worker: WorkerApp
const cipher = createCipher({ key: generateCredentialsKey() })
const TOKEN = 'utm_WORKER_TOKEN_55bb'
const fake = new FakeUtmify([TOKEN])
const events: { type: string; data: Record<string, unknown> }[] = []
const rnd = () => randomBytes(4).toString('hex')
const prefix = `crm-t113-${rnd()}`

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  await fake.start()
  const registry = registerUtmifyJob(createRegistry(), {
    db,
    cipher,
    env: { UTMIFY_API_URL: fake.url },
    publisher: {
      publish: async (_co: string, type: string, data: unknown) => (
        events.push({ type, data: data as Record<string, unknown> }),
        'id'
      ),
    } as never,
    retryBaseMs: 20,
    notVisibleBaseMs: 20,
  })
  worker = await startWorker({
    registry,
    prefix,
    handleSignals: false,
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  })
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await fake.stop()
  await db?.$client.end()
  await temp?.drop()
})

async function saleWithIntegration(token: string | null) {
  const [co] = await db
    .insert(companies)
    .values({ name: 'W', slug: `w-${rnd()}` })
    .returning({ id: companies.id })
  const integ = await new UtmifyIntegrationsService({ db, cipher }).create(co!.id, {
    company_name: 'Loja W',
    integration_token: token,
  })
  const { sale } = await new SalesService({ db }).record({
    companyId: co!.id,
    source: 'flow',
    externalId: `run-${rnd()}`,
    amountCents: 5_000,
    utmifyIntegrationId: integ.id,
  })
  return { companyId: co!.id, saleId: sale.id }
}

const enqueue = async (data: UtmifyJobData) =>
  worker.queues.get(UTMIFY_QUEUE)!.add(UTMIFY_QUEUE, data, { jobId: utmifyJobId(data.saleId, data.status) })

async function settled(saleId: string, status: 'approved' | 'refunded' = 'approved', timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const [row] = await db
      .select()
      .from(saleUtmifyEvents)
      .where(and(eq(saleUtmifyEvents.saleId, saleId), eq(saleUtmifyEvents.saleStatus, status)))
    if (row && row.status !== 'pending') return row
    if (Date.now() > until) throw new Error(`envio de ${saleId} não terminou (${row?.status ?? 'sem linha'})`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('fila utmify', () => {
  it('AC-T113-01: o job envia ao fake e termina succeeded com sale.updated', async () => {
    const s = await saleWithIntegration(TOKEN)
    await enqueue({ ...s, status: 'approved' })
    expect(await settled(s.saleId)).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null })
    expect(fake.ordersOf(s.saleId).map((o) => o.status)).toEqual(['paid'])
    const mine = events.filter((e) => e.data.sale_id === s.saleId).map((e) => [e.type, e.data.utmify_status])
    expect(mine).toEqual([
      ['sale.updated', 'pending'],
      ['sale.updated', 'succeeded'],
    ])
  })

  it('AC-T113-02: reembolso envia refunded; reenfileirar o mesmo evento não chama a UTMify de novo', async () => {
    const s = await saleWithIntegration(TOKEN)
    await enqueue({ ...s, status: 'approved' })
    await settled(s.saleId)
    await new SalesService({ db }).update(s.companyId, s.saleId, { status: 'refunded' })
    const first = await enqueue({ ...s, status: 'refunded' })
    expect(await settled(s.saleId, 'refunded')).toMatchObject({ status: 'succeeded', attempts: 1 })
    await expect
      .poll(async () => await (await worker.queues.get(UTMIFY_QUEUE)!.getJob(first.id!))?.getState())
      .toBe('completed')
    // jobId igual: o BullMQ ignora enquanto o job existe; e, se ele já foi removido, a linha `succeeded` barra o envio.
    await enqueue({ ...s, status: 'refunded' })
    await worker.queues
      .get(UTMIFY_QUEUE)!
      .add(UTMIFY_QUEUE, { ...s, status: 'refunded' }, { jobId: `${utmifyJobId(s.saleId, 'refunded')}-again` })
    await expect
      .poll(
        async () =>
          await (
            await worker.queues.get(UTMIFY_QUEUE)!.getJob(`${utmifyJobId(s.saleId, 'refunded')}-again`)
          )?.getState(),
      )
      .toBe('completed')
    expect(fake.ordersOf(s.saleId).map((o) => o.status)).toEqual(['paid', 'refunded'])
  })

  it('AC-T113-03: falha do fake → 3 chamadas com backoff e depois failed com a mensagem (job concluído)', async () => {
    const s = await saleWithIntegration(TOKEN)
    const calls = () => fake.requests.filter((r) => r.body?.orderId === s.saleId).length
    fake.failAlways(503, { message: 'instável' })
    try {
      const job = await enqueue({ ...s, status: 'approved' })
      expect(await settled(s.saleId)).toMatchObject({
        status: 'failed',
        attempts: 3,
        lastError: 'Falha na UTMify: instável',
      })
      expect(calls()).toBe(3)
      const done = await worker.queues.get(UTMIFY_QUEUE)!.getJob(job.id!)
      await expect.poll(async () => await done!.getState()).toBe('completed')
    } finally {
      fake.reset()
    }
    const last = events.filter((e) => e.data.sale_id === s.saleId).at(-1)!
    expect(last.data).toMatchObject({ utmify_status: 'failed', utmify_last_error: 'Falha na UTMify: instável' })
    expect(JSON.stringify(events)).not.toContain(TOKEN)
  })

  it('integração sem token → failed "não configurada" sem chamar o fake', async () => {
    const s = await saleWithIntegration(null)
    const before = fake.requests.length
    await enqueue({ ...s, status: 'approved' })
    expect(await settled(s.saleId)).toMatchObject({
      status: 'failed',
      lastError: 'Integração UTMify não configurada',
      attempts: 0,
    })
    expect(fake.requests.length).toBe(before)
  })
})

describe('backoff', () => {
  it('falha da UTMify: base × 2^(chamada-1); venda não visível usa a base curta; opções da fila', () => {
    expect(utmifyBackoff(1, new UtmifyRetryError(1, 'x'))).toBe(UTMIFY_RETRY_BASE_MS)
    expect(utmifyBackoff(5, new UtmifyRetryError(2, 'x'))).toBe(2 * UTMIFY_RETRY_BASE_MS)
    expect(utmifyBackoff(1, new SaleNotVisibleError('s'))).toBe(2_000)
    expect(utmifyBackoff(3, new SaleNotVisibleError('s'), { notVisibleBaseMs: 10 })).toBe(40)
    expect(UTMIFY_QUEUE_OPTS.defaultJobOptions).toMatchObject({ attempts: 10, backoff: { type: 'utmify' } })
  })
})

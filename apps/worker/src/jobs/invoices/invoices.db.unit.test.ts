// Job `invoices` (T112) com BullMQ e Redis reais (prefixo único por arquivo), Postgres descartável e FakeNotasy local.
// O backoff entre chamadas ao emissor é injetado curto (`retryBaseMs`), sem sleep real nos asserts.
import { randomBytes } from 'node:crypto'
import {
  FakeNotasy,
  InvoiceIntegrationsService,
  invoiceJobId,
  InvoiceRetryError,
  SalesService,
  SaleNotVisibleError,
  type InvoiceJobData,
} from '@crm/core'
import { companies, createDb, saleInvoices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker, type WorkerApp } from '../../boot/start'
import { createRegistry } from '../../registry'
import {
  INVOICES_QUEUE,
  INVOICES_QUEUE_OPTS,
  INVOICES_RETRY_BASE_MS,
  invoicesBackoff,
  registerInvoicesJob,
} from './index'

let temp: TempDatabase
let db: Database
let worker: WorkerApp
const cipher = createCipher({ key: generateCredentialsKey() })
const TOKEN = 'ntsy_WORKER_TOKEN_77aa'
const fake = new FakeNotasy([TOKEN])
const events: { type: string; data: Record<string, unknown> }[] = []
const rnd = () => randomBytes(4).toString('hex')
const prefix = `crm-t112-${rnd()}`

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  await fake.start()
  const registry = registerInvoicesJob(createRegistry(), {
    db,
    cipher,
    env: { NOTASY_API_URL: fake.url },
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

async function saleWithIssuer(token: string | null) {
  const [co] = await db
    .insert(companies)
    .values({ name: 'W', slug: `w-${rnd()}` })
    .returning({ id: companies.id })
  const iss = await new InvoiceIntegrationsService({ db, cipher }).create(co!.id, {
    company_name: 'Loja W',
    integration_token: token,
  })
  const { sale } = await new SalesService({ db }).record({
    companyId: co!.id,
    source: 'flow',
    externalId: `run-${rnd()}`,
    amountCents: 5_000,
    noteIssuerId: iss.id,
  })
  return { companyId: co!.id, saleId: sale.id }
}

const enqueue = async (data: InvoiceJobData) =>
  worker.queues.get(INVOICES_QUEUE)!.add(INVOICES_QUEUE, data, { jobId: invoiceJobId(data.saleId, data.generation) })

async function settled(saleId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const [row] = await db.select().from(saleInvoices).where(eq(saleInvoices.saleId, saleId))
    if (row && row.status !== 'pending') return row
    if (Date.now() > until) throw new Error(`emissão de ${saleId} não terminou (${row?.status ?? 'sem linha'})`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('fila invoices', () => {
  it('AC-T112-01: o job emite pelo fake e termina succeeded com sale.updated', async () => {
    const s = await saleWithIssuer(TOKEN)
    await enqueue({ ...s, generation: 1 })
    const row = await settled(s.saleId)
    expect(row).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null })
    expect(fake.sales.some((x) => x.body.id === s.saleId)).toBe(true)
    const mine = events.filter((e) => e.data.sale_id === s.saleId).map((e) => [e.type, e.data.invoice_emit_status])
    expect(mine).toEqual([
      ['sale.updated', 'pending'],
      ['sale.updated', 'succeeded'],
    ])
  })

  it('AC-T112-03: falha do fake → 3 chamadas com backoff e depois failed com a mensagem (job concluído)', async () => {
    const s = await saleWithIssuer(TOKEN)
    const calls = () => fake.requests.filter((r) => r.body?.id === s.saleId).length
    fake.failAlways(500, { success: false, error: { message: 'instável' } })
    try {
      const job = await enqueue({ ...s, generation: 1 })
      const row = await settled(s.saleId)
      expect(row).toMatchObject({ status: 'failed', attempts: 3, lastError: 'Falha na Notasy: instável' })
      expect(calls()).toBe(3)
      const done = await worker.queues.get(INVOICES_QUEUE)!.getJob(job.id!)
      await expect.poll(async () => await done!.getState()).toBe('completed')
    } finally {
      fake.reset()
    }
  })

  it('AC-T112-02: emissor sem token → failed "Emissor não configurado" sem chamar o fake', async () => {
    const s = await saleWithIssuer(null)
    const before = fake.requests.length
    await enqueue({ ...s, generation: 1 })
    expect(await settled(s.saleId)).toMatchObject({
      status: 'failed',
      lastError: 'Emissor não configurado',
      attempts: 0,
    })
    expect(fake.requests.length).toBe(before)
  })
})

describe('backoff', () => {
  it('falha do emissor: base × 2^(tentativa-1); venda não visível usa a base curta; opções da fila', () => {
    expect(invoicesBackoff(1, new InvoiceRetryError(1, 'x'))).toBe(INVOICES_RETRY_BASE_MS)
    expect(invoicesBackoff(5, new InvoiceRetryError(2, 'x'))).toBe(2 * INVOICES_RETRY_BASE_MS)
    expect(invoicesBackoff(1, new SaleNotVisibleError('s'))).toBe(2_000)
    expect(invoicesBackoff(3, new SaleNotVisibleError('s'), { notVisibleBaseMs: 10 })).toBe(40)
    expect(INVOICES_QUEUE_OPTS.defaultJobOptions).toMatchObject({ attempts: 10, backoff: { type: 'invoices' } })
  })
})

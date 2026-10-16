// T126: o job `meta-capi` que chega antes do commit de quem gravou a venda não conclui sem enviar.
import { randomBytes } from 'node:crypto'
import { companies, contacts, createDb, pixelConfigs, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SalesService } from '../sales/service'
import { capiSalePublisher, isSaleNotVisibleError, saleEventId, sendSaleToPixels, SaleNotVisibleError, type MetaCapiSaleJobData } from './sales'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function world() {
  const slug = `capi-${randomBytes(4).toString('hex')}`
  const [co] = await db.insert(companies).values({ name: 'Loja', slug }).returning()
  const [ct] = await db.insert(contacts).values({ companyId: co!.id, name: 'Rui', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
  await db.insert(pixelConfigs).values({ companyId: co!.id, name: 'Pixel', pixelId: '123', accessTokenEnc: 'x', autoSendSales: true })
  const sent: string[] = []
  const capi = { userFromContact: async () => ({}) as never, send: async (i: { eventId: string }) => (sent.push(i.eventId), { status: 'sent' }) as never }
  return { companyId: co!.id, contactId: ct!.id, sent, capi }
}

describe('sendSaleToPixels', () => {
  it('venda gravada numa transação ainda aberta: o job lança SaleNotVisibleError (retentável); depois do commit, 1 Purchase', async () => {
    const w = await world()
    let job: MetaCapiSaleJobData | undefined
    const outcome: unknown[] = []
    // o "worker" pega o job assim que ele é enfileirado, antes do commit (como o nó approved_sale dentro do passo)
    const publisher = capiSalePublisher(
      { publish: async () => 'id' },
      {
        enqueue: async (data) => {
          job = data
          outcome.push(await sendSaleToPixels({ db, capi: w.capi }, data).catch((err: unknown) => err))
        },
      },
    )
    await db.transaction(async (tx) => {
      await new SalesService({ db: tx as never, publisher: publisher as never }).record({ companyId: w.companyId, source: 'flow', externalId: 'run-1-V', amountCents: 25000, currency: 'BRL', contactId: w.contactId, status: 'approved' })
    })
    expect(outcome).toHaveLength(1)
    expect(outcome[0]).toBeInstanceOf(SaleNotVisibleError)
    expect(isSaleNotVisibleError(outcome[0])).toBe(true)
    expect((outcome[0] as SaleNotVisibleError).retryable).toBe(true)
    expect(w.sent).toEqual([])

    // a nova tentativa do job, depois do commit
    const out = await sendSaleToPixels({ db, capi: w.capi }, job!)
    expect(out).toHaveLength(1)
    expect(w.sent).toEqual([saleEventId(job!.saleId)])
  })

  it('venda que nunca aparece (rollback) continua lançando: o job termina failed nas tentativas', async () => {
    const w = await world()
    const data = { companyId: w.companyId, saleId: '00000000-0000-4000-8000-000000000126' }
    await expect(sendSaleToPixels({ db, capi: w.capi }, data)).rejects.toBeInstanceOf(SaleNotVisibleError)
    await expect(sendSaleToPixels({ db, capi: w.capi }, data)).rejects.toThrow(/ainda não visível/)
    expect(w.sent).toEqual([])
  })

  it('venda visível e não aprovada: nada a enviar, sem erro', async () => {
    const w = await world()
    const { sale } = await new SalesService({ db }).record({ companyId: w.companyId, source: 'flow', externalId: 'run-2-V', amountCents: 1000, currency: 'BRL', contactId: w.contactId, status: 'pending' })
    expect(await sendSaleToPixels({ db, capi: w.capi }, { companyId: w.companyId, saleId: sale.id })).toEqual([])
    expect(w.sent).toEqual([])
  })
})

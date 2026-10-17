// Revisão 3: processador `meta-capi` com os três tipos de job (venda, `ad_lead`, `event`) contra o FakeMetaGraph e
// Postgres real; ouvinte do `crm.inbound` que enfileira o Lead automático de anúncio. Nenhuma chamada à Meta real.
import { randomBytes } from 'node:crypto'
import { adLeadEventId, PixelConfigService, type CrmInboundEvent, type MetaCapiJobData } from '@crm/core'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { capiEventLog, companies, contacts, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adLeadInboundListener, createMetaCapiProcessor } from './index'

let tmp: TempDatabase
let db: Database
const fake = new FakeMetaGraph()

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await tmp?.drop()
})

async function world() {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `W${tag}`, slug: `w-rev3-${tag}` }).returning()
  const pixelId = String(300000000000000 + Math.floor(Math.random() * 1e9))
  const token = `EAAB${randomBytes(12).toString('hex')}`
  fake.addPixel(pixelId, token)
  const pixel = await new PixelConfigService({ db }).create(c!.id, { name: 'Pixel', pixel_id: pixelId, access_token: token, auto_lead_on_ad: true })
  const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` }).returning()
  return { companyId: c!.id, pixel, pixelId, contact: contact! }
}

const processor = () => createMetaCapiProcessor({ deps: () => ({ db, graphUrl: fake.url, testEventCode: null }) })
const run = (data: MetaCapiJobData) => processor()({ data } as never)

describe('job meta-capi (revisão 3)', () => {
  it('ad_lead: manda Lead uma vez por contato', async () => {
    const w = await world()
    const data = { kind: 'ad_lead' as const, companyId: w.companyId, contactId: w.contact.id }
    expect(await run(data)).toEqual([{ pixelConfigId: w.pixel.id, result: expect.objectContaining({ status: 'sent' }) }])
    expect((await run(data))[0]!.result.status).toBe('duplicate')
    expect(fake.capiEventsFor(w.pixelId).map((e) => e.event.event_id)).toEqual([adLeadEventId(w.contact.id)])
  })

  it('event incerto (5xx): o job lança para o BullMQ retentar; a retentativa manda o mesmo event_id uma vez', async () => {
    const w = await world()
    const data = { kind: 'event' as const, companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead' as const, eventId: 'flow-run-1', contactId: w.contact.id, source: 'flow' as const }
    fake.failNext(503, { message: 'unavailable', code: 2 })
    await expect(run(data)).rejects.toThrow(/uncertain/)
    const [log] = await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, w.pixel.id))
    expect(log).toMatchObject({ status: 'uncertain', eventId: 'flow-run-1' })
    expect((await run(data))[0]!.result.status).toBe('sent')
    expect((await run(data))[0]!.result.status).toBe('duplicate')
    expect(fake.capiEventsFor(w.pixelId).filter((e) => e.event.event_id === 'flow-run-1')).toHaveLength(1)
  })

  it('ouvinte do crm.inbound: só mensagens de anúncio enfileiram o Lead, com jobId por contato', async () => {
    const queued: { data: MetaCapiJobData; jobId: string }[] = []
    const listener = adLeadInboundListener(async (data, opts) => void queued.push({ data, jobId: opts.jobId }))
    const base = { company_id: 'c1', connection_id: 'x', session_id: 's', chat_id: 'ch', contact_id: 'k1', message_id: 'm', wa_message_id: 'w', type: 'text', text: 'oi', from_me: false, chat_created: true, chat_reopened: false } satisfies CrmInboundEvent
    await listener(base)
    await listener({ ...base, ad_source: 'ctwa' })
    expect(queued).toEqual([{ data: expect.objectContaining({ kind: 'ad_lead', companyId: 'c1', contactId: 'k1', via: 'ctwa' }), jobId: 'capi-ad-lead-k1' }])
  })
})

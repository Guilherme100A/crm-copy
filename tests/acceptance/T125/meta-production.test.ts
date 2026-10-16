// AC-T125-01..03 com o sistema montado como produção (padrão da T120) + FakeMetaGraph (ver setup.ts).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectMeta, salesPixel, seedMetaAccount, sleep, startSystem, tenant, waitFor, type System } from './setup'

let sys: System

beforeAll(async () => {
  sys = await startSystem()
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

const tag = () => randomBytes(3).toString('hex')

async function newContact(t: any): Promise<string> {
  const r = await t.c.post('/api/contacts', { name: `Cliente ${tag()}`, phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` })
  if (r.status !== 201) throw new Error(`contato: ${r.status} ${r.text}`)
  return (r.body.contact ?? r.body).id
}

describe('T125 — bundle da Meta pelo worker de produção', () => {
  it('AC-T125-01 GET /api/meta/structure-bundle?async=1 é processado pelo job meta-sync do worker montado e fica ready', async () => {
    const t = await tenant(sys)
    const [acc] = await connectMeta(sys, t, 1)
    const ids = seedMetaAccount(sys, acc!)
    const url = `/api/meta/structure-bundle?${new URLSearchParams({ level: 'campaign', status_filter: 'all', date_preset: '7d', ad_account_ids: acc!.localId, async: '1' })}`
    const first = await t.c.get(url)
    expect(first.status, first.text).toBe(202)
    expect(['loading', 'refreshing', 'partial']).toContain(first.body.status)
    const ready = await waitFor(async () => {
      const r = await t.c.get(url)
      return r.status === 200 && r.body.status === 'ready' ? r.body : undefined
    }, 60_000, 'bundle ready processado pelo worker')
    expect(ready.campaign.map((c: any) => c.id)).toContain(ids.campaign)
    expect(ready.errors ?? []).toEqual([])
    // quem processou foi o worker (a API só enfileira): houve chamadas aos insights da conta no fake
    expect(sys.fakeMeta.requests.some((r: any) => String(r.endpoint ?? r.path).includes(`/${acc!.fb}/`))).toBe(true)
  })
})

describe('T125 — vendas ao Pixel', () => {
  it('AC-T125-02 venda aprovada pela API gera exatamente 1 Purchase no pixel com auto_send_sales, event_id sale-<id>', async () => {
    const t = await tenant(sys)
    const px = await salesPixel(sys, t)
    const contactId = await newContact(t)
    const r = await t.c.post('/api/sales', { amount_cents: 19_990, currency: 'BRL', contact_id: contactId, external_id: `ext-${tag()}`, status: 'approved' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.created).toBe(true)
    const saleId = r.body.sale.id
    const ev = await waitFor(() => sys.fakeMeta.capiEventsFor(px.pixelId)[0], 45_000, 'Purchase no FakeMetaGraph')
    expect(ev.event.event_name).toBe('Purchase')
    expect(ev.event.event_id).toBe(`sale-${saleId}`)
    expect(ev.event.action_source).toBe('system_generated')
    expect(Number(ev.event.custom_data.value)).toBeCloseTo(199.9, 2)
    expect(ev.event.custom_data.currency).toBe('BRL')
    await sleep(3000)
    expect(sys.fakeMeta.capiEventsFor(px.pixelId), 'mais de um evento para a mesma venda').toHaveLength(1)
  })

  it('AC-T125-02 pixel sem auto_send_sales não recebe a venda', async () => {
    const t = await tenant(sys)
    const auto = await salesPixel(sys, t)
    const pixelId = `${Date.now()}`.slice(-13)
    const manual = await t.c.post('/api/meta/pixels', { name: 'Manual', pixel_id: pixelId, access_token: `EAAB${tag()}${tag()}${tag()}x`, auto_send_sales: false })
    expect(manual.status).toBe(201)
    sys.fakeMeta.addPixel(pixelId, 'qualquer')
    const r = await t.c.post('/api/sales', { amount_cents: 1_000, currency: 'BRL', contact_id: await newContact(t), external_id: `ext-${tag()}` })
    expect(r.status, r.text).toBe(201)
    await waitFor(() => sys.fakeMeta.capiEventsFor(auto.pixelId).length === 1, 45_000, 'venda no pixel automático')
    await sleep(2000)
    expect(sys.fakeMeta.capiEventsFor(pixelId)).toHaveLength(0)
  })

  it('AC-T125-03 repetir a mesma venda (mesmo external_id) não gera um segundo evento no FakeMetaGraph', async () => {
    const t = await tenant(sys)
    const px = await salesPixel(sys, t)
    const contactId = await newContact(t)
    const body = { amount_cents: 5_000, currency: 'BRL', contact_id: contactId, external_id: `ext-rep-${tag()}`, status: 'approved' }
    const first = await t.c.post('/api/sales', body)
    expect(first.status, first.text).toBe(201)
    await waitFor(() => sys.fakeMeta.capiEventsFor(px.pixelId).length === 1, 45_000, 'primeiro Purchase')
    const again = await t.c.post('/api/sales', body)
    expect(again.status, again.text).toBe(200)
    expect(again.body.created).toBe(false)
    expect(again.body.sale.id).toBe(first.body.sale.id)
    const third = await t.c.post('/api/sales', body)
    expect(third.body.sale.id).toBe(first.body.sale.id)
    await sleep(5000)
    const events = sys.fakeMeta.capiEventsFor(px.pixelId)
    expect(events, 'segundo evento para a mesma venda').toHaveLength(1)
    expect(events[0].event.event_id).toBe(`sale-${first.body.sale.id}`)
  })
})

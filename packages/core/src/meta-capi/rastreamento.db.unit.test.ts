// Revisão 3 (rastreamento Meta, paridade com o Leona e além) contra o FakeMetaGraph e Postgres real:
// 7 dias, business_messaging com fallback e reteste, test_event_code do pixel, diagnóstico, Lead automático de anúncio,
// link rastreável ponta a ponta e ctwa_clid do ingest até o payload. Nenhuma chamada à Meta real.
import { createHash, randomBytes } from 'node:crypto'
import { capiEventLog, companies, connections, contactAttribution, contacts, createDb, messages, pixelConfigs, trackedLinkClicks, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto } from '@crm/node-kit'
import type { IncomingMessage, WaEvent } from '@crm/wa-port'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatIngest, type CrmInboundEvent } from '../chats/ingest/chat-ingest'
import { FakeMetaGraph } from '../meta-ads/client/testing'
import { adLeadEventId, sendAdLeadToPixels } from './ad-lead'
import { CapiEventLogService } from './events-log'
import { PixelConfigService, type PixelConfigInput } from './pixels'
import { CapiService, type CapiServiceOptions } from './service'
import { InternalSalesService } from '../meta-ads/sales-join/service'
import { SalesService } from '../sales/service'
import { TrackedLinksService } from './tracked-links'

let tmp: TempDatabase
let db: Database
const fake = new FakeMetaGraph()
const h = (v: string) => createHash('sha256').update(v).digest('hex')
const DAY = 24 * 3600_000

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

async function world(pixel: Partial<PixelConfigInput> = {}) {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `R${tag}`, slug: `r-rev3-${tag}` }).returning()
  const pixelId = String(200000000000000 + Math.floor(Math.random() * 1e9))
  const token = `EAAB${randomBytes(12).toString('hex')}`
  fake.addPixel(pixelId, token)
  const px = await new PixelConfigService({ db }).create(c!.id, { name: 'Pixel', pixel_id: pixelId, access_token: token, ...pixel })
  const [contact] = await db
    .insert(contacts)
    .values({
      companyId: c!.id,
      name: "Ana D'Ávila",
      phoneE164: `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      email: 'ana@example.com',
      city: 'São Paulo',
      state: 'São Paulo',
      zip: '01310-100',
      ctwaClid: 'CLID-FROM-AD',
    })
    .returning()
  return { companyId: c!.id, pixel: px, pixelId, token, contact: contact! }
}

const capi = (o: Partial<CapiServiceOptions> = {}) => new CapiService({ db, graphUrl: fake.url, testEventCode: null, ...o })
const logOf = async (pixelConfigId: string, eventId: string) => (await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, pixelConfigId))).find((l) => l.eventId === eventId)!

describe('qualidade (itens 1–3)', () => {
  it('user_data do contato: ph/em/fn/ln/ct/st/zp/country/external_id normalizados e hasheados', async () => {
    const w = await world()
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const r = await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'q-1', user, source: 'manual' })
    expect(r).toMatchObject({ status: 'sent', mode: 'chat' })
    const ud = fake.capiEventsFor(w.pixelId)[0]!.event.user_data as Record<string, unknown>
    expect(ud).toEqual({
      ph: [h(w.contact.phoneE164!.slice(1))],
      em: [h('ana@example.com')],
      external_id: [h(w.contact.id)],
      fn: [h('ana')],
      ln: [h('davila')],
      ct: [h('saopaulo')],
      st: [h('sp')],
      zp: [h('01310100')],
      country: [h('br')],
    })
    const log = await logOf(w.pixel.id, 'q-1')
    expect(log).toMatchObject({ status: 'sent', actionSource: 'chat', matchScore: 3, testEvent: false })
    expect(log.identifiers).toEqual(['country', 'ct', 'em', 'external_id', 'fn', 'ln', 'ph', 'st', 'zp'])
    expect(JSON.stringify(log)).not.toContain('ana@example.com')
  })

  it('país padrão do pixel quando o DDI não resolve', async () => {
    const w = await world({ default_country: 'PT' })
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'dc-1', user: { email: 'x@y.com' }, source: 'manual' })
    expect((fake.capiEventsFor(w.pixelId)[0]!.event.user_data as Record<string, unknown>).country).toEqual([h('pt')])
  })

  it('event_time com mais de 7 dias: não envia, log discarded com motivo, nunca reenvia', async () => {
    const w = await world()
    const input = { companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Purchase' as const, eventId: 'old-1', value: 10, eventTime: new Date(Date.now() - 8 * DAY), source: 'sale' as const }
    const r = await capi().send(input)
    expect(r).toMatchObject({ status: 'discarded', reason: expect.stringContaining('7 dias') })
    expect(await capi().send(input)).toMatchObject({ status: 'discarded' })
    expect(fake.requestsTo(`/${w.pixelId}/events`)).toHaveLength(0)
    expect(await logOf(w.pixel.id, 'old-1')).toMatchObject({ status: 'discarded', error: expect.stringContaining('7 dias') })
    // 6 dias: ainda vai.
    expect(await capi().send({ ...input, eventId: 'old-2', eventTime: new Date(Date.now() - 6 * DAY) })).toMatchObject({ status: 'sent' })
  })
})

describe('business_messaging (itens 4–6)', () => {
  it('pixel com WABA + contato com ctwa_clid: business_messaging aceito, LeadSubmitted, bm_status accepted', async () => {
    const w = await world({ whatsapp_business_account_id: '104996122399160', page_id: '555000111' })
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const r = await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'bm-1', user, source: 'flow' })
    expect(r).toMatchObject({ status: 'sent', mode: 'business_messaging', fallback: false, eventsReceived: 1 })
    const ev = fake.capiEventsFor(w.pixelId)[0]!.event
    expect(ev).toEqual({
      event_name: 'LeadSubmitted',
      event_time: expect.any(Number),
      event_id: 'bm-1',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: '104996122399160', ctwa_clid: 'CLID-FROM-AD' },
      custom_data: { currency: 'BRL' },
    })
    expect(await logOf(w.pixel.id, 'bm-1')).toMatchObject({ status: 'sent', actionSource: 'business_messaging', identifiers: ['ctwa_clid', 'whatsapp_business_account_id'], matchScore: 1 })
    const [p] = await db.select().from(pixelConfigs).where(eq(pixelConfigs.id, w.pixel.id))
    expect(p).toMatchObject({ bmStatus: 'accepted', bmError: null })
  })

  it('só page_id (recusado pela Meta): reenvia o MESMO event_id como chat; log marca a recusa; não insiste por 24 h; reteste depois', async () => {
    const w = await world({ page_id: '555000111' })
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const r = await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Purchase', eventId: 'fb-1', value: '99,90', user, source: 'flow' })
    expect(r).toMatchObject({ status: 'sent', mode: 'chat', fallback: true })
    const reqs = fake.requestsTo(`/${w.pixelId}/events`)
    expect(reqs).toHaveLength(2)
    expect((reqs[0]!.json as { data: Record<string, unknown>[] }).data[0]).toMatchObject({ event_id: 'fb-1', action_source: 'business_messaging', user_data: { page_id: '555000111', ctwa_clid: 'CLID-FROM-AD' } })
    const accepted = fake.capiEventsFor(w.pixelId)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.event).toMatchObject({ event_id: 'fb-1', event_name: 'Purchase', action_source: 'chat', custom_data: { value: 99.9, currency: 'BRL' } })
    const log = await logOf(w.pixel.id, 'fb-1')
    expect(log).toMatchObject({ status: 'sent', actionSource: 'chat' })
    expect(log.response).toMatchObject({ mode: 'chat', events_received: 1, business_messaging: { rejected: true, status: 400, code: 100, fbtrace_id: expect.any(String) } })
    const [p] = await db.select().from(pixelConfigs).where(eq(pixelConfigs.id, w.pixel.id))
    expect(p).toMatchObject({ bmStatus: 'rejected', bmError: expect.stringContaining('whatsapp_business_account_id') })

    // Próximo evento: já sabe que recusa → 1 POST só (chat).
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'fb-2', user, source: 'flow' })
    expect(fake.requestsTo(`/${w.pixelId}/events`)).toHaveLength(3)
    // 25 h depois: testa business_messaging de novo.
    await capi({ now: () => new Date(Date.now() + 25 * 3600_000) }).send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'fb-3', eventTime: new Date(), user, source: 'flow' })
    const all = fake.requestsTo(`/${w.pixelId}/events`)
    expect(all).toHaveLength(5)
    expect((all[3]!.json as { data: Record<string, unknown>[] }).data[0]).toMatchObject({ event_id: 'fb-3', action_source: 'business_messaging' })
  })

  it('page_id/WABA do nó sobrepõe o do pixel; evento não suportado em BM vai como chat', async () => {
    const w = await world()
    fake.setBusinessMessagingMode(w.pixelId, 'accept')
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Purchase', eventId: 'ov-1', value: 1, user, pageId: '777', source: 'flow' })
    expect(fake.capiEventsFor(w.pixelId)[0]!.event).toMatchObject({ action_source: 'business_messaging', user_data: { page_id: '777', ctwa_clid: 'CLID-FROM-AD' } })
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Schedule', eventId: 'ov-2', user, pageId: '777', source: 'flow' })
    expect(fake.capiEventsFor(w.pixelId)[1]!.event).toMatchObject({ event_name: 'Schedule', action_source: 'chat' })
  })

  it('recusa do business_messaging + recusa do chat (token): failed, bm_status não muda, retentável', async () => {
    const w = await world({ whatsapp_business_account_id: '104996122399160' })
    fake.setBusinessMessagingMode(w.pixelId, 'reject')
    fake.addPixel(w.pixelId, 'outro')
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const r = await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'ff-1', user, source: 'flow' })
    expect(r).toMatchObject({ status: 'failed', error: expect.stringContaining('190') })
    const [p] = await db.select().from(pixelConfigs).where(eq(pixelConfigs.id, w.pixel.id))
    expect(p!.bmStatus).toBeNull()
    expect(await logOf(w.pixel.id, 'ff-1')).toMatchObject({ status: 'failed' })
  })
})

describe('test_event_code por pixel (item 9) e diagnóstico (item 10)', () => {
  it('código do pixel vai mesmo em produção; o do env não', async () => {
    const w = await world({ test_event_code: 'TEST777' })
    await capi({ isProduction: true, testEventCode: 'ENVCODE' }).send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 't-1', source: 'manual' })
    const other = await world()
    await capi({ isProduction: true, testEventCode: 'ENVCODE' }).send({ companyId: other.companyId, pixelConfigId: other.pixel.id, eventName: 'Lead', eventId: 't-2', source: 'manual' })
    expect(fake.capiEventsFor(w.pixelId)[0]!.testEventCode).toBe('TEST777')
    expect(fake.capiEventsFor(other.pixelId)[0]!.testEventCode).toBeNull()
    expect(await logOf(w.pixel.id, 't-1')).toMatchObject({ testEvent: true })
  })

  it('lista eventos com status, modo, identificadores (só nomes), pontuação, filtros e paginação', async () => {
    const w = await world({ page_id: '555000111' })
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Purchase', eventId: 'd-1', value: 10, user, source: 'sale', actionSource: 'system_generated' })
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'd-2', eventTime: new Date(Date.now() - 9 * DAY), source: 'flow' })
    fake.failNext(400, { message: 'Invalid parameter', code: 100, fbtrace_id: 'TRACE-X' })
    await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Contact', eventId: 'd-3', source: 'flow' })
    const svc = new CapiEventLogService({ db })
    const all = await svc.list(w.companyId, w.pixel.id, { page: 1, limit: 2 })
    expect(all.page).toMatchObject({ total_count: 3, total_pages: 2, has_more: true })
    expect(all.summary).toMatchObject({ sent: 1, failed: 1, discarded: 1 })
    const sent = (await svc.list(w.companyId, w.pixel.id, { page: 1, limit: 10, status: 'sent' })).items
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ event_id: 'd-1', mode: 'system_generated', events_received: 1, value: 10, currency: 'BRL', fallback: { error: expect.any(String) } })
    expect(sent[0]!.identifiers).toContain('ph')
    expect(JSON.stringify(sent[0])).not.toContain(w.contact.phoneE164!.slice(1))
    const failed = (await svc.list(w.companyId, w.pixel.id, { page: 1, limit: 10, status: 'failed' })).items[0]!
    expect(failed).toMatchObject({ event_id: 'd-3', error: expect.stringContaining('Invalid parameter'), fbtrace_id: 'TRACE-X' })
    const discarded = (await svc.list(w.companyId, w.pixel.id, { page: 1, limit: 10, status: 'discarded' })).items[0]!
    expect(discarded).toMatchObject({ event_id: 'd-2', error: expect.stringContaining('7 dias') })
    expect((await svc.list(w.companyId, w.pixel.id, { page: 1, limit: 10, event_name: 'Contact' })).items).toHaveLength(1)
    const other = await world()
    await expect(svc.list(other.companyId, w.pixel.id, { page: 1, limit: 10 })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('Lead automático de anúncio (item 8)', () => {
  it('manda Lead uma vez por contato para os pixels com auto_lead_on_ad', async () => {
    const w = await world({ auto_lead_on_ad: true })
    const off = await new PixelConfigService({ db }).create(w.companyId, { name: 'Sem auto', pixel_id: '123', access_token: 'tok-sem-auto-123' })
    const data = { kind: 'ad_lead' as const, companyId: w.companyId, contactId: w.contact.id, at: new Date().toISOString() }
    const out = await sendAdLeadToPixels({ db, capi: capi() }, data)
    expect(out).toEqual([{ pixelConfigId: w.pixel.id, result: expect.objectContaining({ status: 'sent' }) }])
    expect((await sendAdLeadToPixels({ db, capi: capi() }, data))[0]!.result.status).toBe('duplicate')
    const evs = fake.capiEventsFor(w.pixelId)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.event).toMatchObject({ event_name: 'Lead', event_id: adLeadEventId(w.contact.id), action_source: 'chat' })
    expect(await logOf(w.pixel.id, adLeadEventId(w.contact.id))).toMatchObject({ source: 'ad_lead', sourceId: w.contact.id })
    expect((await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, off.id))).length).toBe(0)
  })
})

describe('ponta a ponta: ingest → contato → payload', () => {
  async function ingestWorld(pixel: Partial<PixelConfigInput> = {}) {
    const w = await world(pixel)
    const sessionId = `sess-${randomBytes(4).toString('hex')}`
    const [conn] = await db.insert(connections).values({ companyId: w.companyId, sessionId, name: 'Loja', phoneNumber: '5511988887777' }).returning()
    const inbound: CrmInboundEvent[] = []
    const ingest = new ChatIngest({ db, resolveConnection: async (sid) => (sid === sessionId ? { companyId: w.companyId, connectionId: conn!.id } : null), onInbound: (e) => void inbound.push(e) })
    let n = 0
    const msg = (over: Partial<IncomingMessage>): WaEvent =>
      ({
        v: 1,
        type: 'message.inbound',
        session_id: sessionId,
        at: new Date().toISOString(),
        message: { id: `WA-${++n}-${randomBytes(3).toString('hex')}`, from: '5521977776666@s.whatsapp.net', from_me: false, timestamp: Date.now(), type: 'conversation', text: 'oi', ...over },
      }) as WaEvent
    return { ...w, conn: conn!, ingest, inbound, msg }
  }

  it('ctwa_clid do externalAdReply chega ao user_data do business_messaging; crm.inbound sai com ad_source ctwa', async () => {
    const s = await ingestWorld({ whatsapp_business_account_id: '104996122399160' })
    const out = (await s.ingest.handle(s.msg({ text: 'Vi o anúncio', ad: { ctwa_clid: 'ARA-ingest-clid', source_id: '120200000001', source_url: 'https://fb.me/x' } }))) as { status: string }
    expect(out.status).toBe('stored')
    expect(s.inbound[0]).toMatchObject({ ad_source: 'ctwa' })
    const contactId = s.inbound[0]!.contact_id
    const [att] = await db.select().from(contactAttribution).where(eq(contactAttribution.contactId, contactId))
    expect(att).toMatchObject({ firstCtwaClid: 'ARA-ingest-clid', lastSourceId: '120200000001' })
    const user = await capi().userFromContact(s.companyId, contactId)
    await capi().send({ companyId: s.companyId, pixelConfigId: s.pixel.id, eventName: 'Purchase', eventId: 'e2e-1', value: 50, user, source: 'flow' })
    expect(fake.capiEventsFor(s.pixelId)[0]!.event).toMatchObject({ action_source: 'business_messaging', user_data: { whatsapp_business_account_id: '104996122399160', ctwa_clid: 'ARA-ingest-clid' } })
  })

  it('link rastreável: clique (fbclid/fbp/utm/IP/UA) → wa.me com código → 1ª mensagem liga o contato, limpa o texto e o evento leva fbc/fbp/IP/UA', async () => {
    const s = await ingestWorld()
    const links = new TrackedLinksService({ db })
    const link = await links.create(s.companyId, { name: 'Campanha Black Friday', connection_id: s.conn.id, message: 'Olá! Quero saber da promoção', utm_source: 'facebook' })
    expect(link).toMatchObject({ slug: 'campanha-black-friday', path: '/api/w/campanha-black-friday', connection_name: 'Loja', code_mode: 'visible', match_window_minutes: 10, stats: { clicks: 0, conversations: 0, probable: 0, sales: 0 } })
    const before = Date.now()
    const click = await links.click(link.slug, {
      query: { fbclid: 'IwAR2F4-dbP0l7Mn1Iaw_QQ', fbp: 'fb.1.1596403881668.1116446470', utm_campaign: 'bf2026', utm_content: '120200000099' },
      ip: '2804:14c::1',
      userAgent: 'Mozilla/5.0 (iPhone)',
    })
    expect(click).not.toBeNull()
    const loc = new URL(click!.location)
    expect(loc.origin + loc.pathname).toBe('https://wa.me/5511988887777')
    expect(loc.searchParams.get('text')).toBe(`Olá! Quero saber da promoção (ref ${click!.code})`)
    const [row] = await db.select().from(trackedLinkClicks).where(eq(trackedLinkClicks.code, click!.code))
    expect(row).toMatchObject({ fbclid: 'IwAR2F4-dbP0l7Mn1Iaw_QQ', fbp: 'fb.1.1596403881668.1116446470', utmSource: 'facebook', utmCampaign: 'bf2026', clientIp: '2804:14c::1', contactId: null })
    expect(row!.fbc).toMatch(/^fb\.1\.\d{13}\.IwAR2F4-dbP0l7Mn1Iaw_QQ$/)
    expect(Number(row!.fbc!.split('.')[2])).toBeGreaterThanOrEqual(before)

    // Slug desconhecido ou inativo: null (404 na rota).
    expect(await links.click('nao-existe', { query: {} })).toBeNull()

    await s.ingest.handle(s.msg({ text: loc.searchParams.get('text')! }))
    const contactId = s.inbound[0]!.contact_id
    expect(s.inbound[0]).toMatchObject({ ad_source: 'link', text: 'Olá! Quero saber da promoção' })
    const [m] = await db.select().from(messages).where(eq(messages.id, s.inbound[0]!.message_id))
    expect(m!.body).toBe('Olá! Quero saber da promoção')
    const [matched] = await db.select().from(trackedLinkClicks).where(eq(trackedLinkClicks.code, click!.code))
    expect(matched).toMatchObject({ contactId, matchedAt: expect.any(Date) })
    const [att] = await db.select().from(contactAttribution).where(eq(contactAttribution.contactId, contactId))
    expect(att).toMatchObject({ firstUtmSource: 'facebook', firstUtmCampaign: 'bf2026', lastUtmContent: '120200000099' })
    // Mesma mensagem de novo (outro wa id): não liga de novo nem dispara ad_source.
    await s.ingest.handle(s.msg({ text: loc.searchParams.get('text')! }))
    expect(s.inbound[1]!.ad_source).toBeUndefined()

    const user = await capi().userFromContact(s.companyId, contactId)
    await capi().send({ companyId: s.companyId, pixelConfigId: s.pixel.id, eventName: 'Lead', eventId: 'lk-1', user, source: 'flow' })
    const ud = fake.capiEventsFor(s.pixelId)[0]!.event.user_data as Record<string, unknown>
    expect(ud).toMatchObject({ fbc: matched!.fbc, fbp: 'fb.1.1596403881668.1116446470', client_ip_address: '2804:14c::1', client_user_agent: 'Mozilla/5.0 (iPhone)', ph: [h('5521977776666')] })
    expect((await logOf(s.pixel.id, 'lk-1')).matchScore).toBe(5)

    const listed = (await links.list(s.companyId)).find((l) => l.id === link.id)!
    expect(listed.stats).toMatchObject({ clicks: 1, conversations: 1 })
  })

  it('código de outra empresa ou inexistente não mexe no texto', async () => {
    const s = await ingestWorld()
    await s.ingest.handle(s.msg({ text: 'oi (ref ABCDEF)' }))
    expect(s.inbound[0]).toMatchObject({ text: 'oi (ref ABCDEF)' })
    expect(s.inbound[0]!.ad_source).toBeUndefined()
  })
})

// ---- Revisão do usuário: fallback sem duplicar e níveis de confiança -------------------------------------------------

describe('fallback sem duplicar (rejeição explícita × incerto)', () => {
  const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as { data: Record<string, unknown>[] }

  it('timeout no business_messaging: incerto, NÃO cai para chat; a retentativa usa o mesmo modo, event_id e event_time', async () => {
    const w = await world({ whatsapp_business_account_id: '104996122399160' })
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const sent: Record<string, unknown>[] = []
    let failOnce = true
    const flaky: typeof fetch = async (url, init) => {
      sent.push(bodyOf(init).data[0]!)
      if (failOnce) {
        failOnce = false
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      return fetch(url, init)
    }
    const input = { companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead' as const, eventId: 'to-1', user, source: 'flow' as const }
    const r1 = await capi({ fetch: flaky }).send(input)
    expect(r1).toMatchObject({ status: 'uncertain', mode: 'business_messaging' })
    expect(sent).toHaveLength(1)
    const log1 = await logOf(w.pixel.id, 'to-1')
    expect(log1).toMatchObject({ status: 'uncertain', actionSource: 'business_messaging', response: expect.objectContaining({ kind: 'uncertain', pinned_mode: 'business_messaging' }) })
    // Retentativa um pouco depois (o job): mesmo modo e mesmo event_time.
    const r2 = await capi({ fetch: flaky, now: () => new Date(Date.now() + 60_000) }).send({ ...input, eventTime: new Date(Date.now() + 60_000) })
    expect(r2).toMatchObject({ status: 'sent', mode: 'business_messaging', fallback: false })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ event_id: 'to-1', action_source: 'business_messaging', event_time: sent[0]!.event_time })
    expect(fake.capiEventsFor(w.pixelId)).toHaveLength(1)
    // Terceira chamada (resposta duplicada do job): nada.
    expect((await capi().send(input)).status).toBe('duplicate')
    expect(fake.capiEventsFor(w.pixelId)).toHaveLength(1)
  })

  it('5xx no modo chat: incerto e retentado no mesmo modo; 429: rejeitado retentável sem trocar de modo', async () => {
    const w = await world()
    fake.failNext(503, { message: 'Service temporarily unavailable', code: 2 })
    const input = { companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Contact' as const, eventId: '5x-1', source: 'flow' as const }
    expect(await capi().send(input)).toMatchObject({ status: 'uncertain', mode: 'chat' })
    expect(await capi().send(input)).toMatchObject({ status: 'sent', mode: 'chat' })
    expect(fake.capiEventsFor(w.pixelId).filter((e) => e.event.event_id === '5x-1')).toHaveLength(1)

    fake.failNext(429, { message: 'Application request limit reached', code: 4 })
    const r = await capi().send({ ...input, eventId: 'rl-1' })
    expect(r).toMatchObject({ status: 'failed', retryable: true })
    expect(await logOf(w.pixel.id, 'rl-1')).toMatchObject({ status: 'failed', response: expect.objectContaining({ kind: 'rate_limited', pinned_mode: 'chat' }) })
  })

  it('rejeição explícita (código 100) do business_messaging: fallback para chat UMA vez, mesmo event_id', async () => {
    const w = await world({ page_id: '555000111' })
    const user = await capi().userFromContact(w.companyId, w.contact.id)
    const r = await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'rx-1', user, source: 'flow' })
    expect(r).toMatchObject({ status: 'sent', mode: 'chat', fallback: true })
    const reqs = fake.requestsTo(`/${w.pixelId}/events`).map((q) => (q.json as { data: Record<string, unknown>[] }).data[0]!)
    expect(reqs.map((e) => [e.event_id, e.action_source])).toEqual([
      ['rx-1', 'business_messaging'],
      ['rx-1', 'chat'],
    ])
    expect(fake.capiEventsFor(w.pixelId)).toHaveLength(1)
  })
})

describe('níveis de confiança da atribuição', () => {
  async function ingestWorld(pixel: Partial<PixelConfigInput> = {}) {
    const w = await world(pixel)
    const sessionId = `sess-${randomBytes(4).toString('hex')}`
    const [conn] = await db.insert(connections).values({ companyId: w.companyId, sessionId, name: 'Loja', phoneNumber: '5511988887777' }).returning()
    const inbound: CrmInboundEvent[] = []
    const ingest = new ChatIngest({ db, resolveConnection: async (sid) => (sid === sessionId ? { companyId: w.companyId, connectionId: conn!.id } : null), onInbound: (e) => void inbound.push(e) })
    let n = 0
    const msg = (over: Partial<IncomingMessage>, from = '5521977776666'): WaEvent =>
      ({
        v: 1,
        type: 'message.inbound',
        session_id: sessionId,
        at: new Date().toISOString(),
        message: { id: `WA-${++n}-${randomBytes(3).toString('hex')}`, from: `${from}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), type: 'conversation', text: 'oi', ...over },
      }) as WaEvent
    const attribution = async (contactId: string) => (await db.select().from(contactAttribution).where(eq(contactAttribution.contactId, contactId)))[0]
    return { ...w, conn: conn!, ingest, inbound, msg, attribution, links: new TrackedLinksService({ db }) }
  }
  const textOf = (location: string) => new URL(location).searchParams.get('text')!

  it('nativo: confirmed_native/ctwa_referral; a venda herda source_id e a confiança; sem evidência = none', async () => {
    const s = await ingestWorld()
    await s.ingest.handle(s.msg({ ad: { ctwa_clid: 'C-N', source_id: '120201', source_url: 'https://fb.me/n' } }))
    const contactId = s.inbound[0]!.contact_id
    expect(await s.attribution(contactId)).toMatchObject({ confidence: 'confirmed_native', method: 'ctwa_referral', confidenceSourceId: '120201' })
    const { sale } = await new SalesService({ db }).record({ companyId: s.companyId, source: 'manual', amountCents: 5000, contactId })
    expect(sale).toMatchObject({ source_id: '120201', attribution_confidence: 'confirmed_native', attribution_method: 'ctwa_referral' })
    const [plain] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Sem anúncio', phoneE164: '+5511900001111' }).returning()
    const { sale: none } = await new SalesService({ db }).record({ companyId: s.companyId, source: 'manual', amountCents: 100, contactId: plain!.id })
    expect(none).toMatchObject({ source_id: null, attribution_confidence: 'none' })
  })

  it('link com código e depois nativo: sobe para nativo e guarda o histórico; o inverso mantém o nativo', async () => {
    const s = await ingestWorld()
    const link = await s.links.create(s.companyId, { name: 'Landing', connection_id: s.conn.id, message: 'Oi' })
    const click = await s.links.click(link.slug, { query: { ad_id: '777001', fbclid: 'IwAR-link-xyz12' } })
    await s.ingest.handle(s.msg({ text: textOf(click!.location) }))
    const contactId = s.inbound[0]!.contact_id
    expect(await s.attribution(contactId)).toMatchObject({ confidence: 'confirmed_link', method: 'tracked_link_code', confidenceSourceId: '777001' })
    const { sale } = await new SalesService({ db }).record({ companyId: s.companyId, source: 'manual', amountCents: 1000, contactId })
    expect(sale).toMatchObject({ source_id: '777001', attribution_confidence: 'confirmed_link' })
    await s.ingest.handle(s.msg({ ad: { ctwa_clid: 'C-UP', source_id: '120999' } }))
    const up = await s.attribution(contactId)
    expect(up).toMatchObject({ confidence: 'confirmed_native', confidenceSourceId: '120999' })
    expect(up!.confidenceHistory.map((h) => [h.confidence, h.outcome])).toEqual([
      ['confirmed_link', 'applied'],
      ['confirmed_native', 'applied'],
    ])

    const other = await ingestWorld()
    await other.ingest.handle(other.msg({ ad: { ctwa_clid: 'C-1', source_id: '5001' } }, '5531955554444'))
    const l2 = await other.links.create(other.companyId, { name: 'Landing 2', connection_id: other.conn.id })
    const c2 = await other.links.click(l2.slug, { query: {} })
    await other.ingest.handle(other.msg({ text: textOf(c2!.location) }, '5531955554444'))
    const kept = await other.attribution(other.inbound[0]!.contact_id)
    expect(kept).toMatchObject({ confidence: 'confirmed_native', confidenceSourceId: '5001' })
    expect(kept!.confidenceHistory.at(-1)).toMatchObject({ confidence: 'confirmed_link', outcome: 'kept_previous' })
  })

  it('código discreto (invisível) também liga como confirmed_link e sai do texto', async () => {
    const s = await ingestWorld()
    const link = await s.links.create(s.companyId, { name: 'Discreto', connection_id: s.conn.id, message: 'Quero info', code_mode: 'discreet' })
    const click = await s.links.click(link.slug, { query: {} })
    const text = textOf(click!.location)
    expect(text.startsWith('Quero info')).toBe(true)
    expect(text).not.toContain('ref')
    await s.ingest.handle(s.msg({ text }))
    expect(s.inbound[0]).toMatchObject({ ad_source: 'link', text: 'Quero info' })
    expect(await s.attribution(s.inbound[0]!.contact_id)).toMatchObject({ confidence: 'confirmed_link' })
  })

  it('provável: só com a opção ligada e um único clique na janela; nunca libera fbc/ctwa na CAPI; ROAS separa', async () => {
    const s = await ingestWorld()
    const off = await s.links.create(s.companyId, { name: 'Sem código', connection_id: s.conn.id, code_mode: 'off' })
    expect(off).toMatchObject({ code_mode: 'off', probable_match: false })
    await s.links.click(off.slug, { query: { fbclid: 'IwAR-off-123456' } })
    await s.ingest.handle(s.msg({ text: 'oi' }, '5541911112222'))
    expect(await s.attribution(s.inbound[0]!.contact_id)).toBeUndefined()

    const on = await s.links.update(s.companyId, off.id, { probable_match: true, match_window_minutes: 15 })
    expect(on).toMatchObject({ probable_match: true, match_window_minutes: 15 })
    // O clique anterior (já fora do teste) foi consumido? Não: continua livre e entraria como 2º candidato.
    await db.update(trackedLinkClicks).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(trackedLinkClicks.linkId, off.id))
    const c = await s.links.click(on.slug, { query: { fbclid: 'IwAR-prob-123456', ad_id: '888001' }, ip: '1.2.3.4', userAgent: 'UA' })
    expect(new URL(c!.location).searchParams.get('text')).toBeNull()
    await s.ingest.handle(s.msg({ text: 'quero comprar' }, '5541933334444'))
    const contactId = s.inbound[1]!.contact_id
    expect(s.inbound[1]).toMatchObject({ ad_source: 'link' })
    expect(await s.attribution(contactId)).toMatchObject({ confidence: 'probable', method: 'tracked_link_window', confidenceSourceId: '888001' })
    const [clk] = await db.select().from(trackedLinkClicks).where(eq(trackedLinkClicks.code, c!.code))
    expect(clk).toMatchObject({ contactId, matchConfidence: 'probable' })
    const user = await capi().userFromContact(s.companyId, contactId)
    expect(user.fbc ?? null).toBeNull()
    expect(user.clientIpAddress ?? null).toBeNull()
    expect(user.ctwaClid ?? null).toBeNull()
    const { sale } = await new SalesService({ db }).record({ companyId: s.companyId, source: 'manual', amountCents: 9900, contactId })
    expect(sale).toMatchObject({ source_id: '888001', attribution_confidence: 'probable' })
    const today = new Date().toISOString().slice(0, 10)
    const svc = new InternalSalesService({ db })
    expect(await svc.aggregates({ companyId: s.companyId, since: today, until: today, adIds: ['888001'], timeZone: 'UTC' })).toEqual([])
    expect(await svc.aggregates({ companyId: s.companyId, since: today, until: today, adIds: ['888001'], timeZone: 'UTC', confidence: 'probable' })).toEqual([
      { sourceId: '888001', currency: 'BRL', count: 1, amountCents: 9900 },
    ])

    // Dois cliques candidatos na janela: não atribui.
    await s.links.click(on.slug, { query: {} })
    await s.links.click(on.slug, { query: {} })
    await s.ingest.handle(s.msg({ text: 'oi' }, '5541955556666'))
    expect(await s.attribution(s.inbound[2]!.contact_id)).toBeUndefined()
    expect(s.inbound[2]!.ad_source).toBeUndefined()
  })
})

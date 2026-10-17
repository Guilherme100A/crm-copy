// AC-T104-01..05: Conversions API, CRUD de pixels e nó `pixel` num fluxo real (FakeMetaGraph, nunca a Meta).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asList, capi, eventsFor, memberOf, newPixel, owner, pixelFlow, runFlow, sha256, startEnv, world, type Env } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const send = (svc: any, companyId: string, pixelConfigId: string, extra: Record<string, unknown> = {}) =>
  svc.send({ companyId, pixelConfigId, eventName: 'Purchase', eventId: `ev-${randomUUID()}`, value: 100, currency: 'BRL', source: 'manual', ...extra })

describe('T104 — hash dos dados do usuário (AC-T104-01)', () => {
  it('AC-T104-01 telefone "+55 (11) 99999-8888" vai como sha256("5511999998888"); e-mail normalizado (trim, minúsculas) antes do hash', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const r = await send(capi(env), o.companyId, px.id, { user: { phone: '+55 (11) 99999-8888', email: '  Maria.Souza@Example.COM  ' } })
    expect(r.status).toBe('sent')
    const [ev] = eventsFor(env, px.pixelId)
    expect(ev, 'evento não chegou ao fake').toBeDefined()
    const ud = ev.event.user_data
    expect(asList(ud.ph)).toEqual([sha256('5511999998888')])
    expect(asList(ud.em)).toEqual([sha256('maria.souza@example.com')])
    // nada em claro no corpo enviado
    const raw = JSON.stringify(env.fake.requests.filter((x: any) => String(x.path).endsWith(`/${px.pixelId}/events`)))
    expect(raw).not.toContain('99999-8888')
    expect(raw).not.toContain('5511999998888')
    expect(raw.toLowerCase()).not.toContain('maria.souza@example.com')
  })

  it('AC-T104-01 no nó do fluxo, os dados vêm do contato do run com o mesmo hash', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const w = await world(env, o.companyId, { phone: '+5511999998888', email: 'Contato.T104@Example.com' })
    const r = await runFlow(env, w, pixelFlow({ pixel_config_id: px.id, event_type: 'Compra', item_value: 50, currency: 'BRL' }))
    expect(r.error).toBeNull()
    const [ev] = eventsFor(env, px.pixelId)
    expect(asList(ev.event.user_data.ph)).toEqual([sha256('5511999998888')])
    expect(asList(ev.event.user_data.em)).toEqual([sha256('contato.t104@example.com')])
  })
})

describe('T104 — dedupe por event_id (AC-T104-02)', () => {
  it('AC-T104-02 o mesmo event_id enviado duas vezes resulta em 1 POST ao fake', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const svc = capi(env)
    const eventId = `ev-dup-${randomUUID()}`
    const a = await send(svc, o.companyId, px.id, { eventId })
    const b = await send(capi(env), o.companyId, px.id, { eventId }) // outra instância (reentrega)
    expect(a.status).toBe('sent')
    expect(b.status).toBe('duplicate')
    expect(eventsFor(env, px.pixelId)).toHaveLength(1)
    const posts = env.fake.requests.filter((x: any) => x.method === 'POST' && String(x.path).endsWith(`/${px.pixelId}/events`))
    expect(posts).toHaveLength(1)
    const log = await env.q(`SELECT count(*)::int AS n FROM crm.capi_event_log WHERE event_id = $1`, [eventId])
    expect(log[0].n).toBe(1)
  })

  it('AC-T104-02 event_ids diferentes geram POSTs separados; envio que falhou pode ser reenviado', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const svc = capi(env)
    await send(svc, o.companyId, px.id)
    await send(svc, o.companyId, px.id)
    expect(eventsFor(env, px.pixelId)).toHaveLength(2)
    const eventId = `ev-retry-${randomUUID()}`
    env.fake.failNext(500, { message: 'falha temporária', code: 1 })
    // Revisão 3 (AC-T104-08): 5xx é incerto (a Meta pode ter recebido) e é retentado com o mesmo event_id.
    expect((await send(svc, o.companyId, px.id, { eventId })).status).toBe('uncertain')
    expect((await send(svc, o.companyId, px.id, { eventId })).status).toBe('sent')
    expect(eventsFor(env, px.pixelId).filter((e: any) => e.event.event_id === eventId)).toHaveLength(1)
  })
})

describe('T104 — moeda e valor (AC-T104-03)', () => {
  for (const currency of ['', '   ', 'REAL', 'XX', null]) {
    it(`AC-T104-03 moeda ${JSON.stringify(currency)} vira BRL`, async () => {
      const o = await owner(env)
      const px = await newPixel(env, o)
      await send(capi(env), o.companyId, px.id, { currency })
      expect(eventsFor(env, px.pixelId)[0].event.custom_data.currency).toBe('BRL')
    })
  }

  it('AC-T104-03 moeda válida em minúsculas é aceita (USD)', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    await send(capi(env), o.companyId, px.id, { currency: 'usd' })
    expect(eventsFor(env, px.pixelId)[0].event.custom_data.currency).toBe('USD')
  })

  it('AC-T104-03 value com variável ({preco}) é renderizado no nó do fluxo', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const w = await world(env, o.companyId)
    const def = pixelFlow({ pixel_config_id: px.id, event_type: 'Compra', item_value: '{preco}', currency: '' }, [{ name: 'preco', default: '199,90' }])
    const r = await runFlow(env, w, def, { preco: '199,90' })
    expect(r.error).toBeNull()
    const [ev] = eventsFor(env, px.pixelId)
    expect(Number(ev.event.custom_data.value)).toBeCloseTo(199.9, 2)
    expect(ev.event.custom_data.currency).toBe('BRL')
    expect(ev.event.event_name).toBe('Purchase')
  })
})

describe('T104 — listagem mascarada e nó pixel (AC-T104-04)', () => {
  it('AC-T104-04 a listagem mascara pixel_id e token; o token só vem no GET individual com include_access_token', async () => {
    const o = await owner(env)
    const r = await o.c.post('/api/meta/pixels', { name: 'Pixel da loja', pixel_id: '123456789012345', access_token: 'EAABsegredodotoken1234xyz9' })
    expect(r.status, r.text).toBe(201)
    const id = r.body.pixel.id
    const list = await o.c.get('/api/meta/pixels')
    expect(list.status).toBe(200)
    const item = list.body.items.find((p: any) => p.id === id)
    expect(item.masked_pixel_id).toBe('***********2345')
    expect(item.masked_access_token).toBe('EAAB***xyz9')
    expect(list.text).not.toContain('123456789012345')
    expect(list.text).not.toContain('EAABsegredodotoken1234xyz9')

    const plain = await o.c.get(`/api/meta/pixels/${id}`)
    expect(plain.text).not.toContain('EAABsegredodotoken1234xyz9')
    const full = await o.c.get(`/api/meta/pixels/${id}?include_access_token=true`)
    expect(full.status).toBe(200)
    expect(full.body.pixel.access_token).toBe('EAABsegredodotoken1234xyz9')
    expect(full.body.pixel.pixel_id).toBe('123456789012345')

    const [row] = await env.q(`SELECT t::text AS dump FROM crm.pixel_configs t WHERE id = $1`, [id])
    expect(row.dump).not.toContain('EAABsegredodotoken1234xyz9')
  })

  it('AC-T104-04 sem facebook.pixel → 403; pixel de outra empresa → 404; pixel_id com letras → 422', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const nobody = await memberOf(env, o.companyId, ['contacts.view'])
    expect((await nobody.c.get('/api/meta/pixels')).status).toBe(403)
    expect((await nobody.c.get(`/api/meta/pixels/${px.id}?include_access_token=true`)).status).toBe(403)
    const stranger = await owner(env)
    expect((await stranger.c.get(`/api/meta/pixels/${px.id}`)).status).toBe(404)
    expect((await o.c.post('/api/meta/pixels', { name: 'Ruim', pixel_id: '12ab34', access_token: 'tok-1234567890' })).status).toBe(422)
  })

  it('AC-T104-04 o nó pixel envia o evento configurado e segue success', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const w = await world(env, o.companyId)
    const r = await runFlow(env, w, pixelFlow({ pixel_config_id: px.id, event_type: 'Lead', item_value: 10, currency: 'BRL' }))
    expect(r.error).toBeNull()
    expect(r.texts).toEqual(['PIXEL_OK'])
    expect(r.handle, JSON.stringify(r.steps)).toBe('success')
    const [ev] = eventsFor(env, px.pixelId)
    expect(ev.event.event_name).toBe('Lead')
    expect(ev.event.action_source).toBe('chat')
    const log = await env.q(`SELECT source, source_id, status FROM crm.capi_event_log WHERE pixel_config_id = $1`, [px.id])
    expect(log).toEqual([{ source: 'flow', source_id: r.runId, status: 'sent' }])
  })

  it('AC-T104-04 falha da Meta faz o nó seguir failure', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const w = await world(env, o.companyId)
    env.fake.failNext(500, { message: 'erro da Meta', code: 1 })
    const r = await runFlow(env, w, pixelFlow({ pixel_config_id: px.id, event_type: 'Compra', item_value: 10 }))
    expect(r.texts).toEqual(['PIXEL_FALHOU'])
    expect(r.handle, JSON.stringify(r.steps)).toBe('failure')
  })

  it('AC-T104-04 pixel inexistente também segue failure, sem POST', async () => {
    const o = await owner(env)
    const w = await world(env, o.companyId)
    const before = env.fake.requests.length
    const r = await runFlow(env, w, pixelFlow({ pixel_config_id: randomUUID(), event_type: 'Compra', item_value: 10 }))
    expect(r.texts).toEqual(['PIXEL_FALHOU'])
    expect(r.handle, JSON.stringify(r.steps)).toBe('failure')
    expect(env.fake.requests.slice(before).filter((x: any) => x.method === 'POST')).toHaveLength(0)
  })
})

describe('T104 — business_messaging só no modo mensagem de anúncio (AC-T104-05, revisão 3)', () => {
  const WABA = /business_messaging|whatsapp_business_account|waba|messaging_channel/i

  it('AC-T104-05 nenhum payload enviado (fluxo, venda, manual) usa action_source business_messaging nem campos de WABA', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o, { auto_send_sales: true })
    const w = await world(env, o.companyId)
    await runFlow(env, w, pixelFlow({ pixel_config_id: px.id, event_type: 'Compra', item_value: 30 }))
    await send(capi(env), o.companyId, px.id, { actionSource: 'system_generated', source: 'sale' })
    // venda aprovada → envio automático (system_generated)
    const [sale] = await env.q(`INSERT INTO crm.sales (company_id, contact_id, amount_cents, currency, status) VALUES ($1, $2, 12345, 'BRL', 'approved') RETURNING id`, [
      o.companyId,
      w.contactId,
    ])
    await env.core.sendSaleToPixels({ db: env.db, capi: capi(env) }, { companyId: o.companyId, saleId: sale.id })

    const events = eventsFor(env, px.pixelId)
    expect(events.length).toBeGreaterThanOrEqual(3)
    for (const e of events) {
      expect(['chat', 'system_generated']).toContain(e.event.action_source)
      expect(JSON.stringify(e.event)).not.toMatch(WABA)
    }
    const saleEv = events.find((e: any) => e.event.event_id === `sale-${sale.id}`)
    expect(saleEv, 'venda não enviada').toBeDefined()
    expect(saleEv.event.action_source).toBe('system_generated')
    expect(Number(saleEv.event.custom_data.value)).toBeCloseTo(123.45, 2)
    // o corpo bruto dos POSTs também não traz nada de WABA
    const raw = JSON.stringify(env.fake.requests.filter((x: any) => String(x.path).endsWith(`/${px.pixelId}/events`)).map((x: any) => x.body))
    expect(raw).not.toMatch(WABA)
  })

  // Revisão 3: com WABA no pixel e ctwa_clid nativo no contato, o fluxo manda business_messaging com os campos da doc
  // (https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging); Lead vira LeadSubmitted.
  it('AC-T104-05 (revisão 3) WABA + ctwa_clid nativo → business_messaging só com whatsapp_business_account_id e ctwa_clid', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o, { whatsapp_business_account_id: '104996122399160' })
    const w = await world(env, o.companyId)
    await env.q(`UPDATE crm.contacts SET ctwa_clid = 'ARA-acc-clid' WHERE id = $1`, [w.contactId])
    const r = await runFlow(env, w, pixelFlow({ pixel_config_id: px.id, event_type: 'Lead' }))
    expect(r.error).toBeNull()
    const [ev] = eventsFor(env, px.pixelId)
    expect(ev.event).toMatchObject({ event_name: 'LeadSubmitted', action_source: 'business_messaging', messaging_channel: 'whatsapp' })
    expect(ev.event.user_data).toEqual({ whatsapp_business_account_id: '104996122399160', ctwa_clid: 'ARA-acc-clid' })
  })

  it('AC-T104-05 pedir action_source business_messaging é recusado sem POST', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    const before = eventsFor(env, px.pixelId).length
    const err = await send(capi(env), o.companyId, px.id, { actionSource: 'business_messaging' }).catch((e: unknown) => e)
    expect(err instanceof Error || err?.status === 'failed').toBe(true)
    expect(eventsFor(env, px.pixelId)).toHaveLength(before)
  })

  it('AC-T104-05 test_event_code só vai fora de produção', async () => {
    const o = await owner(env)
    const px = await newPixel(env, o)
    await send(capi(env, { testEventCode: 'TEST123', isProduction: false }), o.companyId, px.id)
    await send(capi(env, { testEventCode: 'TEST123', isProduction: true }), o.companyId, px.id)
    const [dev, prod] = eventsFor(env, px.pixelId)
    expect(dev.testEventCode).toBe('TEST123')
    expect(prod.testEventCode ?? null).toBeNull()
  })
})

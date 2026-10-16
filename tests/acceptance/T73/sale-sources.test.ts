// AC-T73-01..05: fontes de venda por webhook genérico — recepção pública (token, HMAC, idempotência por external_id),
// eventos falhos e replay, dry-run do mapeamento, contato/atribuição first×last touch e rotação de token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAPPING,
  RATE_LIMIT_SMALL,
  contactByPhone,
  counts,
  deliver,
  eventRow,
  localPhone,
  newOwner,
  newSource,
  order,
  postSale,
  processAll,
  salesByExternal,
  sign,
  startEnv,
  type Env,
  type User,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const eventsOf = async (sourceId: string) => (await env.q(`SELECT id FROM crm.inbound_sale_events WHERE sale_source_id = $1`, [sourceId])).length

describe('T73 fontes de venda', () => {
  it('AC-T73-01 token inexistente ou fonte inativa → 404 e nada é gravado', async () => {
    const before = await counts(env, owner.companyId)
    const unknown = await postSale(env.app, `tok_${'x'.repeat(40)}`, order())
    expect(unknown.status, unknown.text).toBe(404)

    const src = await newSource(owner)
    expect(src.token).toBeTruthy()
    expect(String(src.public_url)).toMatch(new RegExp(`/api/hooks/sales/${src.token}$`))
    expect(src).not.toHaveProperty('hmac_secret')
    const off = await owner.c.patch(`/api/sale-sources/${src.id}`, { active: false })
    expect(off.status, off.text).toBe(200)
    expect((await postSale(env.app, src.token, order())).status).toBe(404)
    expect(env.jobs).toEqual([])
    expect(await counts(env, owner.companyId)).toEqual(before)
  })

  it('AC-T73-01 HMAC: assinatura certa (com ou sem sha256=) → 202; errada ou ausente → 401 e nada gravado', async () => {
    const secret = `whsec_${Date.now()}`
    const src = await newSource(owner, { hmac_secret: secret })
    expect(src.hmac_configured).toBe(true)
    const listed = await owner.c.get(`/api/sale-sources/${src.id}`)
    expect(listed.text).not.toContain(secret)

    const payload = order()
    const raw = JSON.stringify(payload)
    for (const headers of [{ 'x-signature': sign('outro-segredo', raw) }, {}, { 'x-signature': 'sha256=deadbeef' }]) {
      const res = await postSale(env.app, src.token, raw, headers as Record<string, string>)
      expect(res.status, `${JSON.stringify(headers)} → ${res.text}`).toBe(401)
    }
    expect(await eventsOf(src.id)).toBe(0)
    expect(env.jobs).toEqual([])

    const ok = await postSale(env.app, src.token, raw, { 'x-signature': sign(secret, raw) })
    expect(ok.status, ok.text).toBe(202)
    expect(ok.body).toMatchObject({ ok: true, status: 'pending' })
    expect(env.jobs).toHaveLength(1)
    expect(env.jobs[0]!.opts?.jobId).toBe(`ise-${ok.body.event_id}`)
    expect(env.jobs[0]!.data).toMatchObject({ eventId: ok.body.event_id, saleSourceId: src.id, companyId: owner.companyId })
    const raw2 = JSON.stringify(order())
    const ok2 = await postSale(env.app, src.token, raw2, { 'x-signature': `sha256=${sign(secret, raw2)}` })
    expect(ok2.status, ok2.text).toBe(202)
    await processAll(env)
  })

  it('AC-T73-01 mesmo external_id duas vezes → 1 venda com o status atualizado', async () => {
    const src = await newSource(owner)
    const telefone = localPhone()
    const id = `PED-${Date.now()}`
    const first = await deliver(env, src.token, order({ id, telefone, situacao: 'paid', valor: '149.90' }))
    expect(first.status).toBe('processed')
    let sales = await salesByExternal(env, owner.companyId, id)
    expect(sales).toHaveLength(1)
    expect(sales[0]).toMatchObject({ source: 'webhook', status: 'approved', currency: 'BRL' })
    expect(Number(sales[0].amount_cents)).toBe(14990)
    expect(first.sale_id).toBe(sales[0].id)

    // reentrega idêntica e depois o reembolso do mesmo pedido
    await deliver(env, src.token, order({ id, telefone, situacao: 'paid', valor: '149.90' }))
    const refund = await deliver(env, src.token, order({ id, telefone, situacao: 'Reembolsado', valor: '149.90' }))
    expect(refund.status).toBe('processed')
    sales = await salesByExternal(env, owner.companyId, id)
    expect(sales).toHaveLength(1)
    expect(sales[0].status).toBe('refunded')
    expect(refund.sale_id).toBe(sales[0].id)
  })

  it('AC-T73-01 corpo inválido (400), grande demais (413) e rate limit por token (429) não gravam evento', async () => {
    const src = await newSource(owner)
    expect((await postSale(env.app, src.token, '{nao é json')).status).toBe(400)
    const big = JSON.stringify({ ...order(), lixo: 'x'.repeat(260 * 1024) })
    expect((await postSale(env.app, src.token, big)).status).toBe(413)
    expect(await eventsOf(src.id)).toBe(0)

    // fonte própria para o rate limit (o contador é por token e compartilhado entre instâncias)
    const rl = await newSource(owner)
    const statuses: number[] = []
    for (let i = 0; i < RATE_LIMIT_SMALL + 2; i++) statuses.push((await postSale(env.appRl, rl.token, order())).status)
    expect(statuses.slice(0, RATE_LIMIT_SMALL)).toEqual(Array(RATE_LIMIT_SMALL).fill(202))
    expect(statuses.slice(RATE_LIMIT_SMALL)).toEqual([429, 429])
    expect(await eventsOf(rl.id)).toBe(RATE_LIMIT_SMALL)
    await processAll(env)
  })

  it('AC-T73-02 payload que o mapeamento não resolve vira evento failed com o caminho que faltou', async () => {
    const src = await newSource(owner)
    const before = await counts(env, owner.companyId)
    const ev = await deliver(env, src.token, order({ telefone: null }))
    expect(ev.status).toBe('failed')
    expect(ev.error).toBe(`missing_path:${MAPPING.phone}`)
    expect(ev.missing).toEqual(expect.arrayContaining([{ field: 'phone', path: MAPPING.phone }]))
    expect(ev.sale_id).toBeNull()
    const after = await counts(env, owner.companyId)
    expect(after.sales).toBe(before.sales)
    expect(after.contacts).toBe(before.contacts)

    const list = await owner.c.get(`/api/sale-sources/${src.id}/events?status=failed`)
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.map((i: Any) => i.id)).toContain(ev.id)
    expect(list.body.items.find((i: Any) => i.id === ev.id)).toMatchObject({ status: 'failed', error: `missing_path:${MAPPING.phone}` })
  })

  it('AC-T73-02 replay reprocessa depois de corrigir o mapeamento', async () => {
    const src = await newSource(owner)
    const telefone = localPhone()
    // o checkout manda o telefone em outro lugar
    const payload = { ...order({ telefone: null }), contato: { celular: telefone } }
    const ev = await deliver(env, src.token, payload)
    expect(ev.status).toBe('failed')

    const fix = await owner.c.patch(`/api/sale-sources/${src.id}`, { mapping: { ...MAPPING, phone: '$.contato.celular' } })
    expect(fix.status, fix.text).toBe(200)
    const replay = await owner.c.post(`/api/sale-sources/${src.id}/events/${ev.id}/replay`)
    expect(replay.status, replay.text).toBe(202)
    expect(replay.body.event).toMatchObject({ id: ev.id, status: 'pending' })
    expect(env.jobs).toHaveLength(1)
    expect(String(env.jobs[0]!.opts?.jobId)).toMatch(new RegExp(`^ise-${ev.id}`))
    await processAll(env)

    const again = await eventRow(env, ev.id)
    expect(again.status).toBe('processed')
    expect(again.error).toBeNull()
    const sales = await salesByExternal(env, owner.companyId, payload.pedido.id)
    expect(sales).toHaveLength(1)
    expect(again.sale_id).toBe(sales[0].id)
    expect(await contactByPhone(env, owner.companyId, telefone)).toBeTruthy()
  })

  it('AC-T73-03 test devolve o SaleEvent de uma amostra colada sem gravar nada', async () => {
    const src = await newSource(owner, { status_map: { concluido: 'approved' } })
    const before = await counts(env, owner.companyId)
    const telefone = localPhone()
    const sample = order({ id: 'PED-AMOSTRA', telefone: `(${telefone.slice(0, 2)}) ${telefone.slice(2, 7)}-${telefone.slice(7)}`, situacao: 'CONCLUIDO', valor: '1234.56', utm: { utm_source: 'facebook', ctwa_clid: 'clid-1', ad_id: '120200' } })
    const res = await owner.c.post(`/api/sale-sources/${src.id}/test`, { sample })
    expect(res.status, res.text).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.event).toMatchObject({
      external_id: 'PED-AMOSTRA',
      status: 'approved',
      amount_cents: 123456,
      currency: 'BRL',
      customer: { phone: `+55${telefone}`, name: 'Maria Compradora' },
      attribution: { utm_source: 'facebook', ctwa_clid: 'clid-1', source_id: '120200', utm_medium: null },
    })

    // mapeamento no corpo sobrepõe o salvo; faltando campo → ok:false com o caminho
    const missing = await owner.c.post(`/api/sale-sources/${src.id}/test`, { sample, mapping: { ...MAPPING, external_id: '$.nao.existe' } })
    expect(missing.status, missing.text).toBe(200)
    expect(missing.body.ok).toBe(false)
    expect(missing.body.missing).toEqual(expect.arrayContaining([{ field: 'external_id', path: '$.nao.existe' }]))

    // sem fonte salva (sem o status_map da fonte: status padrão "paid")
    const bare = await owner.c.post('/api/sale-sources/test', { sample: { ...sample, pedido: { ...sample.pedido, situacao: 'paid', valor: 123456 } }, mapping: MAPPING, amount_unit: 'cents' })
    expect(bare.status, bare.text).toBe(200)
    expect(bare.body, bare.text).toMatchObject({ ok: true, event: { external_id: 'PED-AMOSTRA', amount_cents: 123456 } })

    expect(await counts(env, owner.companyId)).toEqual(before)
    expect(env.jobs).toEqual([])
    expect(await contactByPhone(env, owner.companyId, telefone)).toBeUndefined()
  })

  it('AC-T73-04 venda cria o contato pelo telefone (consent_source sale) ou encontra o existente', async () => {
    const src = await newSource(owner)
    const novo = localPhone()
    const ev = await deliver(env, src.token, order({ telefone: novo, nome: 'Lead Novo' }))
    expect(ev.status).toBe('processed')
    const created = await contactByPhone(env, owner.companyId, novo)
    expect(created).toMatchObject({ name: 'Lead Novo', consent_source: 'sale' })
    expect(ev.contact_id).toBe(created.id)

    const existente = localPhone()
    const [pre] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Já Existia', $2) RETURNING id`, [owner.companyId, `+55${existente}`])
    const before = (await counts(env, owner.companyId)).contacts
    const ev2 = await deliver(env, src.token, order({ telefone: `+55 ${existente}`, nome: 'Outro Nome' }))
    expect(ev2.status).toBe('processed')
    expect(ev2.contact_id).toBe(pre.id)
    expect((await counts(env, owner.companyId)).contacts).toBe(before)
    const [sale] = await env.q(`SELECT contact_id FROM crm.sales WHERE id = $1`, [ev2.sale_id])
    expect(sale.contact_id).toBe(pre.id)
  })

  it('AC-T73-04 a venda herda a atribuição; first touch nunca é sobrescrito, last touch sim', async () => {
    const src = await newSource(owner)
    const telefone = localPhone()
    const e1 = await deliver(env, src.token, order({ telefone, utm: { utm_source: 'facebook', utm_campaign: 'black-friday', ctwa_clid: 'clid-AAA', ad_id: 'ad-111' } }))
    expect(e1.status).toBe('processed')
    const contact = await contactByPhone(env, owner.companyId, telefone)
    const [s1] = await env.q(`SELECT source_id FROM crm.sales WHERE id = $1`, [e1.sale_id])
    expect(s1.source_id).toBe('ad-111')

    const read = async () => {
      const res = await owner.c.get(`/api/contacts/${contact.id}/attribution`)
      expect(res.status, res.text).toBe(200)
      return res.body.attribution
    }
    let att = await read()
    expect(att.first_touch).toMatchObject({ utm_source: 'facebook', utm_campaign: 'black-friday', ctwa_clid: 'clid-AAA', source_id: 'ad-111' })
    expect(att.last_touch).toMatchObject({ utm_source: 'facebook', ctwa_clid: 'clid-AAA' })

    const e2 = await deliver(env, src.token, order({ telefone, utm: { utm_source: 'google', utm_medium: 'cpc', ad_id: 'ad-222' } }))
    expect(e2.status).toBe('processed')
    att = await read()
    expect(att.first_touch).toMatchObject({ utm_source: 'facebook', utm_campaign: 'black-friday', ctwa_clid: 'clid-AAA', source_id: 'ad-111' })
    expect(att.last_touch).toMatchObject({ utm_source: 'google', utm_medium: 'cpc', source_id: 'ad-222' })
    const [s2] = await env.q(`SELECT source_id FROM crm.sales WHERE id = $1`, [e2.sale_id])
    expect(s2.source_id).toBe('ad-222')

    // evento sem atribuição não mexe em nenhum dos dois
    await deliver(env, src.token, order({ telefone }))
    const after = await read()
    expect(after.first_touch).toMatchObject({ utm_source: 'facebook' })
    expect(after.last_touch).toMatchObject({ utm_source: 'google' })

    // contato sem nenhum touch → attribution null
    const semTouch = localPhone()
    const e3 = await deliver(env, src.token, order({ telefone: semTouch }))
    const none = await owner.c.get(`/api/contacts/${e3.contact_id}/attribution`)
    expect(none.status, none.text).toBe(200)
    expect(none.body.attribution).toBeNull()
  })

  it('AC-T73-05 rotacionar o token invalida a URL antiga (404) e a nova recebe', async () => {
    const src = await newSource(owner)
    expect((await postSale(env.app, src.token, order())).status).toBe(202)
    const rot = await owner.c.post(`/api/sale-sources/${src.id}/rotate-token`)
    expect(rot.status, rot.text).toBe(200)
    const fresh = rot.body.sale_source
    expect(fresh.token).toBeTruthy()
    expect(fresh.token).not.toBe(src.token)
    expect(String(fresh.public_url)).toMatch(new RegExp(`/api/hooks/sales/${fresh.token}$`))
    expect((await postSale(env.app, src.token, order())).status).toBe(404)
    expect((await postSale(env.app, fresh.token, order())).status).toBe(202)
    await processAll(env)
  })

  it('AC-T73-05 o token da fonte (antigo e novo) não aparece no log de acesso', async () => {
    const src = await newSource(owner)
    const before = env.logs.length
    expect((await postSale(env.app, src.token, order())).status).toBe(202)
    const rot = await owner.c.post(`/api/sale-sources/${src.id}/rotate-token`)
    const fresh = rot.body.sale_source.token
    expect((await postSale(env.app, src.token, order())).status).toBe(404)
    expect((await postSale(env.app, fresh, order())).status).toBe(202)
    await processAll(env)
    const lines = env.logs.slice(before)
    expect(lines.filter((l) => l.includes(src.token) || l.includes(fresh))).toEqual([])
    const access = lines.map((l) => JSON.parse(l)).filter((l: Any) => typeof l.path === 'string' && l.path.startsWith('/api/hooks/sales'))
    expect(access.length).toBeGreaterThanOrEqual(3)
    for (const l of access) expect(l.path).toBe('/api/hooks/sales/***')
  })
})

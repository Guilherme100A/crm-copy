// AC-T113-01..04 com o sistema montado como produção + FakeUtmify (ver setup.ts). Nunca a UTMify real.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createIntegration,
  newContact,
  newOwner,
  newProduct,
  RETRY_BASE_MS,
  runSale,
  saleFlow,
  sleep,
  sse,
  startSystem,
  touch,
  utmifyOf,
  waitFor,
  watchRequests,
  type Owner,
  type System,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const TOKEN_A = `utmA_${randomBytes(12).toString('hex')}`
const TOKEN_B = `utmB_${randomBytes(12).toString('hex')}`

let sys: System

beforeAll(async () => {
  sys = await startSystem([TOKEN_A, TOKEN_B])
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

beforeEach(() => sys.fake.reset())

// SSE: envelope { type, data, ... } (SPEC 3.7)
const payload = (m: Any) => {
  const e = JSON.parse(m.data)
  return e?.data ?? e
}
const callsOf = (saleId: string) => sys.fake.requests.filter((r: Any) => r.body?.orderId === saleId)
const eventOf = (u: Any, saleStatus: string) => (u.events ?? []).find((e: Any) => e.sale_status === saleStatus)
/** Espera o envio de `saleStatus` sair de pending (succeeded/failed). */
const settled = (o: Owner, saleId: string, saleStatus = 'approved', ms = 60_000) =>
  waitFor(async () => {
    const u = await utmifyOf(o, saleId)
    const e = eventOf(u, saleStatus)
    return e && e.status !== 'pending' ? { u, e } : undefined
  }, ms, `envio UTMify (${saleStatus}) da venda ${saleId} concluir`)

async function scenario(token?: string, extra: Record<string, unknown> = {}) {
  const o = await newOwner(sys)
  const integration = await createIntegration(o, 'Loja Exemplo', token)
  const product = await newProduct(o)
  const flowId = await saleFlow(o, product.public_id, integration.id, extra)
  return { o, integration, product, flowId }
}

describe('T113 — envio da venda aprovada à UTMify', () => {
  it('AC-T113-01 venda aprovada com utmify_integration_id envia 1 pedido ao fake com valor, moeda, produto, cliente e os utm_* (último toque) do contato', async () => {
    const { o, integration, product, flowId } = await scenario(TOKEN_A, { currency_template: 'USD' })
    const conn = await sse(sys, o)
    try {
      const contact = await newContact(o, { email: `cli-${randomBytes(3).toString('hex')}@exemplo.com` })
      const t0 = Date.now() - 60_000
      await touch(sys, o, contact.id, { utm_source: 'first-src', utm_medium: 'first-med', utm_campaign: 'first-camp', utm_content: 'first-cont', utm_term: 'first-term' }, new Date(t0))
      await touch(sys, o, contact.id, { utm_source: 'fb', utm_medium: 'cpc', utm_campaign: 'black-friday', utm_content: 'video-1', utm_term: 'curso', source_id: 'ad-123', ctwa_clid: 'clid-xyz' }, new Date(t0 + 30_000))
      const saleId = await runSale(sys, o, flowId, contact.id)

      const { u, e } = await settled(o, saleId)
      expect(e.status).toBe('succeeded')
      expect(e.attempts).toBe(1)
      expect(e.last_error ?? null).toBeNull()
      expect(u.utmify_status).toBe('succeeded')
      expect(u.utmify_integration_id).toBe(integration.id)

      const orders = sys.fake.ordersOf(saleId)
      expect(orders, 'exatamente um pedido aceito pelo fake').toHaveLength(1)
      const [order] = orders
      expect(order.token, 'enviado com o token da integração').toBe(TOKEN_A)
      expect(order.status).toBe('paid')
      const body = order.body
      // valor e moeda
      expect(body.commission.totalPriceInCents).toBe(25_000)
      expect(body.commission.currency).toBe('USD')
      // produto
      expect(body.products).toHaveLength(1)
      expect(body.products[0].name).toBe(product.name)
      expect(body.products[0].priceInCents).toBe(25_000)
      // cliente
      expect(body.customer.name).toBe(contact.name)
      expect(body.customer.email).toBe(contact.email)
      // utm_* do contato: último toque (decisão do Orquestrador), e a origem do anúncio / clique CTWA
      expect(body.trackingParameters).toMatchObject({ utm_source: 'fb', utm_medium: 'cpc', utm_campaign: 'black-friday', utm_content: 'video-1', utm_term: 'curso' })
      expect(JSON.stringify(body.trackingParameters)).toContain('ad-123')
      expect(JSON.stringify(body.trackingParameters)).toContain('clid-xyz')
      expect(JSON.stringify(body)).not.toContain('first-src')

      // sale.updated pelo SSE da empresa: passa por pending e termina em succeeded.
      await conn.waitFor((m) => m.event === 'sale.updated' && payload(m)?.sale_id === saleId && payload(m)?.utmify_status === 'succeeded', 30_000)
      const states = conn.events('sale.updated').map(payload).filter((d: Any) => d.sale_id === saleId && d.utmify_status !== undefined).map((d: Any) => d.utmify_status)
      expect(states).toContain('pending')
      expect(states.indexOf('pending')).toBeLessThan(states.lastIndexOf('succeeded'))

      // Lista por venda (consumida pela T114) concorda.
      const list = await o.c.get(`/api/sale-utmify?sale_ids=${saleId}`)
      expect(list.status, list.text).toBe(200)
      expect(list.body.items).toHaveLength(1)
      expect(list.body.items[0]).toMatchObject({ sale_id: saleId, utmify_status: 'succeeded' })

      // Não envia de novo sozinha.
      await sleep(2000)
      expect(callsOf(saleId)).toHaveLength(1)
    } finally {
      await conn.close()
    }
  })

  it('AC-T113-01 contato sem atribuição: o envio segue com utm_* nulos (moeda BRL)', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const contact = await newContact(o)
    const saleId = await runSale(sys, o, flowId, contact.id)
    const { e } = await settled(o, saleId)
    expect(e.status).toBe('succeeded')
    const [order] = sys.fake.ordersOf(saleId)
    expect(order.body.commission.totalPriceInCents).toBe(25_000)
    expect(order.body.commission.currency ?? 'BRL').toBe('BRL')
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) expect(order.body.trackingParameters?.[k] ?? null).toBeNull()
  })

  it('AC-T113-01 sem utmify_integration_id ("Não enviar para UTMify") nada é enviado', async () => {
    const o = await newOwner(sys)
    await createIntegration(o, 'Loja Exemplo', TOKEN_A)
    const product = await newProduct(o)
    const before = sys.fake.requests.length

    const flowId = await saleFlow(o, product.public_id, null)
    const fromFlow = await runSale(sys, o, flowId, (await newContact(o)).id)
    const r = await o.c.post('/api/sales', { amount_cents: 9_900, currency: 'BRL', contact_id: (await newContact(o)).id, external_id: `ext-${randomBytes(3).toString('hex')}`, status: 'approved' })
    expect(r.status, r.text).toBe(201)
    const fromApi = r.body.sale.id
    // reembolso de venda sem integração também não envia
    expect((await o.c.patch(`/api/sales/${fromApi}`, { status: 'refunded' })).status).toBe(200)

    await sleep(4000)
    expect(sys.fake.requests.length, 'nenhuma chamada à UTMify').toBe(before)
    for (const id of [fromFlow, fromApi]) {
      const u = await utmifyOf(o, id)
      expect(u.utmify_status ?? null).toBeNull()
      expect(u.utmify_integration_id ?? null).toBeNull()
      expect(u.events).toEqual([])
    }
  })

  it('AC-T113-01 integração sem token: failed "Integração UTMify não configurada" sem chamar o fake; o seletor só lista as configuradas', async () => {
    const { o, integration, flowId } = await scenario(undefined)
    expect(integration.token_configured).toBe(false)
    const ok = await createIntegration(o, 'Com Token', TOKEN_B)
    const sel = await o.c.get('/api/utmify-integrations?configured=1')
    expect(sel.status, sel.text).toBe(200)
    expect(sel.body.utmify_integrations.map((i: Any) => i.id)).toEqual([ok.id])
    const all = await o.c.get('/api/utmify-integrations')
    expect(all.body.utmify_integrations).toHaveLength(2)

    const before = sys.fake.requests.length
    const saleId = await runSale(sys, o, flowId, (await newContact(o)).id)
    const { u, e } = await settled(o, saleId)
    expect(e.status).toBe('failed')
    expect(String(e.last_error)).toMatch(/Integração UTMify não configurada/i)
    expect(u.utmify_status).toBe('failed')
    expect(sys.fake.requests.length).toBe(before)
  })
})

describe('T113 — reembolso e idempotência', () => {
  it('AC-T113-02 reembolso (PATCH status refunded) envia a atualização do mesmo pedido; repetir não reenvia nada', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const conn = await sse(sys, o)
    try {
      const contact = await newContact(o)
      await touch(sys, o, contact.id, { utm_source: 'ig', utm_campaign: 'refund-camp' }, new Date())
      const saleId = await runSale(sys, o, flowId, contact.id)
      expect((await settled(o, saleId)).e.status).toBe('succeeded')

      const r = await o.c.patch(`/api/sales/${saleId}`, { status: 'refunded' })
      expect(r.status, r.text).toBe(200)
      expect(r.body.sale.status).toBe('refunded')

      const { u, e } = await settled(o, saleId, 'refunded')
      expect(e.status).toBe('succeeded')
      expect(e.attempts).toBe(1)
      expect(u.utmify_status).toBe('succeeded')
      expect(u.events.map((x: Any) => x.sale_status)).toEqual(['approved', 'refunded'])

      const orders = sys.fake.ordersOf(saleId)
      expect(orders.map((x: Any) => x.status)).toEqual(['paid', 'refunded'])
      const [paid, refunded] = orders
      expect(refunded.body.orderId).toBe(paid.body.orderId)
      expect(refunded.body.createdAt, 'mesmo createdAt do pedido').toBe(paid.body.createdAt)
      expect(refunded.body.refundedAt).toBeTruthy()
      expect(refunded.body.commission.totalPriceInCents).toBe(25_000)
      expect(refunded.body.trackingParameters).toMatchObject({ utm_source: 'ig', utm_campaign: 'refund-camp' })

      // SSE: a transição de status da venda e o estado do envio do reembolso.
      await conn.waitFor((m) => m.event === 'sale.updated' && payload(m)?.sale_id === saleId && payload(m)?.status === 'refunded', 15_000)

      // Idempotência por venda + status: repetir o reembolso, voltar a aprovada e reembolsar de novo não reenvia.
      expect((await o.c.patch(`/api/sales/${saleId}`, { status: 'refunded' })).status).toBe(200)
      expect((await o.c.patch(`/api/sales/${saleId}`, { status: 'approved' })).status).toBe(200)
      expect((await o.c.patch(`/api/sales/${saleId}`, { status: 'refunded' })).status).toBe(200)
      await sleep(4000)
      expect(callsOf(saleId), 'cada evento (venda + status) sai uma única vez').toHaveLength(2)
      const after = await utmifyOf(o, saleId)
      expect(after.events).toHaveLength(2)
      const rows = await sys.q(`SELECT sale_status FROM crm.sale_utmify_events WHERE sale_id = $1`, [saleId])
      expect(rows.map((x: Any) => x.sale_status).sort()).toEqual(['approved', 'refunded'])
    } finally {
      await conn.close()
    }
  })

  it('AC-T113-02 o mesmo job reenfileirado (approved/refunded) não gera segundo envio', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const saleId = await runSale(sys, o, flowId, (await newContact(o)).id)
    expect((await settled(o, saleId)).e.status).toBe('succeeded')
    // Reentrega do job pela fila de produção (ex.: o BullMQ entregou de novo / outro gatilho com o mesmo status).
    const core: Any = sys.core
    const q = core.defineQueue(core.UTMIFY_QUEUE, { defaultJobOptions: core.UTMIFY_JOB_OPTIONS })
    try {
      await q.add(core.UTMIFY_QUEUE, { companyId: o.companyId, saleId, status: 'approved' }, { jobId: `utmify-${saleId}-approved-again` })
      await sleep(3000)
      expect(callsOf(saleId)).toHaveLength(1)
    } finally {
      await q.close()
    }
  })
})

describe('T113 — falhas da UTMify', () => {
  it('AC-T113-03 erro do fake → novas tentativas com backoff crescente e depois sucesso (no máximo 3 chamadas)', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    sys.fake.failNext(500, { message: 'Instabilidade temporária' }, 2)
    const contactId = (await newContact(o)).id
    const watch = watchRequests(sys.fake, () => true)
    try {
      const saleId = await runSale(sys, o, flowId, contactId)
      const { e } = await settled(o, saleId)
      expect(e.status).toBe('succeeded')
      expect(e.attempts).toBe(3)
      expect(callsOf(saleId)).toHaveLength(3)
      expect(sys.fake.ordersOf(saleId)).toHaveLength(1)
      watch.stop()
      const [t1, t2, t3] = watch.at
      expect(watch.at).toHaveLength(3)
      // backoff: 1ª→2ª ≥ base, 2ª→3ª ≥ 2×base (folga para o polling de 10 ms)
      expect(t2! - t1!).toBeGreaterThanOrEqual(RETRY_BASE_MS * 0.9)
      expect(t3! - t2!).toBeGreaterThanOrEqual(RETRY_BASE_MS * 2 * 0.9)
    } finally {
      watch.stop()
    }
  })

  it('AC-T113-03 erro persistente → exatamente 3 chamadas e falha visível na venda (GET, lista e SSE)', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const conn = await sse(sys, o)
    try {
      sys.fake.failAlways(500, { message: 'Serviço indisponível XYZ' })
      const saleId = await runSale(sys, o, flowId, (await newContact(o)).id)
      const { u, e } = await settled(o, saleId)
      expect(e.status).toBe('failed')
      expect(e.attempts).toBe(3)
      expect(String(e.last_error)).toContain('Serviço indisponível XYZ')
      expect(u.utmify_status).toBe('failed')
      expect(String(u.utmify_last_error)).toContain('Serviço indisponível XYZ')

      const list = await o.c.get(`/api/sale-utmify?sale_ids=${saleId}`)
      expect(list.status, list.text).toBe(200)
      expect(list.body.items[0]).toMatchObject({ sale_id: saleId, utmify_status: 'failed' })
      expect(String(list.body.items[0].utmify_last_error)).toContain('Serviço indisponível XYZ')

      const ev = await conn.waitFor((m) => m.event === 'sale.updated' && payload(m)?.sale_id === saleId && payload(m)?.utmify_status === 'failed', 15_000)
      expect(String(payload(ev).utmify_last_error)).toContain('Serviço indisponível XYZ')

      await sleep(RETRY_BASE_MS * 8)
      expect(callsOf(saleId), 'mais de 3 chamadas à UTMify').toHaveLength(3)
      expect(sys.fake.ordersOf(saleId)).toHaveLength(0)
    } finally {
      await conn.close()
    }
  })

  it('AC-T113-03 falha no envio do reembolso também fica registrada na venda, sem afetar a aprovação já enviada', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const saleId = await runSale(sys, o, flowId, (await newContact(o)).id)
    expect((await settled(o, saleId)).e.status).toBe('succeeded')
    sys.fake.failAlways(503, { message: 'Fora do ar' })
    expect((await o.c.patch(`/api/sales/${saleId}`, { status: 'refunded' })).status).toBe(200)
    const { u, e } = await settled(o, saleId, 'refunded')
    expect(e.status).toBe('failed')
    expect(e.attempts).toBe(3)
    expect(String(e.last_error)).toContain('Fora do ar')
    expect(u.utmify_status).toBe('failed')
    expect(eventOf(u, 'approved').status).toBe('succeeded')
  })

  it('AC-T113-03 status UTMify de venda de outra empresa → 404', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    const saleId = await runSale(sys, o, flowId, (await newContact(o)).id)
    const stranger = await newOwner(sys)
    const r = await stranger.c.get(`/api/sales/${saleId}/utmify`)
    expect(r.status, r.text).toBe(404)
    const l = await stranger.c.get(`/api/sale-utmify?sale_ids=${saleId}`)
    expect(l.status, l.text).toBe(200)
    expect(l.body.items).toEqual([])
  })
})

describe('T113 — token só de escrita e CRUD', () => {
  it('AC-T113-04 o token nunca volta nas respostas da API, no erro gravado, nem nos logs, e fica cifrado no banco', async () => {
    const o = await newOwner(sys)
    const secret = `utmS_${randomBytes(12).toString('hex')}`
    sys.fake.addToken(secret)
    const bodies: string[] = []
    const keep = (r: Any) => (bodies.push(r.text ?? JSON.stringify(r.body)), r)

    const created = keep(await o.c.post('/api/utmify-integrations', { utmify_integration: { company_name: 'Loja Segredo', integration_token: secret } }))
    expect(created.status, created.text).toBe(201)
    const integ = created.body.utmify_integration
    expect(integ.token_configured).toBe(true)
    expect(integ.company_name).toBe('Loja Segredo')
    expect(integ).not.toHaveProperty('integration_token')
    keep(await o.c.get('/api/utmify-integrations'))
    keep(await o.c.get('/api/utmify-integrations?configured=1'))
    keep(await o.c.get(`/api/utmify-integrations/${integ.id}`))
    keep(await o.c.get(`/api/utmify-integrations/${integ.id}/usage`))
    // PUT com token em branco mantém; validação não ecoa o token
    const blank = keep(await o.c.put(`/api/utmify-integrations/${integ.id}`, { utmify_integration: { company_name: 'Loja Segredo 2', integration_token: '' } }))
    expect(blank.status, blank.text).toBe(200)
    expect(blank.body.utmify_integration.token_configured).toBe(true)
    expect(blank.body.utmify_integration.company_name).toBe('Loja Segredo 2')
    const bad = keep(await o.c.post('/api/utmify-integrations', { utmify_integration: { company_name: 'x', integration_token: secret } }))
    expect(bad.status, bad.text).toBe(422)
    const badPut = keep(await o.c.put(`/api/utmify-integrations/${integ.id}`, { utmify_integration: { company_name: 'y', integration_token: secret } }))
    expect(badPut.status, badPut.text).toBe(422)

    // Envio com esse token: a UTMify devolve um erro que ECOA o token (pior caso) → o erro gravado não o expõe.
    const product = await newProduct(o)
    const flowId = await saleFlow(o, product.public_id, integ.id)
    sys.fake.failAlways(500, { message: `credencial ${secret} recusada` })
    const failedSale = await runSale(sys, o, flowId, (await newContact(o)).id)
    const failed = await settled(o, failedSale)
    expect(failed.e.status).toBe('failed')
    expect(callsOf(failedSale)[0].token, 'o envio usou o token guardado').toBe(secret)
    bodies.push(JSON.stringify(failed.u))
    keep(await o.c.get(`/api/sale-utmify?sale_ids=${failedSale}`))
    sys.fake.reset()

    const okSale = await runSale(sys, o, flowId, (await newContact(o)).id)
    const ok = await settled(o, okSale)
    expect(ok.e.status).toBe('succeeded')
    expect(sys.fake.ordersOf(okSale)[0].token).toBe(secret)
    bodies.push(JSON.stringify(ok.u))

    for (const b of bodies) expect(b).not.toContain(secret)
    expect(sys.logs.length).toBeGreaterThan(0)
    expect(sys.logs.join('\n'), 'token em log').not.toContain(secret)
    const rows = await sys.q(`SELECT row_to_json(t)::text AS j FROM crm.utmify_integrations t WHERE t.id = $1`, [integ.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].j, 'token em claro na tabela').not.toContain(secret)
    const ev = await sys.q(`SELECT row_to_json(t)::text AS j FROM crm.sale_utmify_events t WHERE t.sale_id = $1`, [failedSale])
    expect(ev[0].j).not.toContain(secret)
    // auditoria também não leva o token
    const audit = await sys.q(`SELECT row_to_json(t)::text AS j FROM crm.audit_logs t WHERE t.company_id = $1`, [o.companyId]).catch(() => [])
    for (const a of audit) expect(a.j).not.toContain(secret)

    // trocar o token: o próximo envio usa o novo
    const newSecret = `utmN_${randomBytes(12).toString('hex')}`
    sys.fake.addToken(newSecret)
    const rot = keep(await o.c.put(`/api/utmify-integrations/${integ.id}`, { utmify_integration: { integration_token: newSecret } }))
    expect(rot.status, rot.text).toBe(200)
    expect(rot.text).not.toContain(newSecret)
    const rotSale = await runSale(sys, o, flowId, (await newContact(o)).id)
    expect((await settled(o, rotSale)).e.status).toBe('succeeded')
    expect(sys.fake.ordersOf(rotSale)[0].token).toBe(newSecret)
    expect(sys.logs.join('\n')).not.toContain(newSecret)
  })

  it('AC-T113-04 CRUD: listagem no formato do legado, isolamento por empresa e exclusão com aviso quando em uso', async () => {
    const o = await newOwner(sys)
    const used = await createIntegration(o, 'Em uso', TOKEN_A)
    const free = await createIntegration(o, 'Livre', TOKEN_B)
    for (const k of ['id', 'company_name', 'token_configured', 'created_at', 'updated_at']) expect(used).toHaveProperty(k)
    const product = await newProduct(o)
    const flowId = await saleFlow(o, product.public_id, used.id)

    const stranger = await newOwner(sys)
    expect((await stranger.c.get(`/api/utmify-integrations/${used.id}`)).status).toBe(404)
    expect((await stranger.c.put(`/api/utmify-integrations/${used.id}`, { utmify_integration: { company_name: 'Hack' } })).status).toBe(404)
    expect((await stranger.c.delete(`/api/utmify-integrations/${used.id}?force=1`)).status).toBe(404)
    expect((await stranger.c.get('/api/utmify-integrations')).body).toEqual({ utmify_integrations: [] })

    const usage = await o.c.get(`/api/utmify-integrations/${used.id}/usage`)
    expect(usage.status, usage.text).toBe(200)
    expect(usage.body.in_use).toBe(true)
    expect(JSON.stringify(usage.body.flows)).toContain(flowId)

    const del = await o.c.delete(`/api/utmify-integrations/${used.id}`)
    expect(del.status, del.text).toBe(409)
    expect(del.text).toContain(flowId)
    expect((await o.c.get(`/api/utmify-integrations/${used.id}`)).status, 'não excluiu sem confirmação').toBe(200)
    const forced = await o.c.delete(`/api/utmify-integrations/${used.id}?force=1`)
    expect(forced.status, forced.text).toBe(200)
    expect((await o.c.get(`/api/utmify-integrations/${used.id}`)).status).toBe(404)

    expect((await o.c.delete(`/api/utmify-integrations/${free.id}`)).status).toBe(200)
    expect((await o.c.get('/api/utmify-integrations')).body).toEqual({ utmify_integrations: [] })
  })
})

// AC-T112-01..04 com o sistema montado como produção + FakeNotasy (ver setup.ts). Nunca a Notasy real.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createIssuer,
  invoiceOf,
  newContact,
  newOwner,
  newProduct,
  RETRY_BASE_MS,
  runSale,
  saleFlow,
  sleep,
  sse,
  startSystem,
  waitFor,
  watchRequests,
  type Owner,
  type System,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const TOKEN_A = `ntsyA_${randomBytes(12).toString('hex')}`
const TOKEN_B = `ntsyB_${randomBytes(12).toString('hex')}`
const TOKEN_X = `ntsyX_${randomBytes(12).toString('hex')}`

let sys: System

beforeAll(async () => {
  sys = await startSystem([TOKEN_A, TOKEN_B, TOKEN_X])
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
const forSale = (saleId: string) => (r: Any) => r.body?.id === saleId
const salesAt = (saleId: string) => sys.fake.sales.filter((s: Any) => s.body?.id === saleId)
const settled = (o: Owner, saleId: string, ms = 60_000) =>
  waitFor(async () => {
    const inv = await invoiceOf(o, saleId)
    return inv && inv.invoice_emit_status && inv.invoice_emit_status !== 'pending' ? inv : undefined
  }, ms, `emissão da venda ${saleId} concluir`)

async function scenario(issuerToken?: string) {
  const o = await newOwner(sys)
  const issuer = await createIssuer(o, 'Loja Exemplo', issuerToken)
  const product = await newProduct(o)
  const flowId = await saleFlow(o, product.public_id, issuer.id)
  return { o, issuer, product, flowId }
}

describe('T112 — emissão de NF na venda aprovada', () => {
  it('AC-T112-01 venda aprovada com note_issuer_id enfileira a emissão; status pending → succeeded com sale.updated', async () => {
    const { o, issuer, product, flowId } = await scenario(TOKEN_A)
    const conn = await sse(sys, o)
    try {
      const contactId = await newContact(o)
      const saleId = await runSale(sys, o, flowId, contactId)

      const ok = await settled(o, saleId)
      expect(ok.invoice_emit_status).toBe('succeeded')
      expect(ok.invoice_integration_id).toBe(issuer.id)
      expect(ok.sale_id).toBe(saleId)
      expect(ok.invoice_last_error ?? null).toBeNull()
      expect(ok.attempts).toBe(1)
      expect(ok.can_reemit).toBe(false)
      expect(ok.external_id, 'id devolvido pela Notasy').toBe(salesAt(saleId)[0]?.id)

      // O fake recebeu exatamente uma emissão desta venda, no endpoint do token do emissor, com os dados da venda.
      const got = salesAt(saleId)
      expect(got).toHaveLength(1)
      expect(got[0].token).toBe(TOKEN_A)
      expect(got[0].body.total).toBe(25_000)
      expect(JSON.stringify(got[0].body)).toContain(product.name)

      // Eventos sale.updated pelo SSE da empresa: passa por pending e termina em succeeded.
      const done = await conn.waitFor((m) => m.event === 'sale.updated' && payload(m)?.sale_id === saleId && payload(m)?.invoice_emit_status === 'succeeded', 30_000)
      const updates = conn.events('sale.updated').map(payload).filter((d: Any) => d.sale_id === saleId)
      const states = updates.map((d: Any) => d.invoice_emit_status)
      expect(states).toContain('pending')
      expect(states.indexOf('pending')).toBeLessThan(states.lastIndexOf('succeeded'))
      expect(payload(done).sale_id).toBe(saleId)

      // Lista de status por venda (consumida pela T114) concorda.
      const list = await o.c.get(`/api/sale-invoices?sale_ids=${saleId}`)
      expect(list.status, list.text).toBe(200)
      expect(JSON.stringify(list.body)).toContain('succeeded')

      // Não emite de novo sozinha.
      await sleep(2000)
      expect(salesAt(saleId)).toHaveLength(1)
    } finally {
      await conn.close()
    }
  })

  it('AC-T112-02 venda sem note_issuer_id não emite (status nulo "Sem emissor")', async () => {
    const o = await newOwner(sys)
    await createIssuer(o, 'Loja Exemplo', TOKEN_A)
    const product = await newProduct(o)
    const before = sys.fake.requests.length

    // Pelo bloco Venda aprovada sem emissor…
    const flowId = await saleFlow(o, product.public_id, null)
    const fromFlow = await runSale(sys, o, flowId, await newContact(o))
    // …e pela API de vendas (que não aceita note_issuer_id).
    const r = await o.c.post('/api/sales', { amount_cents: 9_900, currency: 'BRL', contact_id: await newContact(o), external_id: `ext-${randomBytes(3).toString('hex')}`, status: 'approved' })
    expect(r.status, r.text).toBe(201)
    const fromApi = r.body.sale.id

    await sleep(4000)
    expect(sys.fake.requests.length, 'nenhuma chamada ao emissor').toBe(before)
    for (const id of [fromFlow, fromApi]) {
      const res = await o.c.get(`/api/sales/${id}/invoice`)
      expect(res.status, res.text).toBe(200)
      expect(res.body.invoice?.invoice_emit_status ?? null).toBeNull()
    }
  })

  it('AC-T112-02 emissor sem token configurado → failed "Emissor não configurado", sem chamar o fake', async () => {
    const { o, issuer, flowId } = await scenario(undefined)
    expect(issuer.token_configured).toBe(false)
    const before = sys.fake.requests.length
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    const inv = await settled(o, saleId)
    expect(inv.invoice_emit_status).toBe('failed')
    expect(String(inv.invoice_last_error)).toMatch(/emissor não configurado/i)
    expect(inv.can_reemit).toBe(true)
    expect(sys.fake.requests.length).toBe(before)
  })

  it('AC-T112-03 falha do fake → novas tentativas com backoff crescente e depois sucesso (no máximo 3 chamadas)', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    sys.fake.failNext(500, { success: false, error: { message: 'Instabilidade temporária' } }, 2)
    const contactId = await newContact(o)
    const watch = watchRequests(sys.fake, () => true)
    try {
      const saleId = await runSale(sys, o, flowId, contactId)
      const inv = await settled(o, saleId)
      expect(inv.invoice_emit_status).toBe('succeeded')
      expect(inv.attempts).toBe(3)
      expect(sys.fake.requests.filter(forSale(saleId))).toHaveLength(3)
      expect(salesAt(saleId)).toHaveLength(1)
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

  it('AC-T112-03 falha persistente → exatamente 3 chamadas e status failed com a mensagem do emissor', async () => {
    const { o, flowId } = await scenario(TOKEN_A)
    sys.fake.failAlways(500, { success: false, error: { message: 'Serviço indisponível XYZ' } })
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    const inv = await settled(o, saleId)
    expect(inv.invoice_emit_status).toBe('failed')
    expect(String(inv.invoice_last_error)).toContain('Serviço indisponível XYZ')
    expect(inv.attempts).toBe(3)
    expect(inv.can_reemit).toBe(true)
    await sleep(RETRY_BASE_MS * 8)
    expect(sys.fake.requests.filter(forSale(saleId)), 'mais de 3 chamadas ao emissor').toHaveLength(3)
  })

  it('AC-T112-03 reemit-invoice reenfileira a venda com falha e ela é emitida', async () => {
    const { o, issuer, flowId } = await scenario(TOKEN_A)
    sys.fake.failAlways(503, { success: false, error: { message: 'Fora do ar' } })
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    expect((await settled(o, saleId)).invoice_emit_status).toBe('failed')
    sys.fake.reset()

    const re = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, {})
    expect(re.status, re.text).toBe(202)
    expect(re.body.message).toMatch(/reenfileirada/i)
    expect(re.body.invoice?.invoice_emit_status ?? re.body.sale?.invoice_emit_status).toBe('pending')

    const inv = await settled(o, saleId)
    expect(inv.invoice_emit_status).toBe('succeeded')
    expect(inv.invoice_integration_id).toBe(issuer.id)
    expect(salesAt(saleId)).toHaveLength(1)
    expect(salesAt(saleId)[0].token).toBe(TOKEN_A)

    // succeeded → nova reemissão recusada (409)
    const again = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, {})
    expect(again.status, again.text).toBe(409)
  })

  it('AC-T112-03 reemit-invoice escolhendo outro emissor emite pelo emissor escolhido', async () => {
    const { o, flowId } = await scenario(undefined)
    const other = await createIssuer(o, 'Outra Empresa', TOKEN_B)
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    expect((await settled(o, saleId)).invoice_emit_status).toBe('failed')

    const re = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, { invoice_integration_id: other.id })
    expect(re.status, re.text).toBe(202)
    const inv = await settled(o, saleId)
    expect(inv.invoice_emit_status).toBe('succeeded')
    expect(inv.invoice_integration_id).toBe(other.id)
    expect(salesAt(saleId).map((s: Any) => s.token)).toEqual([TOKEN_B])
  })

  it('AC-T112-03 reemit-invoice: emissor de outra empresa → 404; venda de outra empresa → 404; enquanto pending → 409', async () => {
    const { o, flowId } = await scenario(undefined)
    const stranger = await newOwner(sys)
    const foreign = await createIssuer(stranger, 'Empresa Alheia', TOKEN_X)
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    expect((await settled(o, saleId)).invoice_emit_status).toBe('failed')

    const r1 = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, { invoice_integration_id: foreign.id })
    expect(r1.status, r1.text).toBe(404)
    const r2 = await stranger.c.post(`/api/sales/${saleId}/reemit-invoice`, {})
    expect(r2.status, r2.text).toBe(404)
    expect(sys.fake.requests.filter((r: Any) => r.token === TOKEN_X)).toHaveLength(0)

    // pending: o fake segura a 1ª chamada falhando, a nota fica pending durante o backoff
    const good = await createIssuer(o, 'Boa', TOKEN_A)
    sys.fake.failAlways(500, { success: false, error: { message: 'lento' } })
    const re = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, { invoice_integration_id: good.id })
    expect(re.status, re.text).toBe(202)
    const busy = await o.c.post(`/api/sales/${saleId}/reemit-invoice`, { invoice_integration_id: good.id })
    expect(busy.status, busy.text).toBe(409)
    expect((await settled(o, saleId)).invoice_emit_status).toBe('failed')
  })
})

describe('T112 — token e exclusão do emissor', () => {
  it('AC-T112-04 o token nunca aparece nas respostas da API nem nos logs', async () => {
    const o = await newOwner(sys)
    const secret = `ntsyS_${randomBytes(12).toString('hex')}`
    sys.fake.addToken(secret)
    const bodies: string[] = []
    const keep = (r: Any) => (bodies.push(r.text ?? JSON.stringify(r.body)), r)

    const created = keep(await o.c.post('/api/invoice-integrations', { invoice_integration: { provider: 'notasy', company_name: 'Loja Segredo', integration_token: secret } }))
    expect(created.status, created.text).toBe(201)
    const issuer = created.body.invoice_integration
    expect(issuer.token_configured).toBe(true)
    expect(issuer).not.toHaveProperty('integration_token')
    keep(await o.c.get('/api/invoice-integrations'))
    keep(await o.c.get(`/api/invoice-integrations/${issuer.id}`))
    keep(await o.c.get(`/api/invoice-integrations/${issuer.id}/usage`))
    // PUT com token em branco mantém; erros de validação não ecoam o token
    const blank = keep(await o.c.put(`/api/invoice-integrations/${issuer.id}`, { invoice_integration: { company_name: 'Loja Segredo 2', integration_token: '' } }))
    expect(blank.status, blank.text).toBe(200)
    expect(blank.body.invoice_integration.token_configured).toBe(true)
    const bad = keep(await o.c.post('/api/invoice-integrations', { invoice_integration: { provider: 'notasy', company_name: 'x', integration_token: secret } }))
    expect(bad.status).toBe(422)
    const badProv = keep(await o.c.put(`/api/invoice-integrations/${issuer.id}`, { invoice_integration: { provider: 'outro', integration_token: secret } }))
    expect(badProv.status).toBe(422)

    // Emissão com esse token: falha do emissor (mensagem e erro gravado) e sucesso — nada expõe o token.
    const product = await newProduct(o)
    const flowId = await saleFlow(o, product.public_id, issuer.id)
    sys.fake.failNext(500, { success: false, error: { message: 'erro no endpoint' } }, 3)
    const saleId = await runSale(sys, o, flowId, await newContact(o))
    const failed = await settled(o, saleId)
    expect(failed.invoice_emit_status).toBe('failed')
    bodies.push(JSON.stringify(failed))
    keep(await o.c.post(`/api/sales/${saleId}/reemit-invoice`, {}))
    const ok = await settled(o, saleId)
    expect(ok.invoice_emit_status).toBe('succeeded')
    expect(salesAt(saleId)[0].token, 'a emissão usou o token guardado').toBe(secret)
    bodies.push(JSON.stringify(ok))
    keep(await o.c.get(`/api/sale-invoices?sale_ids=${saleId}`))

    for (const b of bodies) expect(b).not.toContain(secret)
    expect(sys.logs.length).toBeGreaterThan(0)
    expect(sys.logs.join('\n'), 'token em log').not.toContain(secret)
    // guardado cifrado: nenhuma coluna da tabela de emissores tem o token em claro
    const rows = await sys.q(`SELECT row_to_json(t)::text AS j FROM crm.invoice_integrations t WHERE t.id = $1`, [issuer.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].j).not.toContain(secret)
  })

  it('AC-T112-04 excluir emissor usado por bloco "Venda aprovada" de fluxo ativo avisa que o bloco deixará de emitir', async () => {
    const o = await newOwner(sys)
    const used = await createIssuer(o, 'Em uso', TOKEN_A)
    const free = await createIssuer(o, 'Livre', TOKEN_B)
    const product = await newProduct(o)
    const flowId = await saleFlow(o, product.public_id, used.id)

    const usage = await o.c.get(`/api/invoice-integrations/${used.id}/usage`)
    expect(usage.status, usage.text).toBe(200)
    expect(usage.body.in_use).toBe(true)
    expect(JSON.stringify(usage.body.flows)).toContain(flowId)

    const del = await o.c.delete(`/api/invoice-integrations/${used.id}`)
    expect(del.status, del.text).toBe(409)
    expect(del.text).toMatch(/Venda aprovada/)
    expect(del.text).toMatch(/deixará de emitir/)
    expect(del.text).toContain(flowId)
    expect((await o.c.get(`/api/invoice-integrations/${used.id}`)).status, 'não excluiu sem confirmação').toBe(200)

    const forced = await o.c.delete(`/api/invoice-integrations/${used.id}?force=1`)
    expect(forced.status, forced.text).toBe(200)
    expect((await o.c.get(`/api/invoice-integrations/${used.id}`)).status).toBe(404)

    const plain = await o.c.delete(`/api/invoice-integrations/${free.id}`)
    expect(plain.status, plain.text).toBe(200)
    const list = await o.c.get('/api/invoice-integrations')
    expect(list.body.invoice_integrations).toEqual([])
  })
})

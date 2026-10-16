// AC-T109-01..05: segredos da integração, test-connection no FakeXPag, createCharge (matriz e "em breve"),
// parseWebhook (token) e exclusão bloqueada por fluxo ativo.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { CLIENT_ID, CLIENT_SECRET, fieldPaths, flowUsing, newIntegration, newMember, newOwner, startEnv, type Env, type User } from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

/** Nenhuma resposta ou log contém o segredo em claro. */
const leaks = (secret: string, ...texts: string[]) => texts.filter((t) => t.includes(secret))

describe('AC-T109-01 segredos da integração', () => {
  it('AC-T109-01 client_secret e webhook_secret nunca aparecem em resposta nem em log', async () => {
    const before = env.logs.length
    const created = await owner.c.post('/api/payment-integrations', { label: 'XPag Loja', gateway: 'xpag', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    expect(created.status, created.text).toBe(201)
    const dto = created.body.integration
    expect(dto).toMatchObject({ label: 'XPag Loja', gateway: 'xpag', client_id: CLIENT_ID, secret_configured: true })
    expect(dto.secret_hint).toBe(`…${CLIENT_SECRET.slice(-4)}`)
    expect(dto).not.toHaveProperty('client_secret')
    expect(dto).not.toHaveProperty('webhook_secret')
    expect(dto.webhook_url).toBe(`http://api.t109.test/api/hooks/payments/xpag/${dto.id}`)

    const list = await owner.c.get('/api/payment-integrations')
    const one = await owner.c.get(`/api/payment-integrations/${dto.id}`)
    const filtered = await owner.c.get('/api/payment-integrations?gateway=xpag')
    expect(list.body.items.map((i: any) => i.id)).toContain(dto.id)
    expect(filtered.body.items.map((i: any) => i.id)).toContain(dto.id)

    const [row] = await env.q(`SELECT * FROM crm.payment_integrations WHERE id = $1`, [dto.id])
    expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET) // cifrado em repouso
    const texts = [created.text, list.text, one.text, filtered.text, JSON.stringify(dto), ...env.logs.slice(before)]
    expect(leaks(CLIENT_SECRET, ...texts)).toEqual([])
    // o webhook_secret (gerado pelo servidor) não sai em nenhuma resposta: nem o campo, nem a URL com ?token=
    for (const t of [created.text, list.text, one.text, filtered.text]) {
      expect(t).not.toMatch(/webhook_secret|client_secret/)
      expect(t).not.toMatch(/[?&]token=/)
    }
  })

  it('AC-T109-01 editar com segredo vazio mantém o atual; segredo novo troca; trocar o gateway → 422', async () => {
    const dto = await newIntegration(owner)
    const empty = await owner.c.put(`/api/payment-integrations/${dto.id}`, { label: 'Renomeada', client_secret: '' })
    expect(empty.status, empty.text).toBe(200)
    expect(empty.body.integration).toMatchObject({ label: 'Renomeada', secret_configured: true, secret_hint: `…${CLIENT_SECRET.slice(-4)}` })
    // o segredo mantido continua funcionando no fake
    expect((await owner.c.post(`/api/payment-integrations/${dto.id}/test-connection`)).body).toEqual({ ok: true })
    const absent = await owner.c.put(`/api/payment-integrations/${dto.id}`, { label: 'Sem campo' })
    expect(absent.body.integration.secret_hint).toBe(`…${CLIENT_SECRET.slice(-4)}`)

    const other = `sk_novo_${randomBytes(8).toString('hex')}`
    const changed = await owner.c.put(`/api/payment-integrations/${dto.id}`, { client_secret: other })
    expect(changed.status, changed.text).toBe(200)
    expect(changed.body.integration.secret_hint).toBe(`…${other.slice(-4)}`)
    expect(changed.text).not.toContain(other)

    const gw = await owner.c.put(`/api/payment-integrations/${dto.id}`, { gateway: 'zenith' })
    expectApiError(gw, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(gw)).toContain('gateway')
    expect((await owner.c.get(`/api/payment-integrations/${dto.id}`)).body.integration.gateway).toBe('xpag')
    // envelope do produto também vale
    const env2 = await owner.c.patch(`/api/payment-integrations/${dto.id}`, { payment_integration: { label: 'Envelope' } })
    expect(env2.status, env2.text).toBe(200)
    expect(env2.body.integration.label).toBe('Envelope')
  })

  it('AC-T109-01 validação na criação, permissões e isolamento entre empresas', async () => {
    for (const [body, field] of [
      [{ label: 'X', gateway: 'xpag', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, 'label'],
      [{ label: 'XPag', gateway: 'xpag', client_secret: CLIENT_SECRET }, 'client_id'],
      [{ label: 'XPag', gateway: 'xpag', client_id: CLIENT_ID }, 'client_secret'],
    ] as const) {
      const res = await owner.c.post('/api/payment-integrations', body)
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(res), JSON.stringify(body)).toContain(field)
    }
    const dto = await newIntegration(owner)
    const viewer = await newMember(env, owner.companyId, ['settings.integrations.view'])
    expect((await viewer.c.get(`/api/payment-integrations/${dto.id}`)).status).toBe(200)
    expectApiError(await viewer.c.post('/api/payment-integrations', { label: 'Nova', gateway: 'xpag', client_id: 'a', client_secret: 'b' }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.delete(`/api/payment-integrations/${dto.id}`), 'FORBIDDEN', 403)
    const nobody = await newMember(env, owner.companyId, ['chat.view'])
    expectApiError(await nobody.c.get('/api/payment-integrations'), 'FORBIDDEN', 403)
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/payment-integrations/${dto.id}`), 'NOT_FOUND', 404)
    expectApiError(await other.c.put(`/api/payment-integrations/${dto.id}`, { label: 'Invasão' }), 'NOT_FOUND', 404)
    expect((await other.c.get('/api/payment-integrations')).body.items.map((i: any) => i.id)).not.toContain(dto.id)
    expectApiError(await owner.c.get(`/api/payment-integrations/${uuid()}`), 'NOT_FOUND', 404)
  })
})

describe('AC-T109-02 test-connection', () => {
  it('AC-T109-02 chama o FakeXPag e devolve { ok: true }', async () => {
    const dto = await newIntegration(owner)
    const before = env.fake.requests.length
    const res = await owner.c.post(`/api/payment-integrations/${dto.id}/test-connection`)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const calls = env.fake.requests.slice(before)
    expect(calls.some((r: any) => r.method === 'GET' && r.path.startsWith('/balance'))).toBe(true)
    const after = (await owner.c.get(`/api/payment-integrations/${dto.id}`)).body.integration
    expect(after.last_test_ok).toBe(true)
    expect(after.last_tested_at).toBeTruthy()
  })

  it('AC-T109-02 credencial recusada pelo fake → { ok: false, error } sem expor a chave (resposta e logs)', async () => {
    const wrong = `sk_errada_${randomBytes(10).toString('hex')}`
    const dto = await newIntegration(owner, { client_secret: wrong })
    const before = env.logs.length
    const res = await owner.c.post(`/api/payment-integrations/${dto.id}/test-connection`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(typeof res.body.error).toBe('string')
    expect(res.body.error.length).toBeGreaterThan(0)
    expect(leaks(wrong, res.text, ...env.logs.slice(before))).toEqual([])
    expect(leaks(CLIENT_SECRET, res.text, ...env.logs.slice(before))).toEqual([])
    expect((await owner.c.get(`/api/payment-integrations/${dto.id}`)).body.integration.last_test_ok).toBe(false)
  })
})

describe('AC-T109-03 createCharge no XPag', () => {
  const webhookSecret = `wh_${randomBytes(10).toString('hex')}`
  const gateway = () =>
    env.core.createXPagGateway({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webhookSecret, webhookUrl: 'http://api.t109.test/api/hooks/payments/xpag/x', apiUrl: env.fake.url })
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p
      return null
    } catch (err: any) {
      expect(err).toBeInstanceOf(env.core.PaymentGatewayError)
      return { code: err.code as string, message: String(err.message) }
    }
  }

  it('AC-T109-03 BRL/PIX devolve transaction_id e o código copia-e-cola', async () => {
    const g = gateway()
    expect(g.id).toBe('xpag')
    const res = await g.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 4_990, name: 'Maria Souza', email: 'maria@example.test', description: 'Pedido 1' })
    expect(res.status).toBe('created')
    expect(typeof res.transaction_id).toBe('string')
    expect(res.transaction_id.length).toBeGreaterThan(0)
    expect(typeof res.payment_code).toBe('string')
    expect(res.payment_code.length).toBeGreaterThan(10)
    const cashin = env.fake.cashins.find((c: any) => c.transaction_id === res.transaction_id)
    expect(cashin, 'o fake não recebeu o cashin').toBeTruthy()
    expect(JSON.stringify(cashin.body)).not.toContain(CLIENT_SECRET)
    const supported = g.supported()
    expect(supported).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'BRL', methods: expect.arrayContaining(['PIX']) })]))
  })

  it('AC-T109-03 moeda × método fora da matriz → erro de validação antes da chamada; ARS "chave sem valor" → "em breve"', async () => {
    const g = gateway()
    for (const req of [
      { currency: 'BRL', method: 'OXXO', amount_cents: 1_000 },
      { currency: 'MXN', method: 'PIX', amount_cents: 1_000 },
      { currency: 'USD', method: 'PIX', amount_cents: 1_000 },
      { currency: 'COP', method: 'SPEI', amount_cents: 2_000_000 },
      { currency: 'MXN', method: 'OXXO', amount_cents: 900 }, // < MX$10
      { currency: 'MXN', method: 'OXXO', amount_cents: 1_000_001 }, // > MX$10.000
      { currency: 'COP', method: 'NEQUI', amount_cents: 999_999 }, // < COP 10.000
    ]) {
      const before = env.fake.requests.length
      const err = await codeOf(g.createCharge(req))
      expect(err?.code, JSON.stringify(req)).toBe('validation')
      expect(env.fake.requests.length, `chamou a API em ${JSON.stringify(req)}`).toBe(before)
    }
    const before = env.fake.requests.length
    const ars = await codeOf(g.createCharge({ currency: 'ARS', method: 'BANK_TRANSFER', amount_cents: null }))
    expect(ars?.code).toBe('coming_soon')
    expect(ars?.message.toLowerCase()).toContain('em breve')
    expect(env.fake.requests.length).toBe(before)
    // dentro da matriz e dos limites: aceito
    const ok = await g.createCharge({ currency: 'MXN', method: 'OXXO', amount_cents: 50_000 })
    expect(ok.transaction_id).toBeTruthy()
  })

  it('AC-T109-03 credencial recusada na cobrança → unauthorized, sem a chave na mensagem', async () => {
    const wrong = `sk_ruim_${randomBytes(8).toString('hex')}`
    const g = env.core.createXPagGateway({ clientId: CLIENT_ID, clientSecret: wrong, webhookSecret, apiUrl: env.fake.url })
    const err = await codeOf(g.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 1_000 }))
    expect(err?.code).toBe('unauthorized')
    expect(err?.message).not.toContain(wrong)
  })
})

describe('AC-T109-04 parseWebhook', () => {
  const webhookSecret = `wh_${randomBytes(10).toString('hex')}`
  const gateway = () =>
    env.core.createXPagGateway({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webhookSecret, webhookUrl: 'http://api.t109.test/api/hooks/payments/xpag/y', apiUrl: env.fake.url })
  /** headers do fake; se o token vier só na query, repassa no header como a rota de hooks (T111) faz. */
  const headersOf = (hook: any) => {
    const h: Record<string, string> = { ...(hook.headers ?? {}) }
    if (!h['x-webhook-token']) {
      const token = new URL(hook.url).searchParams.get('token')
      if (token) h['x-webhook-token'] = token
    }
    return h
  }

  it('AC-T109-04 assinatura (token) válida converte o payload do fake em payment.approved', async () => {
    const g = gateway()
    const charge = await g.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 12_345 })
    const hook = env.fake.webhookFor(charge.transaction_id, { status: 'confirmed', amount: 123.45 })
    const events = await g.parseWebhook(hook.rawBody, headersOf(hook))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'payment.approved', transaction_id: charge.transaction_id, amount_cents: 12_345, currency: 'BRL' })
    expect(Number.isNaN(Date.parse(events[0].paid_at))).toBe(false)
    // falha e expiração também são convertidas
    const failed = await g.parseWebhook(env.fake.webhookFor(charge.transaction_id, { status: 'failed' }).rawBody, { 'x-webhook-token': webhookSecret })
    expect(failed[0]?.type).toBe('payment.failed')
    const expired = await g.parseWebhook(env.fake.webhookFor(charge.transaction_id, { status: 'expired' }).rawBody, { 'x-webhook-token': webhookSecret })
    expect(expired[0]?.type).toBe('payment.expired')
  })

  it('AC-T109-04 assinatura inválida ou ausente → erro e nenhum evento', async () => {
    const g = gateway()
    const charge = await g.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 1_000 })
    const hook = env.fake.webhookFor(charge.transaction_id, { status: 'confirmed' })
    for (const headers of [{ 'x-webhook-token': 'token-errado' }, {}, { 'x-webhook-token': webhookSecret.slice(0, -1) }]) {
      let events: unknown = 'não lançou'
      let code: string | null = null
      try {
        events = await g.parseWebhook(hook.rawBody, headers)
      } catch (err: any) {
        expect(err).toBeInstanceOf(env.core.PaymentGatewayError)
        code = err.code
        events = null
      }
      expect(code, JSON.stringify(headers)).toBe('invalid_signature')
      expect(events).toBeNull()
    }
  })
})

describe('AC-T109-05 exclusão', () => {
  it('AC-T109-05 integração usada por bloco Pagamento de fluxo ativo → 409 com a lista de fluxos; sem uso ativo, exclui', async () => {
    const dto = await newIntegration(owner)
    const active = await flowUsing(env, owner, dto.id, 'active')
    const draft = await flowUsing(env, owner, dto.id, 'draft')
    const blocked = await owner.c.delete(`/api/payment-integrations/${dto.id}`)
    expectApiError(blocked, 'CONFLICT', 409)
    const flows = blocked.body.error.details?.flows ?? []
    expect(flows).toEqual([expect.objectContaining({ id: active.id, name: active.name })])
    expect(flows.map((f: any) => f.id)).not.toContain(draft.id)
    expect((await owner.c.get(`/api/payment-integrations/${dto.id}`)).status).toBe(200)

    await env.q(`UPDATE crm.flows SET status = 'paused' WHERE id = $1`, [active.id])
    const ok = await owner.c.delete(`/api/payment-integrations/${dto.id}`)
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body).toEqual({ ok: true })
    expectApiError(await owner.c.get(`/api/payment-integrations/${dto.id}`), 'NOT_FOUND', 404)

    const unused = await newIntegration(owner)
    expect((await owner.c.delete(`/api/payment-integrations/${unused.id}`)).status).toBe(200)
  })
})

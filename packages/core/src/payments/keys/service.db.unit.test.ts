// Chaves de pagamento (T109) com Postgres real e FakeXPag local (nada sai para a rede).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, createDb, flowNodeActions, flowNodes, flows, paymentIntegrations, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { XPAG_WEBHOOK_TOKEN_HEADER } from '../xpag/gateway'
import { FakeXPag } from '../xpag/fake'
import { PaymentIntegrationsError, PaymentIntegrationsService } from './service'

let temp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const rnd = () => randomBytes(4).toString('hex')
const CLIENT_ID = 'cli-db'
const SECRET = 'sk_xpag_DBSECRET_wxyz'
const fake = new FakeXPag({ clientId: CLIENT_ID, clientSecret: SECRET })

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  await fake.start()
}, 60_000)

afterAll(async () => {
  await fake.stop()
  await db?.$client.end()
  await temp?.drop()
})

async function company() {
  const [co] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}` }).returning({ id: companies.id })
  return co!.id
}

const svc = () => new PaymentIntegrationsService({ db, cipher, env: { XPAG_API_URL: fake.url, API_PUBLIC_URL: 'https://api.crm.test/' } })
const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PaymentIntegrationsError)
const input = { label: 'XPag Loja', gateway: 'xpag', client_id: CLIENT_ID, client_secret: SECRET }

describe('CRUD e segredos', () => {
  it('cria cifrado, com máscara e webhook_url derivada; DTO nunca traz segredos', async () => {
    const co = await company()
    const s = svc()
    const dto = await s.create(co, { ...input, label: '  XPag Loja  ' })
    expect(dto).toMatchObject({ label: 'XPag Loja', gateway: 'xpag', client_id: CLIENT_ID, secret_configured: true, secret_hint: '…wxyz', zenith_oauth: false })
    expect(dto.webhook_url).toBe(`https://api.crm.test/api/hooks/payments/xpag/${dto.id}`)
    const [row] = await db.select().from(paymentIntegrations).where(eq(paymentIntegrations.id, dto.id))
    expect(row!.clientSecretEnc).not.toContain('DBSECRET')
    expect(row!.webhookSecretEnc.length).toBeGreaterThan(20)
    const all = JSON.stringify([dto, await s.list(co), await s.get(co, dto.id)])
    expect(all).not.toContain('DBSECRET')
    expect(all).not.toContain('webhook_secret')
    expect(await s.list(co, { gateway: 'zenith' })).toEqual([])
  })

  it('validação na criação: label < 2, gateway inválido, sem client_id/secret', async () => {
    const err = await caught(svc().create(await company(), { label: 'x', gateway: 'outro', client_id: '', client_secret: '  ' }))
    expect(err).toBeInstanceOf(PaymentIntegrationsError)
    expect(err!.code).toBe('validation')
    expect((err!.details!.fields as { path: string }[]).map((f) => f.path).sort()).toEqual(['client_id', 'client_secret', 'gateway', 'label'])
  })

  it('editar com segredo vazio mantém; segredo novo troca; gateway diferente → validation', async () => {
    const co = await company()
    const s = svc()
    const dto = await s.create(co, input)
    expect((await s.testConnection(co, dto.id)).ok).toBe(true)
    for (const client_secret of [undefined, '', '   ', null]) await s.update(co, dto.id, { label: 'Novo nome', client_secret })
    expect(await s.get(co, dto.id)).toMatchObject({ label: 'Novo nome', secret_hint: '…wxyz', last_test_ok: true })
    expect((await s.testConnection(co, dto.id)).ok).toBe(true)
    expect(await s.update(co, dto.id, { gateway: 'xpag' })).toMatchObject({ gateway: 'xpag' })
    const err = await caught(s.update(co, dto.id, { gateway: 'zenith' }))
    expect(err!.code).toBe('validation')
    expect((err!.details!.fields as { path: string }[])[0]!.path).toBe('gateway')
    const changed = await s.update(co, dto.id, { client_secret: 'outro-segredo-9999' })
    expect(changed).toMatchObject({ secret_hint: '…9999', last_test_ok: null })
    const r = await s.testConnection(co, dto.id)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('outro-segredo')
    expect((await s.get(co, dto.id)).last_test_ok).toBe(false)
  })

  it('isolamento: outra empresa e id inválido → not_found', async () => {
    const a = await company()
    const dto = await svc().create(a, input)
    const b = await company()
    expect((await caught(svc().get(b, dto.id)))!.code).toBe('not_found')
    expect((await caught(svc().testConnection(b, dto.id)))!.code).toBe('not_found')
    expect((await caught(svc().get(a, 'nao-uuid')))!.code).toBe('not_found')
  })
})

describe('exclusão', () => {
  async function flowUsing(co: string, integrationId: string, status: 'active' | 'paused', name: string) {
    const [f] = await db.insert(flows).values({ companyId: co, name, status }).returning({ id: flows.id })
    const [n] = await db.insert(flowNodes).values({ companyId: co, flowId: f!.id, key: `n-${rnd()}`, type: 'action', name: 'Pagamento', positionX: 0, positionY: 0 }).returning({ id: flowNodes.id })
    await db.insert(flowNodeActions).values({ companyId: co, nodeId: n!.id, key: 'a1', type: 'create_payment_charge', config: { gateway: 'xpag', payment_integration_id: integrationId } })
    return f!.id
  }

  it('usada por fluxo ativo → conflict com a lista; pausado não bloqueia', async () => {
    const co = await company()
    const s = svc()
    const dto = await s.create(co, input)
    const active = await flowUsing(co, dto.id, 'active', 'Funil PIX')
    await flowUsing(co, dto.id, 'paused', 'Rascunho')
    const err = await caught(s.remove(co, dto.id))
    expect(err!.code).toBe('conflict')
    expect(err!.details!.flows).toEqual([{ id: active, name: 'Funil PIX' }])
    await db.update(flows).set({ status: 'paused' }).where(eq(flows.id, active))
    await s.remove(co, dto.id)
    expect((await caught(s.get(co, dto.id)))!.code).toBe('not_found')
  })
})

describe('gatewayFor', () => {
  it('monta o adapter com as credenciais decifradas; webhook da cobrança autentica no parseWebhook', async () => {
    const co = await company()
    const s = svc()
    const dto = await s.create(co, input)
    const gw = await s.gatewayFor(co, dto.id)
    const charge = await gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 5000 })
    const hook = fake.webhookFor(charge.transaction_id)
    expect(hook.url!.startsWith(dto.webhook_url)).toBe(true)
    expect(gw.parseWebhook(hook.rawBody, hook.headers)[0]).toMatchObject({ type: 'payment.approved', amount_cents: 5000 })
    const other = await s.gatewayFor(co, (await s.create(co, input)).id)
    expect(() => other.parseWebhook(hook.rawBody, hook.headers)).toThrow()
    expect(hook.headers[XPAG_WEBHOOK_TOKEN_HEADER]).toBeTruthy()
  })
})

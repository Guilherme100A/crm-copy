// Sessões WhatsApp de todas as empresas (T96, AC-T96-03) pelo FakeWaGateway e uso de IA agregado por empresa × modelo
// (AC-T96-04), com Postgres real.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiUsage, companies, connections, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { aiUsageByCompanyModel } from './ai-usage'
import { AdminOpsError } from './errors'
import { isWaExtensionMode, listAdminWaSessions, waRpcProfile } from './wa-sessions'

let temp: TempDatabase
let db: Database
const rnd = () => randomBytes(4).toString('hex')

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function company(name: string) {
  const [co] = await db
    .insert(companies)
    .values({ name, slug: `c-${rnd()}` })
    .returning({ id: companies.id })
  return co!.id
}

describe('sessões WhatsApp do admin', () => {
  it('lista as sessões do gateway com estado e empresa dona (por connections.session_id); sem conexão = órfã', async () => {
    const acme = await company('Acme')
    const beta = await company('Beta')
    const gw = new FakeWaGateway({
      sessions: [
        { id: 's-acme', name: 'Vendas', phone: '+5511999990001', state: 'STABLE' },
        { id: 's-beta', name: 'Suporte', state: 'DISCONNECTED' },
        { id: 's-orphan', name: 'Solta', state: 'NEW' },
      ],
    })
    const [conn] = await db
      .insert(connections)
      .values({ companyId: acme, sessionId: 's-acme', name: 'Vendas', connectionState: 'open' })
      .returning({ id: connections.id })
    await db.insert(connections).values({ companyId: beta, sessionId: 's-beta', name: 'Suporte' })
    await db.update(companies).set({ active: false })
    const items = await listAdminWaSessions(db, gw)
    expect(items.map((i) => [i.id, i.state, i.company?.name ?? null])).toEqual([
      ['s-acme', 'STABLE', 'Acme'],
      ['s-beta', 'DISCONNECTED', 'Beta'],
      ['s-orphan', 'NEW', null],
    ])
    expect(items[0]).toMatchObject({
      name: 'Vendas',
      phone: '+5511999990001',
      connection: { id: conn!.id, name: 'Vendas', connection_state: 'open', scheduled_for_deletion: false },
      company: { id: acme, name: 'Acme', active: false },
    })
    expect(items[2]!.connection).toBeNull()

    expect((await listAdminWaSessions(db, gw, { company_id: beta })).map((i) => i.id)).toEqual(['s-beta'])
    expect((await listAdminWaSessions(db, gw, { state: 'NEW' })).map((i) => i.id)).toEqual(['s-orphan'])
    expect((await listAdminWaSessions(db, gw, { orphan: true })).map((i) => i.id)).toEqual(['s-orphan'])
    expect((await listAdminWaSessions(db, gw, { orphan: false })).map((i) => i.id)).toEqual(['s-acme', 's-beta'])
    expect(await listAdminWaSessions(db, new FakeWaGateway())).toEqual([])
  })

  it('perfil pelo WA_RPC_PROFILE (default crm); ai-manager = modo extensão, decidido pelo nome', () => {
    expect(waRpcProfile({})).toBe('crm')
    expect(waRpcProfile({ WA_RPC_PROFILE: ' ai-manager ' })).toBe('ai-manager')
    expect(isWaExtensionMode('ai-manager')).toBe(true)
    expect(isWaExtensionMode('AI-Manager')).toBe(true)
    expect(isWaExtensionMode('crm')).toBe(false)
  })
})

describe('uso de IA por empresa × provedor × modelo', () => {
  it('agrega ai_usage: erro não entra; custo/cobrado/créditos só do que ficou charged; filtros e totais', async () => {
    const a = await company('Alfa IA')
    const b = await company('Bravo IA')
    const at = (iso: string) => new Date(iso)
    const row = (
      companyId: string,
      model: string,
      status: 'charged' | 'refunded' | 'error',
      createdAt: Date,
      credits = 10,
    ) => ({
      companyId,
      requestId: `r-${rnd()}`,
      provider: 'openai',
      model,
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 1000,
      billedMicros: 1500,
      credits,
      status,
      createdAt,
    })
    await db
      .insert(aiUsage)
      .values([
        row(a, 'gpt-x', 'charged', at('2026-04-10T00:00:00Z')),
        row(a, 'gpt-x', 'charged', at('2026-04-11T00:00:00Z')),
        row(a, 'gpt-x', 'refunded', at('2026-04-12T00:00:00Z')),
        row(a, 'gpt-x', 'error', at('2026-04-12T00:00:00Z')),
        row(a, 'gpt-y', 'charged', at('2026-05-02T00:00:00Z'), 99),
        row(b, 'gpt-x', 'charged', at('2026-04-15T00:00:00Z'), 5),
      ])
    const all = await aiUsageByCompanyModel(db, {})
    const mine = all.items.filter((i) => i.company_id === a || i.company_id === b)
    expect(mine).toEqual([
      {
        company_id: a,
        company_name: 'Alfa IA',
        provider: 'openai',
        model: 'gpt-y',
        count: 1,
        input_tokens: 100,
        output_tokens: 50,
        cost_micros: 1000,
        billed_micros: 1500,
        credits: 99,
      },
      {
        company_id: a,
        company_name: 'Alfa IA',
        provider: 'openai',
        model: 'gpt-x',
        count: 3,
        input_tokens: 300,
        output_tokens: 150,
        cost_micros: 2000,
        billed_micros: 3000,
        credits: 20,
      },
      {
        company_id: b,
        company_name: 'Bravo IA',
        provider: 'openai',
        model: 'gpt-x',
        count: 1,
        input_tokens: 100,
        output_tokens: 50,
        cost_micros: 1000,
        billed_micros: 1500,
        credits: 5,
      },
    ])
    const april = await aiUsageByCompanyModel(db, {
      from: '2026-04-01T00:00:00Z',
      to: '2026-05-01T00:00:00Z',
      company_id: a,
    })
    expect(april.items.map((i) => [i.model, i.count, i.credits])).toEqual([['gpt-x', 3, 20]])
    expect(april.totals).toEqual({
      count: 3,
      input_tokens: 300,
      output_tokens: 150,
      cost_micros: 2000,
      billed_micros: 3000,
      credits: 20,
    })
    expect(april).toMatchObject({ from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z' })
    expect((await aiUsageByCompanyModel(db, { company_id: 'x' })).items).toEqual([])
    expect((await aiUsageByCompanyModel(db, { model: 'gpt-y' })).items.map((i) => i.company_id)).toEqual([a])
    const bad = await aiUsageByCompanyModel(db, { from: 'ontem' }).catch((e: unknown) => e as AdminOpsError)
    expect((bad as AdminOpsError).code).toBe('validation')
    const inverted = await aiUsageByCompanyModel(db, {
      from: '2026-05-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    }).catch((e: unknown) => e as AdminOpsError)
    expect((inverted as AdminOpsError).code).toBe('validation')
  })
})

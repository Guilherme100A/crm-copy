// Fluxos padrões por conexão pela API (T61): CRUD, validação, isolamento, permissões, edição em massa com
// keep/clear (AC-T61-06) e bloqueio de exclusão de fluxo referenciado (T28).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyMembers, connections, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t61-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.61.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}

const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (res.status === 204 ? {} : await res.json()) as Json }
}
const paths = (b: Json) => (b.error.details.fields as Json[]).map((f) => f.path)

async function connection(s: Session, name: string): Promise<string> {
  const [c] = await db.insert(connections).values({ companyId: s.companyId, sessionId: `s-${rnd()}`, name }).returning()
  return c!.id
}
const flow = async (s: Session, name = 'F') => (await call(s, 'POST', '/api/flows', { name })).body.flow.id as string

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('connection-flow-configs', () => {
  it('lista uma por conexão com status; PUT substitui tudo (aceita envelope e keyword_triggers_attributes); GET devolve', async () => {
    const s = await signUp()
    const a = await connection(s, 'A Vendas')
    const b = await connection(s, 'B Suporte')
    const [f1, f2, f3, f4] = [await flow(s, 'f1'), await flow(s, 'f2'), await flow(s, 'f3'), await flow(s, 'f4')]
    const empty = await call(s, 'GET', '/api/connection-flow-configs')
    expect(empty.body.items.map((i: Json) => [i.connection_name, i.status, i.id])).toEqual([
      ['A Vendas', 'empty', null],
      ['B Suporte', 'empty', null],
    ])
    const put = await call(s, 'PUT', `/api/connection-flow-configs/${a}`, {
      connection_flow_config: {
        welcome_flow_id: f1,
        default_response_flow_id: f2,
        default_response_delay_hours: 48,
        keyword_triggers_attributes: [
          { flow_id: f3, rule_type: 'all', conditions: [{ keyword: 'quero', match_type: 'starts_with' }, { keyword: 'plano' }] },
          { flow_id: f4, keyword: 'menu', match_type: 'equals' },
          { flow_id: f4, keyword: 'apagar', _destroy: true },
        ],
      },
    })
    expect(put.status).toBe(200)
    expect(put.body.connection_flow_config).toMatchObject({
      connection_id: a,
      welcome_flow_id: f1,
      default_response_flow_id: f2,
      default_response_delay_hours: 48,
      finished_conversation_flow_id: null,
      status: 'incomplete',
      filled: 2,
      keyword_triggers: [
        { flow_id: f3, rule_type: 'all', conditions: [{ keyword: 'quero', match_type: 'starts_with' }, { keyword: 'plano', match_type: 'contains' }], position: 0, active: true },
        { flow_id: f4, rule_type: 'any', conditions: [{ keyword: 'menu', match_type: 'equals' }], position: 1, active: true },
      ],
    })
    expect((await call(s, 'GET', `/api/connection-flow-configs/${a}`)).body.connection_flow_config.keyword_triggers).toHaveLength(2)
    expect((await call(s, 'GET', '/api/connection-flow-configs?status=incomplete')).body.items.map((i: Json) => i.connection_id)).toEqual([a])
    expect((await call(s, 'GET', '/api/connection-flow-configs?status=empty')).body.items.map((i: Json) => i.connection_id)).toEqual([b])

    // PUT sem os campos limpa (substituição completa).
    const cleared = await call(s, 'PUT', `/api/connection-flow-configs/${a}`, { welcome_flow_id: f1 })
    expect(cleared.body.connection_flow_config).toMatchObject({ default_response_flow_id: null, default_response_delay_hours: 24, keyword_triggers: [], filled: 1 })
    expect((await call(s, 'DELETE', `/api/connection-flow-configs/${a}`)).status).toBe(204)
    expect((await call(s, 'GET', `/api/connection-flow-configs/${a}`)).body.connection_flow_config).toMatchObject({ id: null, status: 'empty' })
  })

  it('validação 422 com paths; conexão ou fluxo de outra empresa → 404/422', async () => {
    const s = await signUp()
    const other = await signUp()
    const a = await connection(s, 'Conexão A')
    const foreignFlow = await flow(other)
    const res = await call(s, 'PUT', `/api/connection-flow-configs/${a}`, {
      welcome_flow_id: foreignFlow,
      default_response_delay_hours: 169,
      keyword_triggers: [{ flow_id: null, rule_type: 'xor', conditions: [{ keyword: ' ', match_type: 'regex' }] }, { flow_id: foreignFlow, conditions: [] }],
    })
    expect(res.status).toBe(422)
    expect(paths(res.body)).toEqual(
      expect.arrayContaining([
        'default_response_delay_hours',
        'welcome_flow_id',
        'keyword_triggers.0.rule_type',
        'keyword_triggers.0.flow_id',
        'keyword_triggers.0.conditions.0.keyword',
        'keyword_triggers.0.conditions.0.match_type',
        'keyword_triggers.1.conditions',
        'keyword_triggers.1.flow_id',
      ]),
    )
    for (const delay of [0, 1.5]) expect(paths((await call(s, 'PUT', `/api/connection-flow-configs/${a}`, { default_response_delay_hours: delay })).body)).toEqual(['default_response_delay_hours'])
    expect((await call(s, 'PUT', `/api/connection-flow-configs/${a}`, { default_response_delay_hours: 168 })).status).toBe(200)
    expect((await call(other, 'GET', `/api/connection-flow-configs/${a}`)).status).toBe(404)
    expect((await call(other, 'PUT', `/api/connection-flow-configs/${a}`, {})).status).toBe(404)
    expect((await call(s, 'GET', '/api/connection-flow-configs/nao-e-uuid')).status).toBe(404)
  })

  it('permissões settings.dispatch.view/edit/delete', async () => {
    const owner = await signUp()
    const a = await connection(owner, 'Conexão A')
    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member', permissionKeys: ['settings.view', 'settings.dispatch.view'] })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
    const member = { ...m, companyId: owner.companyId }
    expect((await call(member, 'GET', '/api/connection-flow-configs')).status).toBe(200)
    expect((await call(member, 'PUT', `/api/connection-flow-configs/${a}`, {})).status).toBe(403)
    expect((await call(member, 'POST', '/api/connection-flow-configs/bulk-update', { connection_ids: [a], connection_flow_config: {} })).status).toBe(403)
    expect((await call(member, 'DELETE', `/api/connection-flow-configs/${a}`)).status).toBe(403)
  })
})

describe('AC-T61-06 edição em massa', () => {
  it('keep não altera, clear anula, valor substitui; ausente = keep; tudo ou nada', async () => {
    const s = await signUp()
    const a = await connection(s, 'Conexão A')
    const b = await connection(s, 'Conexão B')
    const [f1, f2, f3] = [await flow(s, 'f1'), await flow(s, 'f2'), await flow(s, 'f3')]
    await call(s, 'PUT', `/api/connection-flow-configs/${a}`, {
      welcome_flow_id: f1,
      default_response_flow_id: f2,
      default_response_delay_hours: 10,
      keyword_triggers: [{ flow_id: f3, conditions: [{ keyword: 'oi' }] }],
    })
    const res = await call(s, 'POST', '/api/connection-flow-configs/bulk-update', {
      connection_ids: [a, b],
      connection_flow_config: { welcome_flow_id: 'keep', default_response_flow_id: 'clear', default_response_delay_hours: '__keep__', finished_conversation_flow_id: f3 },
    })
    expect(res.status).toBe(200)
    const byConn = Object.fromEntries((res.body.items as Json[]).map((i) => [i.connection_id, i]))
    expect(byConn[a]).toMatchObject({ welcome_flow_id: f1, default_response_flow_id: null, default_response_delay_hours: 10, finished_conversation_flow_id: f3, finished_attendance_flow_id: null })
    expect(byConn[a].keyword_triggers).toHaveLength(1)
    expect(byConn[b]).toMatchObject({ welcome_flow_id: null, default_response_flow_id: null, default_response_delay_hours: 24, finished_conversation_flow_id: f3 })

    const clear = await call(s, 'POST', '/api/connection-flow-configs/bulk-update', {
      connection_ids: [a],
      connection_flow_config: { welcome_flow_id: '__clear__', default_response_delay_hours: 'clear', keyword_triggers: 'clear' },
    })
    expect(clear.body.items[0]).toMatchObject({ welcome_flow_id: null, default_response_delay_hours: 24, finished_conversation_flow_id: f3, keyword_triggers: [] })

    // Uma conexão inválida (ou fluxo inexistente) → 422 e nada muda.
    const other = await signUp()
    const foreign = await connection(other, 'Conexão X')
    const bad = await call(s, 'POST', '/api/connection-flow-configs/bulk-update', { connection_ids: [a, foreign], connection_flow_config: { welcome_flow_id: f1 } })
    expect(bad.status).toBe(422)
    expect(paths(bad.body)).toContain('connection_ids')
    const badFlow = await call(s, 'POST', '/api/connection-flow-configs/bulk-update', { connection_ids: [a], connection_flow_config: { welcome_flow_id: randomUUIDLike() } })
    expect(paths(badFlow.body)).toEqual(['connection_flow_config.welcome_flow_id'])
    expect((await call(s, 'GET', `/api/connection-flow-configs/${a}`)).body.connection_flow_config.welcome_flow_id).toBeNull()
  })
})

describe('referências de fluxo (T28)', () => {
  it('DELETE /api/flows/:id → 409 enquanto uma conexão aponta para o fluxo (fixo ou palavra-chave)', async () => {
    const s = await signUp()
    const a = await connection(s, 'Loja Centro')
    const [f1, f2] = [await flow(s, 'f1'), await flow(s, 'f2')]
    await call(s, 'PUT', `/api/connection-flow-configs/${a}`, { welcome_flow_id: f1, keyword_triggers: [{ flow_id: f2, conditions: [{ keyword: 'menu' }] }] })
    for (const f of [f1, f2]) {
      const del = await call(s, 'DELETE', `/api/flows/${f}`)
      expect(del.status).toBe(409)
      expect(del.body.error.code).toBe('CONFLICT')
      expect(del.body.error.details.references).toEqual([expect.objectContaining({ kind: 'connection_flow_config', name: 'Loja Centro' })])
    }
    await call(s, 'DELETE', `/api/connection-flow-configs/${a}`)
    expect((await call(s, 'DELETE', `/api/flows/${f1}`)).status).toBe(200)
  })
})

function randomUUIDLike(): string {
  return '00000000-0000-4000-8000-0000000000aa'
}

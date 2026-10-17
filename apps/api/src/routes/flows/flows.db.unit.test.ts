// Rotas do editor de fluxos por HTTP (app.request), com Postgres real.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessHourConfigs, companyMembers, connectionFlowConfigs, connections, createDb, flowEdges, flowVersions, keywordTriggers, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { createApp, type RedisClient } from '../../app'
import { registerFlowReferenceSource } from './impact'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const JSON_H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Who {
  cookie: string
  companyId: string
  userId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...JSON_H, cookie: who.cookie, 'x-company-id': who.companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function login(email: string): Promise<{ cookie: string; body: Json }> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...JSON_H, 'x-forwarded-for': `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  return { cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`, body: (await res.json()) as Json }
}

async function register(): Promise<Who> {
  const email = `f${rnd()}@x.com`
  await app.request('/api/auth/register', {
    method: 'POST',
    headers: JSON_H,
    body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }),
  })
  const { cookie, body } = await login(email)
  return { cookie, companyId: body.companies[0].id, userId: body.user.id }
}

/** Membro da empresa de `of` só com as chaves dadas. */
async function memberWith(of: Who, keys: string[]): Promise<Who> {
  const other = await register()
  await db.insert(companyMembers).values({ companyId: of.companyId, userId: other.userId, role: 'member', permissionKeys: keys })
  return { ...other, companyId: of.companyId }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer({ from: 'no-reply@example.com' }), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

const newFlow = async (a: Who, name = 'Fluxo') => (await call(a, 'POST', '/api/flows', { name })).body.flow as Json

describe('fluxos', () => {
  it('cria como rascunho com o Início; activate inválido → 422 por nó; válido → active + versão', async () => {
    const a = await register()
    const flow = await newFlow(a)
    expect(flow).toMatchObject({ status: 'draft', nodes_count: 1, published_version: null })
    const empty = await call(a, 'POST', `/api/flows/${flow.id}/activate`)
    expect(empty.status).toBe(422)
    expect(empty.body.error.details.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'no_node_after_start', nodeId: 'start' })]))

    expect((await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id: 'm1', type: 'message', position: { x: 1, y: 2 }, actions: [{ type: 'send_message', config: { message_text: 'Oi' } }] })).status).toBe(201)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'start', handle: 'source', to: 'm1' })).status).toBe(200)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/validate`)).body).toEqual({ valid: true, errors: [] })
    const ok = await call(a, 'POST', `/api/flows/${flow.id}/activate`)
    expect(ok.status).toBe(200)
    expect(ok.body.flow).toMatchObject({ status: 'active', published_version: 1 })
    expect(await db.select().from(flowVersions).where(eq(flowVersions.flowId, flow.id))).toHaveLength(1)
    expect((await call(a, 'GET', '/api/flows/names?triggerable=1')).body.items).toEqual([{ id: flow.id, name: 'Fluxo' }])
  })

  it('conexão no mesmo handle substitui a anterior; excluir nó leva as arestas; o Início não sai', async () => {
    const a = await register()
    const flow = await newFlow(a)
    for (const id of ['a', 'b']) await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id, type: 'message', position: { x: 0, y: 0 } })
    const first = await call(a, 'POST', `/api/flows/${flow.id}/connections`, { id: 'e1', from: 'start', handle: 'source', to: 'a' })
    expect(first.body).toEqual({ edge: { id: 'e1', from: 'start', handle: 'source', to: 'a' }, replaced_edge_id: null })
    const second = await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'start', handle: 'source', to: 'b' })
    expect(second.body.replaced_edge_id).toBe('e1')
    expect(await db.select().from(flowEdges).where(eq(flowEdges.flowId, flow.id))).toHaveLength(1)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'a', handle: 'source', to: 'start' })).status).toBe(422)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'a', handle: 'option-0', to: 'b' })).status).toBe(422)

    const del = await call(a, 'DELETE', `/api/flows/${flow.id}/nodes/b`)
    expect(del.body).toEqual({ deleted: true, removed_edge_ids: [second.body.edge.id] })
    expect((await call(a, 'DELETE', `/api/flows/${flow.id}/nodes/start`)).status).toBe(409)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id: 'a', type: 'message', position: { x: 0, y: 0 } })).status).toBe(409)

    expect((await call(a, 'POST', `/api/flows/${flow.id}/nodes/positions`, { positions: [{ id: 'a', x: 10, y: 20 }, { id: 'zz', x: 0, y: 0 }] })).body).toEqual({ updated: 1 })
    const act = await call(a, 'POST', `/api/flows/${flow.id}/nodes/a/actions`, { type: 'send_message', config: { message_text: 'x' } })
    expect(act.body.action).toMatchObject({ type: 'send_message', order: 0 })
    const bundle = await call(a, 'GET', `/api/flows/${flow.id}/editor-bundle`)
    expect(bundle.body.definition.nodes.find((n: Json) => n.id === 'a')).toMatchObject({ position: { x: 10, y: 20 }, actions: [{ id: act.body.action.id }] })
  })

  it('só flows.view: lê e valida, mas toda mutação → 403; outra empresa → 404', async () => {
    const a = await register()
    const flow = await newFlow(a)
    const viewer = await memberWith(a, ['flows.view'])
    expect((await call(viewer, 'GET', `/api/flows/${flow.id}/editor-bundle`)).status).toBe(200)
    expect((await call(viewer, 'POST', `/api/flows/${flow.id}/validate`)).status).toBe(200)
    for (const [m, p, b] of [
      ['POST', '/api/flows', { name: 'x' }],
      ['PATCH', `/api/flows/${flow.id}`, { name: 'y' }],
      ['POST', `/api/flows/${flow.id}/nodes`, { type: 'message', position: { x: 0, y: 0 } }],
      ['POST', `/api/flows/${flow.id}/duplicate`, undefined],
      ['DELETE', `/api/flows/${flow.id}`, undefined],
      ['POST', '/api/flow-folders', { name: 'p' }],
    ] as const)
      expect((await call(viewer, m, p, b)).status, `${m} ${p}`).toBe(403)
    const stranger = await register()
    expect((await call(stranger, 'GET', `/api/flows/${flow.id}`)).status).toBe(404)
  })

  it('duplicate copia o grafo com ids novos e status draft', async () => {
    const a = await register()
    const flow = await newFlow(a, 'Original')
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id: 'm', type: 'message', position: { x: 5, y: 6 }, actions: [{ id: 'act', type: 'send_message', config: { message_text: 'Oi' } }] })
    await call(a, 'POST', `/api/flows/${flow.id}/connections`, { id: 'e', from: 'start', handle: 'source', to: 'm' })
    const copy = await call(a, 'POST', `/api/flows/${flow.id}/duplicate`)
    expect(copy.status).toBe(201)
    expect(copy.body.flow).toMatchObject({ name: 'Original (cópia)', status: 'draft' })
    const def = (await call(a, 'GET', `/api/flows/${copy.body.flow.id}/editor-bundle`)).body.definition
    expect(def.nodes.map((n: Json) => n.id)).not.toContain('m')
    const m = def.nodes.find((n: Json) => n.type === 'message')
    expect(m).toMatchObject({ position: { x: 5, y: 6 }, actions: [{ type: 'send_message', config: { message_text: 'Oi' } }] })
    expect(m.actions[0].id).not.toBe('act')
    expect(def.edges).toEqual([{ id: expect.not.stringMatching(/^e$/), from: def.entry, handle: 'source', to: m.id }])
  })

  it('deletion-impact e 409 ao excluir fluxo usado por config de conexão', async () => {
    const a = await register()
    const flow = await newFlow(a, 'Alvo')
    const caller = await newFlow(a, 'Chamador')
    await call(a, 'POST', `/api/flows/${caller.id}/nodes`, { id: 'j', type: 'connection_flow', position: { x: 0, y: 0 }, actions: [{ type: 'execute_flow', config: { target_flow_id: flow.id } }] })
    const off = registerFlowReferenceSource((_ctx, id) => (id === flow.id ? [{ kind: 'connection_flow_config', id: 'cfg1', name: 'Conexão 1' }] : []))
    try {
      const impact = await call(a, 'GET', `/api/flows/${flow.id}/deletion-impact`)
      expect(impact.body).toMatchObject({
        active_runs: 0,
        total_runs: 0,
        connection_flow_configs: [{ kind: 'connection_flow_config', id: 'cfg1' }],
        referenced_by_flows: [{ id: caller.id, name: 'Chamador', node_ids: ['j'] }],
      })
      const del = await call(a, 'DELETE', `/api/flows/${flow.id}`)
      expect(del.status).toBe(409)
      expect(del.body.error.details.references).toEqual([{ kind: 'connection_flow_config', id: 'cfg1', name: 'Conexão 1' }])
    } finally {
      off()
    }
    expect((await call(a, 'DELETE', `/api/flows/${flow.id}`)).status).toBe(200)
  })
})

describe('exclusão forçada (T44)', () => {
  it('409 lista as configs afetadas; ?force=1 desvincula, desativa o horário e exclui', async () => {
    const a = await register()
    const flow = await newFlow(a, 'Boas-vindas')
    const [conn] = await db.insert(connections).values({ companyId: a.companyId, sessionId: `s-${rnd()}`, name: 'Loja' }).returning()
    const [cfg] = await db.insert(connectionFlowConfigs).values({ companyId: a.companyId, connectionId: conn!.id, welcomeFlowId: flow.id }).returning()
    await db.insert(keywordTriggers).values({ companyId: a.companyId, configId: cfg!.id, flowId: flow.id, conditions: [{ keyword: 'oi', match_type: 'equals' }] })
    const [hours] = await db
      .insert(businessHourConfigs)
      .values({ companyId: a.companyId, connectionId: conn!.id, active: true, actionType: 'flow', flowId: flow.id })
      .returning()

    const del = await call(a, 'DELETE', `/api/flows/${flow.id}`)
    expect(del.status).toBe(409)
    expect(del.body.error.details).toMatchObject({
      error_code: 'flow_referenced',
      connection_flow_configs: [{ kind: 'connection_flow_config', id: cfg!.id, name: 'Loja' }],
      business_hour_configs: [{ kind: 'business_hour_config', id: hours!.id }],
    })

    const forced = await call(a, 'DELETE', `/api/flows/${flow.id}?force=1`)
    expect(forced.status).toBe(200)
    expect(forced.body).toEqual({ deleted: true, detached: { connection_flow_configs: [cfg!.id], business_hour_configs: [hours!.id] } })
    expect((await call(a, 'GET', `/api/flows/${flow.id}`)).status).toBe(404)
    const [cfgAfter] = await db.select().from(connectionFlowConfigs).where(eq(connectionFlowConfigs.id, cfg!.id))
    expect(cfgAfter!.welcomeFlowId).toBeNull()
    const [hoursAfter] = await db.select().from(businessHourConfigs).where(eq(businessHourConfigs.id, hours!.id))
    expect(hoursAfter).toMatchObject({ flowId: null, active: false })
  })

  it('?force=1 sem referências exclui normalmente', async () => {
    const a = await register()
    const flow = await newFlow(a, 'Solto')
    expect(await call(a, 'DELETE', `/api/flows/${flow.id}?force=1`)).toEqual({ status: 200, body: { deleted: true } })
  })
})

describe('pastas', () => {
  it('mover para descendente → 409; excluir pasta leva fluxos e subpastas para a raiz', async () => {
    const a = await register()
    const parent = (await call(a, 'POST', '/api/flow-folders', { name: 'Pai' })).body.folder
    const child = (await call(a, 'POST', '/api/flow-folders', { name: 'Filha', parent_id: parent.id })).body.folder
    expect((await call(a, 'POST', `/api/flow-folders/${parent.id}/move`, { parent_id: child.id })).status).toBe(409)
    const flow = (await call(a, 'POST', '/api/flows', { name: 'Na pasta', folder_id: parent.id })).body.flow
    expect((await call(a, 'DELETE', `/api/flow-folders/${parent.id}`)).status).toBe(200)
    expect((await call(a, 'GET', `/api/flows/${flow.id}`)).body.flow.folder_id).toBeNull()
    expect((await call(a, 'GET', '/api/flow-folders')).body.items).toEqual([expect.objectContaining({ id: child.id, parent_id: null })])
    const moved = await call(a, 'POST', `/api/flows/${flow.id}/move`, { folder_id: child.id })
    expect(moved.body.flow.folder_id).toBe(child.id)
  })
})

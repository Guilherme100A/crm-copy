// POST /api/flows/:id/simulate (T82) por HTTP (app.request), Postgres real: rascunho em dry-run, nada gravado.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyMembers, createDb, flowRunSteps, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const gateway = new FakeWaGateway()

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
interface Who {
  cookie: string
  companyId: string
  userId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...H, cookie: who.cookie, 'x-company-id': who.companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function owner(): Promise<Who> {
  const email = `s${rnd()}@x.com`
  await app.request('/api/auth/register', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }),
  })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, 'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  const body = (await res.json()) as Json
  return {
    cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`,
    companyId: body.companies[0].id,
    userId: body.user.id,
  }
}

/** Rascunho start → mensagem → menu (opção o1 → mensagem final). */
async function draftFlow(a: Who) {
  const flow = (await call(a, 'POST', '/api/flows', { name: `S${rnd()}` })).body.flow
  const bundle = (await call(a, 'GET', `/api/flows/${flow.id}/editor-bundle`)).body
  const start = bundle.definition.entry as string
  const node = (id: string, type: string, actions: Json[]) => ({
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    actions: actions.map((x, i) => ({ id: `${id}-${i}`, order: i, ...x })),
  })
  const startNode = bundle.definition.nodes.find((n: Json) => n.id === start)
  const definition = {
    ...bundle.definition,
    nodes: [
      startNode,
      node('hello', 'message', [{ type: 'send_message', config: { message_text: 'Olá!' } }]),
      node('menu', 'interactive_menu', [
        { type: 'send_interactive_menu', config: { message: 'Escolha', options: [{ id: 'o1', title: 'Vendas' }] } },
      ]),
      node('bye', 'message', [{ type: 'send_message', config: { message_text: 'Até logo' } }]),
    ],
    edges: [
      { id: 'e1', from: start, handle: 'source', to: 'hello' },
      { id: 'e2', from: 'hello', handle: 'source', to: 'menu' },
      { id: 'e3', from: 'menu', handle: 'option:o1', to: 'bye' },
    ],
  }
  const put = await call(a, 'PUT', `/api/flows/${flow.id}/definition`, definition)
  expect(put.status).toBe(200)
  return flow as Json
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer({ from: 'no-reply@example.com' }),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    waGateway: gateway,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('POST /api/flows/:id/simulate', () => {
  it('AC-T82-01 roda o rascunho, devolve transcrição e caminho, sem gravar runs nem chamar o gateway', async () => {
    const a = await owner()
    const flow = await draftFlow(a)
    const r = await call(a, 'POST', `/api/flows/${flow.id}/simulate`, {})
    expect(r.status).toBe(200)
    const sim = r.body.simulation
    expect(sim.status).toBe('waiting')
    expect(sim.steps.map((s: Json) => s.node_key).slice(1)).toEqual(['hello', 'menu'])
    expect(sim.messages[0]).toMatchObject({ node_key: 'hello', kind: 'text', text: 'Olá!' })
    expect(sim.wait).toMatchObject({
      node_key: 'menu',
      kind: 'menu',
      choices: [{ handle: 'option:o1', label: 'Vendas', connected: true }, { handle: 'other' }, { handle: 'timeout' }],
    })

    const next = await call(a, 'POST', `/api/flows/${flow.id}/simulate`, {
      resume: { node_key: 'menu', handle: 'option:o1' },
      vars: sim.vars,
      steps_so_far: sim.steps_total,
    })
    expect(next.status).toBe(200)
    expect(next.body.simulation).toMatchObject({
      status: 'finished',
      steps: [{ node_key: 'bye', seq: 4 }],
      messages: [{ text: 'Até logo' }],
    })

    expect(await db.select().from(flowRuns).where(eq(flowRuns.companyId, a.companyId))).toEqual([])
    expect(await db.select().from(flowRunSteps).where(eq(flowRunSteps.companyId, a.companyId))).toEqual([])
    expect(gateway.sent).toEqual([])
  })

  it('fluxo de outra empresa → 404; corpo inválido ou handle inexistente → 422', async () => {
    const a = await owner()
    const flow = await draftFlow(a)
    const b = await owner()
    expect((await call(b, 'POST', `/api/flows/${flow.id}/simulate`, {})).status).toBe(404)
    expect((await call(a, 'POST', `/api/flows/${crypto.randomUUID()}/simulate`, {})).status).toBe(404)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/simulate`, { steps_so_far: -1 })).status).toBe(422)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/simulate`, { resume: { node_key: 'menu' } })).status).toBe(422)
    const bad = await call(a, 'POST', `/api/flows/${flow.id}/simulate`, {
      resume: { node_key: 'menu', handle: 'success' },
    })
    expect([bad.status, bad.body.error.details.fields[0].path]).toEqual([422, 'resume.handle'])
  })

  it('member só com flows.view simula (simular não grava)', async () => {
    const a = await owner()
    const flow = await draftFlow(a)
    const viewer = await owner()
    await db
      .insert(companyMembers)
      .values({ companyId: a.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['flows.view'] })
    expect(
      (await call({ ...viewer, companyId: a.companyId }, 'POST', `/api/flows/${flow.id}/simulate`, {})).status,
    ).toBe(200)
  })
})

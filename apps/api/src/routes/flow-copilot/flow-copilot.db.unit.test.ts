// Rotas do assistente de fluxo (T93) com Postgres e Redis reais, UsageGuard real e FakeLlm (nunca LLM real).
import { randomBytes } from 'node:crypto'
import { aiWallets, companyMembers, createDb, ensureDefaultAiPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeLlm, text, toolCall } from '@crm/ai/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let llm = new FakeLlm()
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const events: { type: string; data: Json; userId?: string }[] = []

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `fc-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.93.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'F', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId) =>
  app.request(path, {
    method,
    headers: { ...H, cookie: s.cookie, 'x-company-id': companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  await ensureDefaultAiPrices(db)
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    // delega ao FakeLlm da vez (cada teste troca o roteiro)
    flowCopilotLlm: { generate: (req) => llm.generate(req) },
    flowCopilotPublisher: {
      publish: async (_c, type, data, opts) => void events.push({ type, data, userId: opts?.userId }),
    },
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function owner(balance = 100) {
  const s = await signUp()
  if (balance) await db.insert(aiWallets).values({ companyId: s.companyId, balanceCredits: balance, status: 'ok' })
  const flow = (await json(await call(s, 'POST', '/api/flows', { name: `Fluxo ${rnd()}` }))).flow as Json
  const session = (await json(await call(s, 'POST', '/api/flow-copilot/sessions', { flow_id: flow.id })))
    .session as Json
  return { s, flow, session }
}

const definition = async (s: Session, flowId: string) =>
  (await json(await call(s, 'GET', `/api/flows/${flowId}/editor-bundle`))).definition as Json

describe('AC-T93-01 sessões e mensagens', () => {
  it('AC-T93-01: GET|POST sessions, mensagens, arquivar/reabrir, SSE copilot.delta/completed; outra empresa → 404', async () => {
    const { s, flow, session } = await owner()
    expect(session).toMatchObject({ flow_id: flow.id, status: 'active' })
    const list = await json(await call(s, 'GET', `/api/flow-copilot/sessions?flow_id=${flow.id}`))
    expect(list.items.map((x: Json) => x.id)).toEqual([session.id])
    expect(list.can_edit).toBe(true)

    llm = new FakeLlm([text('Olá! Como posso ajudar no fluxo?')])
    const res = await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, {
      content: 'oi',
      client_message_id: 'm1',
    })
    expect(res.status).toBe(201)
    const turn = await json(res)
    expect(turn.message).toMatchObject({ role: 'user', content: 'oi' })
    expect(turn.reply).toMatchObject({
      role: 'assistant',
      content: 'Olá! Como posso ajudar no fluxo?',
      status: 'completed',
    })
    const msgs = await json(await call(s, 'GET', `/api/flow-copilot/sessions/${session.id}/messages`))
    expect(msgs.items.map((m: Json) => m.role)).toEqual(['user', 'assistant'])
    const mine = events.filter((e) => e.data.session_id === session.id)
    expect(
      mine
        .filter((e) => e.type === 'copilot.delta')
        .map((e) => e.data.delta)
        .join(''),
    ).toBe('Olá! Como posso ajudar no fluxo?')
    expect(mine.at(-1)).toMatchObject({
      type: 'copilot.completed',
      userId: s.userId,
      data: { status: 'completed', message_id: turn.reply.id },
    })

    expect((await json(await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/archive`))).session.status).toBe(
      'archived',
    )
    const blocked = await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, { content: 'oi' })
    expect(blocked.status).toBe(409)
    expect((await json(await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/reopen`))).session.status).toBe(
      'active',
    )
    expect((await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, { content: '' })).status).toBe(
      422,
    )

    const stranger = await signUp()
    expect((await call(stranger, 'GET', `/api/flow-copilot/sessions/${session.id}`)).status).toBe(404)
    expect((await call(stranger, 'POST', '/api/flow-copilot/sessions', { flow_id: flow.id })).status).toBe(404)
    expect((await call(stranger, 'GET', `/api/flow-copilot/sessions?flow_id=${flow.id}`)).status).toBe(404)
  })
})

describe('AC-T93-02/03 edições', () => {
  it('AC-T93-02/03: create_node válido grava e publica graph_updated source ai; inválido volta como erro e não grava', async () => {
    const { s, flow, session } = await owner()
    const before = await definition(s, flow.id)
    llm = new FakeLlm([
      toolCall('create_node', {
        type: 'message',
        actions: [{ type: 'send_message', config: {} }],
        connect_from: { node_id: before.entry, handle: 'source' },
      }),
      toolCall('create_node', {
        type: 'message',
        name: 'Boas-vindas',
        actions: [{ type: 'send_message', config: { message_text: 'Oi!' } }],
        connect_from: { node_id: before.entry, handle: 'source' },
      }),
      text('Criei a mensagem.'),
    ])
    const turn = await json(
      await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, { content: 'crie uma boas-vindas' }),
    )
    expect(turn.reply.tool_calls.map((t: Json) => t.ok)).toEqual([false, true])
    expect(turn.reply.tool_calls[0].output).toMatch(/invalid_action_config/)
    expect(turn.graph_changed).toBe(true)
    const after = await definition(s, flow.id)
    expect(after.nodes.map((n: Json) => n.name)).toEqual([...before.nodes.map((n: Json) => n.name), 'Boas-vindas'])
    const graph = events.filter((e) => e.type === 'flow.graph_updated' && e.data.flow_id === flow.id)
    expect(graph).toEqual([
      {
        type: 'flow.graph_updated',
        data: { flow_id: flow.id, actor_id: null, mutation: 'add_node', source: 'ai', session_id: session.id },
        userId: undefined,
      },
    ])
  })
})

describe('AC-T93-04 cota', () => {
  it('AC-T93-04: sem saldo → 429 e sessão paused_quota; resume 429 sem saldo e 200 com saldo', async () => {
    const { s, session } = await owner(0)
    llm = new FakeLlm([text('oi')])
    const res = await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, { content: 'oi' })
    expect(res.status).toBe(429)
    expect((await json(res)).error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { reason: 'paused_quota' } })
    expect((await json(await call(s, 'GET', `/api/flow-copilot/sessions/${session.id}`))).session.status).toBe(
      'paused_quota',
    )
    expect(llm.callCount).toBe(0)
    expect((await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/resume`)).status).toBe(429)
    await db.insert(aiWallets).values({ companyId: s.companyId, balanceCredits: 50, status: 'ok' })
    const resumed = await call(s, 'POST', `/api/flow-copilot/sessions/${session.id}/resume`, {})
    expect(resumed.status).toBe(200)
    expect((await json(resumed)).session.status).toBe('active')
  })
})

describe('AC-T93-05 permissão', () => {
  it('AC-T93-05: membro só com flows.view conversa, mas sem ferramentas de escrita; sem flows.view → 403', async () => {
    const { s, flow } = await owner()
    const viewer = await signUp()
    await db
      .insert(companyMembers)
      .values({ companyId: s.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['flows.view'] })
    const list = await json(
      await call(viewer, 'GET', `/api/flow-copilot/sessions?flow_id=${flow.id}`, undefined, s.companyId),
    )
    expect(list).toMatchObject({ items: [], can_edit: false, tools: ['get_flow', 'list_block_types'] })
    const session = (
      await json(await call(viewer, 'POST', '/api/flow-copilot/sessions', { flow_id: flow.id }, s.companyId))
    ).session as Json
    const before = await definition(s, flow.id)
    llm = new FakeLlm([toolCall('create_node', { type: 'message' }), text('Sem permissão para editar.')])
    const turn = await json(
      await call(viewer, 'POST', `/api/flow-copilot/sessions/${session.id}/messages`, { content: 'crie' }, s.companyId),
    )
    expect(llm.calls[0]!.tools!.map((t) => t.name)).toEqual(['get_flow', 'list_block_types'])
    expect(turn.reply.status).toBe('completed')
    expect(await definition(s, flow.id)).toEqual(before)
    // a sessão é do usuário: o dono não a enxerga
    expect((await call(s, 'GET', `/api/flow-copilot/sessions/${session.id}`)).status).toBe(404)

    const none = await signUp()
    await db
      .insert(companyMembers)
      .values({ companyId: s.companyId, userId: none.userId, role: 'member', permissionKeys: ['chat.view'] })
    expect(
      (await call(none, 'GET', `/api/flow-copilot/sessions?flow_id=${flow.id}`, undefined, s.companyId)).status,
    ).toBe(403)
  })
})

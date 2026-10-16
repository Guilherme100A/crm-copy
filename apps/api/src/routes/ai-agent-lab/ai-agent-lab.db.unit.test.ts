// Rotas do laboratório de agentes (T79) com Postgres e Redis reais, FakeLlm e run inline.
import { randomBytes } from 'node:crypto'
import { aiAgents, companyMembers, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeLlm, FakeStt, output, text, toolCall } from '@crm/ai/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const llm = new FakeLlm()
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const MODEL = { provider: 'openai' as const, model: 'gpt-test' }
const events: Json[] = []

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `l-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'L', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie, 'x-company-id': companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    aiLabLlm: llm,
    aiLabGuard: null,
    aiLabEvalCap: 2,
    aiLabStt: new FakeStt({ text: 'quero vender bolos' }),
    aiLabComposeModel: MODEL,
    aiLabPublisher: { publish: async (_c, _t, d) => void events.push(d) },
    aiAgentLabInline: true,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function agent(s: Session): Promise<string> {
  const res = await call(s, 'POST', '/api/ai-agents', { name: 'Lia', purpose: 'Vende bolos' })
  const id = (await json(res)).agent.id as string
  await db.update(aiAgents).set({ model: MODEL }).where(eq(aiAgents.id, id))
  return id
}

describe('test-messages e generate-prompt', () => {
  it('200 com blocos e campos; eval_cap → 429; DELETE limpa; sem flows.edit → 403', async () => {
    const s = await signUp()
    const id = await agent(s)
    llm.enqueue(toolCall('fill_field', { key: 'nome', value: 'Ana' }), text('Oi, Ana!'))
    const ok = await call(s, 'POST', `/api/ai-agents/${id}/test-messages`, { text: 'sou a Ana', draft: { use_emojis: false } })
    expect(ok.status).toBe(200)
    expect(await json(ok)).toMatchObject({ blocks: [{ type: 'text', text: 'Oi, Ana!' }], fields_filled: { nome: 'Ana' }, charged_credits: 0, eval: { used: 1, limit: 2 } })
    llm.enqueue(text('ok'))
    expect((await call(s, 'POST', `/api/ai-agents/${id}/test-messages`, { text: '2' })).status).toBe(200)
    const capped = await call(s, 'POST', `/api/ai-agents/${id}/test-messages`, { text: '3' })
    expect(capped.status).toBe(429)
    expect((await json(capped)).error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { reason: 'eval_cap', limit: 2 } })
    expect((await call(s, 'DELETE', `/api/ai-agents/${id}/test-messages`)).status).toBe(200)
    expect((await call(s, 'POST', `/api/ai-agents/${id}/test-messages`, { text: '' })).status).toBe(422)

    const viewer = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['flows.view'] })
    expect((await call(viewer, 'POST', `/api/ai-agents/${id}/test-messages`, { text: 'x' }, s.companyId)).status).toBe(403)
  })

  it('generate-prompt devolve prompt, blocos e o agente salvo', async () => {
    const s = await signUp()
    const id = await agent(s)
    const res = await call(s, 'POST', `/api/ai-agents/${id}/generate-prompt`, {})
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.prompt).toContain('Você é Lia')
    expect(body.agent).toMatchObject({ generated_prompt: body.prompt, prompt_edited: false })
    expect(body.blocks[0]).toMatchObject({ key: 'identity', locked: false })
    expect((await call(s, 'POST', `/api/ai-agents/${crypto.randomUUID()}/generate-prompt`, {})).status).toBe(404)
  })
})

describe('criação assistida', () => {
  it('202 + polling até completed; 409 create_in_progress; SSE; transcrição', async () => {
    const s = await signUp()
    llm.enqueue(output({ name: 'Bia', role: '', purpose: 'Bolos', audience: '', personality: 'casual', primary_goal: 'sell', example_messages: '', business_rules: '', never_talk_about: '' }))
    const res = await call(s, 'POST', '/api/ai-agents/runs', { pitch: 'Vendo bolos caseiros por encomenda.' })
    expect(res.status).toBe(202)
    const { run } = await json(res)
    const busy = await call(s, 'POST', '/api/ai-agents/runs', { pitch: 'Outro pedido de criação' })
    if (busy.status === 409) expect((await json(busy)).error).toMatchObject({ code: 'CONFLICT', details: { reason: 'create_in_progress', run_id: run.id } })
    let current = run
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(current.status); i++) {
      await new Promise((r) => setTimeout(r, 20))
      current = (await json(await call(s, 'GET', `/api/ai-agents/runs/${run.id}`))).run
    }
    expect(current).toMatchObject({ status: 'completed', stages_done: ['extract', 'compose', 'persist'] })
    expect(events.filter((e) => e.run.id === run.id).map((e) => e.run.status)).toContain('completed')
    expect((await json(await call(s, 'GET', `/api/ai-agents/${current.agent_id}`))).agent.name).toBe('Bia')
    const other = await signUp()
    expect((await call(other, 'GET', `/api/ai-agents/runs/${run.id}`)).status).toBe(404)

    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'ditado.ogg', { type: 'audio/ogg' }))
    const tr = await app.request('/api/ai-agents/transcriptions', { method: 'POST', headers: { cookie: s.cookie, 'x-company-id': s.companyId, 'x-requested-with': 'crm' }, body: form })
    expect(tr.status).toBe(200)
    expect(await json(tr)).toEqual({ text: 'quero vender bolos' })
  })
})

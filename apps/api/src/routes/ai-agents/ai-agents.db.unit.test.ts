import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_SETTINGS_DEFAULTS } from '@crm/core'
import { chats, companies, companyMembers, connections, contacts, createDb, flowNodeActions, flowNodes, flows, llmPrices, platformSettings, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let storage: string
let app: ReturnType<typeof createApp>
const configured = new Set(['anthropic'])
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `a-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'A', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  storage = await mkdtemp(join(tmpdir(), 't39-'))
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storage),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    aiProviderKeys: { isConfigured: ({ provider }) => configured.has(provider) },
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  await rm(storage, { recursive: true, force: true })
})

describe('AC-T39-01 defaults e validação', () => {
  it('POST {} cria rascunho com settings padrão e 5 campos de coleta', async () => {
    const s = await signUp()
    const res = await call(s, 'POST', '/api/ai-agents', {})
    expect(res.status).toBe(201)
    const { agent } = await json(res)
    expect(agent).toMatchObject({ status: 'draft', name: 'Leo', avatar_key: 'leo-2', primary_goal: 'sell', personality: 'seller', model: null, resolved_model: null })
    expect(agent.settings).toEqual({ ...AGENT_SETTINGS_DEFAULTS })
    expect(agent.settings).toMatchObject({ buffer_enabled: true, buffer_seconds: 5, stall_limit: 12, engine: 'balanced', no_balance_action: 'none', pause_on_human: true })
    expect(agent.collection_fields.map((f: Json) => [f.key, f.enabled])).toEqual([
      ['nome', true],
      ['cidade', true],
      ['produto', true],
      ['email', false],
      ['recompra', false],
    ])
    // corpo vazio também cria em branco
    expect((await app.request('/api/ai-agents', { method: 'POST', headers: { 'x-requested-with': 'crm', cookie: s.cookie } })).status).toBe(201)
  })

  it('settings parciais são mescladas; inválidas → 422 com o campo', async () => {
    const s = await signUp()
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', { name: 'Ana', settings: { buffer_seconds: 9 } }))
    expect(agent.settings).toMatchObject({ buffer_seconds: 9, split_messages: true })
    const patched = await json(await call(s, 'PATCH', `/api/ai-agents/${agent.id}`, { settings: { sign_name: true } }))
    expect(patched.agent.settings).toMatchObject({ buffer_seconds: 9, sign_name: true })
    for (const [settings, path] of [
      [{ buffer_seconds: -1 }, 'settings.buffer_seconds'],
      [{ engine: 'turbo' }, 'settings.engine'],
    ] as const) {
      const res = await call(s, 'POST', '/api/ai-agents', { settings })
      expect(res.status).toBe(422)
      expect((await json(res)).error.details.fields.map((f: Json) => f.path)).toContain(path)
    }
    const badSkill = await call(s, 'POST', '/api/ai-agents', { skills: [{ action_type: 'trigger_flow', action_params: {} }] })
    expect(badSkill.status).toBe(422)
    expect((await json(badSkill)).error.details.fields[0].path).toBe('skills.0.action_params.flow_id')
  })
})

describe('AC-T39-02 publicar e pausar', () => {
  it('sem prompt ou sem modelo → 422; transições válidas e inválidas', async () => {
    const s = await signUp()
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', {}))
    const noPrompt = await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
    expect(noPrompt.status).toBe(422)
    expect((await json(noPrompt)).error.details.error_code).toBe('prompt_required')
    await call(s, 'PATCH', `/api/ai-agents/${agent.id}`, { generated_prompt: 'Você é o Leo.' })
    const noModel = await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
    expect(noModel.status).toBe(422)
    expect((await json(noModel)).error.details.error_code).toBe('model_required')

    expect((await call(s, 'POST', `/api/ai-agents/${agent.id}/pause`)).status).toBe(409) // draft → paused
    await call(s, 'PATCH', `/api/ai-agents/${agent.id}`, { model: { provider: 'anthropic', model: 'claude-x' } })
    const pub = await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
    expect(pub.status).toBe(200)
    expect((await json(pub)).agent.status).toBe('active')
    const again = await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
    expect(again.status).toBe(409)
    expect((await json(again)).error.code).toBe('INVALID_TRANSITION')
    expect((await json(await call(s, 'POST', `/api/ai-agents/${agent.id}/pause`))).agent.status).toBe('paused')
    expect((await call(s, 'POST', `/api/ai-agents/${agent.id}/pause`)).status).toBe(409)
    expect((await json(await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`))).agent.status).toBe('active')
  })

  it('preset da empresa e depois da plataforma resolvem o modelo', async () => {
    const s = await signUp()
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', { generated_prompt: 'p', settings: { engine: 'economy' } }))
    expect(agent.resolved_model).toBeNull()
    await db.insert(platformSettings).values({ key: 'ai_presets', value: { economy: { provider: 'anthropic', model: 'plataforma' } } }).onConflictDoNothing()
    expect((await json(await call(s, 'GET', `/api/ai-agents/${agent.id}`))).agent.resolved_model).toEqual({ provider: 'anthropic', model: 'plataforma' })
    await db
      .update(companies)
      .set({ settings: sql`jsonb_set(${companies.settings}, '{ai_presets}', '{"economy":{"provider":"anthropic","model":"empresa"}}'::jsonb)` })
      .where(eq(companies.id, s.companyId))
    expect((await json(await call(s, 'GET', `/api/ai-agents/${agent.id}`))).agent.resolved_model).toEqual({ provider: 'anthropic', model: 'empresa' })
    expect((await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)).status).toBe(200)
    await db.delete(platformSettings).where(eq(platformSettings.key, 'ai_presets'))
  })
})

describe('AC-T39-03 limite por empresa', () => {
  it('ilimitado por padrão; com limite atingido criar/duplicar → 409 LIMIT_REACHED', async () => {
    const s = await signUp()
    for (let i = 0; i < 5; i++) expect((await call(s, 'POST', '/api/ai-agents', {})).status).toBe(201)
    const list = await json(await call(s, 'GET', '/api/ai-agents'))
    expect(list.quota).toEqual({ used: 5, limit: null })
    await db.update(companies).set({ settings: sql`jsonb_set(${companies.settings}, '{limits}', '{"ai_agents": 5}'::jsonb)` }).where(eq(companies.id, s.companyId))
    const over = await call(s, 'POST', '/api/ai-agents', {})
    expect(over.status).toBe(409)
    expect((await json(over)).error.code).toBe('LIMIT_REACHED')
    const dup = await call(s, 'POST', `/api/ai-agents/${list.items[0].id}/duplicate`)
    expect(dup.status).toBe(409)
    expect((await json(dup)).error.code).toBe('LIMIT_REACHED')
    expect((await json(await call(s, 'GET', '/api/ai-agents'))).quota).toEqual({ used: 5, limit: 5 })
  })

  it('criações concorrentes não ultrapassam o limite', async () => {
    const s = await signUp()
    await db.update(companies).set({ settings: sql`jsonb_set(${companies.settings}, '{limits}', '{"ai_agents": 3}'::jsonb)` }).where(eq(companies.id, s.companyId))
    const statuses = await Promise.all(Array.from({ length: 6 }, async () => (await call(s, 'POST', '/api/ai-agents', {})).status))
    expect(statuses.filter((x) => x === 201)).toHaveLength(3)
    expect(statuses.filter((x) => x === 409)).toHaveLength(3)
  })
})

describe('AC-T39-04 duplicar', () => {
  it('copia settings, habilidades e campos; status draft', async () => {
    const s = await signUp()
    const flowId = '00000000-0000-4000-8000-0000000000f1'
    const body = {
      name: 'Vendedor',
      generated_prompt: 'p',
      model: { provider: 'anthropic', model: 'm' },
      settings: { stall_limit: 7 },
      skills: [
        { when_text: 'cliente quer falar com humano agora', action_type: 'transfer_human' },
        { when_text: 'pedir catálogo de produtos', action_type: 'trigger_flow', action_params: { flow_id: flowId, return_to_agent: true } },
      ],
      collection_fields: [{ key: 'nome', label: 'Nome' }, { key: 'cpf', label: 'CPF', enabled: false }],
    }
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', body))
    await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
    const res = await call(s, 'POST', `/api/ai-agents/${agent.id}/duplicate`)
    expect(res.status).toBe(201)
    const copy = (await json(res)).agent
    expect(copy.id).not.toBe(agent.id)
    expect(copy).toMatchObject({ status: 'draft', name: 'Vendedor (cópia)', generated_prompt: 'p', model: { provider: 'anthropic', model: 'm' } })
    expect(copy.settings).toEqual(agent.settings)
    const strip = (xs: Json[]) => xs.map(({ id: _id, ...rest }) => rest)
    expect(strip(copy.skills)).toEqual(strip(agent.skills))
    expect(strip(copy.collection_fields)).toEqual(strip(agent.collection_fields))
    expect(copy.skills[0].id).not.toBe(agent.skills[0].id)
  })
})

describe('AC-T39-05 excluir com referências', () => {
  it('fluxo e chat ativo → 409 com referências; force=1 exclui', async () => {
    const s = await signUp()
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', {}))
    const [flow] = await db.insert(flows).values({ companyId: s.companyId, name: 'Boas-vindas' }).returning({ id: flows.id })
    const [node] = await db.insert(flowNodes).values({ companyId: s.companyId, flowId: flow!.id, key: 'n1', type: 'ai_agent', name: 'Agente', positionX: 0, positionY: 0 }).returning({ id: flowNodes.id })
    await db.insert(flowNodeActions).values({ companyId: s.companyId, nodeId: node!.id, key: 'a1', type: 'control_ai_agent', config: { mode: 'activate', agent_id: agent.id } })
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Cli' }).returning({ id: contacts.id })
    // T40: chats.connection_id referencia crm.connections.
    const [connection] = await db.insert(connections).values({ companyId: s.companyId, sessionId: `sess-${rnd()}`, name: 'Conexão teste' }).returning({ id: connections.id })
    const [chat] = await db
      .insert(chats)
      .values({ companyId: s.companyId, connectionId: connection!.id, contactId: contact!.id, status: 'attending', aiAgentId: agent.id })
      .returning({ id: chats.id })

    const res = await call(s, 'DELETE', `/api/ai-agents/${agent.id}`)
    expect(res.status).toBe(409)
    const { error } = await json(res)
    expect(error.code).toBe('CONFLICT')
    expect(error.details.references).toEqual({ flows: [{ id: flow!.id, name: 'Boas-vindas' }], chats: [{ id: chat!.id }] })

    // chat resolvido não conta
    await db.update(chats).set({ status: 'resolved' }).where(eq(chats.id, chat!.id))
    expect((await json(await call(s, 'DELETE', `/api/ai-agents/${agent.id}`))).error.details.references.chats).toEqual([])

    const forced = await call(s, 'DELETE', `/api/ai-agents/${agent.id}?force=1`)
    expect(forced.status).toBe(200)
    expect((await call(s, 'GET', `/api/ai-agents/${agent.id}`)).status).toBe(404)
    const [after] = await db.select({ aiAgentId: chats.aiAgentId }).from(chats).where(eq(chats.id, chat!.id))
    expect(after!.aiAgentId).toBeNull()
  })

  it('sem referências exclui direto; outra empresa → 404', async () => {
    const a = await signUp()
    const b = await signUp()
    const { agent } = await json(await call(a, 'POST', '/api/ai-agents', {}))
    expect((await call(b, 'GET', `/api/ai-agents/${agent.id}`)).status).toBe(404)
    expect((await call(b, 'DELETE', `/api/ai-agents/${agent.id}`)).status).toBe(404)
    expect((await call(a, 'DELETE', `/api/ai-agents/${agent.id}`)).status).toBe(200)
  })
})

describe('AC-T39-06 provedor sem chave', () => {
  it('modelo de provedor sem chave → 422 provider_not_configured (criar, editar e publicar)', async () => {
    const s = await signUp()
    const create = await call(s, 'POST', '/api/ai-agents', { model: { provider: 'google', model: 'gemini' } })
    expect(create.status).toBe(422)
    expect((await json(create)).error.details).toMatchObject({ error_code: 'provider_not_configured', fields: [{ path: 'model' }] })
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', { generated_prompt: 'p', model: { provider: 'anthropic', model: 'm' } }))
    expect((await json(await call(s, 'PATCH', `/api/ai-agents/${agent.id}`, { model: { provider: 'openai', model: 'x' } }))).error.details.error_code).toBe(
      'provider_not_configured',
    )
    configured.delete('anthropic')
    try {
      const pub = await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`)
      expect(pub.status).toBe(422)
      expect((await json(pub)).error.details.error_code).toBe('provider_not_configured')
    } finally {
      configured.add('anthropic')
    }
  })
})

describe('permissões, avatar e mídia', () => {
  it('membro só com flows.view lê mas não edita', async () => {
    const owner = await signUp()
    const viewer = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['flows.view'] })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, viewer.userId))
    await call(owner, 'POST', '/api/ai-agents', {})
    const asViewer = { ...viewer, companyId: owner.companyId }
    const vh = { ...H, cookie: viewer.cookie, 'x-company-id': owner.companyId }
    expect((await app.request('/api/ai-agents', { headers: vh })).status).toBe(200)
    expect((await app.request('/api/ai-agents', { method: 'POST', headers: vh, body: '{}' })).status).toBe(403)
    expect(asViewer).toBeTruthy()
  })

  it('avatar jpeg/png/webp e mídias (≤ 8 arquivos)', async () => {
    const s = await signUp()
    const { agent } = await json(await call(s, 'POST', '/api/ai-agents', {}))
    const png = new Uint8Array(200)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const up = (path: string, field: string, bytes: Uint8Array, type: string, extra: Record<string, string> = {}) => {
      const form = new FormData()
      form.append(field, new File([bytes], 'f', { type }))
      for (const [k, v] of Object.entries(extra)) form.append(k, v)
      return app.request(path, { method: 'POST', headers: { cookie: s.cookie, 'x-requested-with': 'crm' }, body: form })
    }
    const av = await up(`/api/ai-agents/${agent.id}/avatar`, 'avatar', png, 'image/png')
    expect(av.status).toBe(200)
    expect((await json(av)).agent.avatar_url).toMatch(`/api/ai-agents/${agent.id}/avatar`)
    expect((await up(`/api/ai-agents/${agent.id}/avatar`, 'avatar', new Uint8Array([1, 2, 3]), 'image/png')).status).toBe(415)

    for (let i = 0; i < 8; i++) expect((await up(`/api/ai-agents/${agent.id}/media`, 'file', png, 'image/png', { title: `t${i}` })).status).toBe(201)
    const ninth = await up(`/api/ai-agents/${agent.id}/media`, 'file', png, 'image/png')
    expect(ninth.status).toBe(409)
    expect((await json(ninth)).error.code).toBe('LIMIT_REACHED')
    expect((await up(`/api/ai-agents/${agent.id}/media`, 'file', new Uint8Array(9 * 1024 * 1024), 'application/pdf')).status).toBe(413)
    const { agent: full } = await json(await call(s, 'GET', `/api/ai-agents/${agent.id}`))
    expect(full.media).toHaveLength(8)
    const served = await app.request(full.media[0].url, { headers: { cookie: s.cookie } })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect((await json(await call(s, 'DELETE', `/api/ai-agents/${agent.id}/media/${full.media[0].id}`))).agent.media).toHaveLength(7)
    expect((await up(`/api/ai-agents/${agent.id}/media`, 'file', png, 'application/x-msdownload')).status).toBe(415)
  })
})

describe('AC-T88-03 opções de modelo do editor', () => {
  it('GET /api/ai-agents/model-options: provedores com disponibilidade e modelos llm distintos, sem segredo', async () => {
    const s = await signUp()
    const t = (d: string) => new Date(`${d}T00:00:00Z`)
    await db.insert(llmPrices).values([
      { provider: 'anthropic', model: 't88-sonnet', kind: 'llm', effectiveFrom: t('2026-01-01'), inputPerMtokMicros: 1, outputPerMtokMicros: 2 },
      { provider: 'anthropic', model: 't88-sonnet', kind: 'llm', effectiveFrom: t('2026-06-01'), inputPerMtokMicros: 3, outputPerMtokMicros: 4 },
      { provider: 'openai', model: 't88-gpt', kind: 'llm', effectiveFrom: t('2026-01-01'), inputPerMtokMicros: 1, outputPerMtokMicros: 2 },
      { provider: 'elevenlabs', model: 't88-voice', kind: 'tts', effectiveFrom: t('2026-01-01'), unitPriceMicros: 1 },
    ])
    const res = await call(s, 'GET', '/api/ai-agents/model-options')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.providers).toEqual([
      { provider: 'anthropic', available: true },
      { provider: 'openai', available: false },
      { provider: 'google', available: false },
      { provider: 'openrouter', available: false },
    ])
    const mine = body.models.filter((m: Json) => String(m.model).startsWith('t88-'))
    expect(mine).toEqual([
      { provider: 'anthropic', model: 't88-sonnet' },
      { provider: 'openai', model: 't88-gpt' },
    ])
    expect(JSON.stringify(body)).not.toMatch(/secret|api_key|hint/)
    // não colide com /api/ai-agents/:id
    expect((await call(s, 'GET', '/api/ai-agents/00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })
})

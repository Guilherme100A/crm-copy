// API de chaves de IA (T38) com Postgres real, probe fake e fetch fake; o log do pino é capturado e varrido.
import { randomBytes } from 'node:crypto'
import { aiAgents, auditLogs, companyMembers, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const logs: string[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const SECRET = 'sk-or-v1-TOPSECRET-9f3a'
let probeError: string | null = null
let upstream: { status: number; body: unknown } = { status: 200, body: { data: [] } }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `k-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.38.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'K', email, password: '12345678', password_confirmation: '12345678' }) })
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
  const fetch = (async () => new Response(JSON.stringify(upstream.body), { status: upstream.status })) as unknown as typeof globalThis.fetch
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(s) } }),
    credentialsCipher: createCipher({ key: generateCredentialsKey() }),
    aiKeyProbe: async ({ secret }) => {
      if (probeError) throw new Error(probeError.replace('$KEY', secret))
    },
    aiKeysFetch: fetch,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function createKey(s: Session, body: Json = {}) {
  const res = await call(s, 'POST', '/api/ai-keys', { provider: 'openrouter', name: 'Produção', secret: SECRET, ...body })
  expect(res.status).toBe(201)
  return (await json(res)).key as Json
}

describe('AC-T38-01 segredo fora das respostas e do log', () => {
  it('CRUD e erros nunca devolvem nem logam o segredo; listagem mostra configured, hint e in_use', async () => {
    const s = await signUp()
    const bodies: string[] = []
    const key = await createKey(s)
    expect(key).toMatchObject({ provider: 'openrouter', name: 'Produção', configured: true, hint: '…9f3a', in_use: true })
    const responses = [
      await call(s, 'GET', '/api/ai-keys'),
      await call(s, 'GET', `/api/ai-keys/${key.id}`),
      await call(s, 'PATCH', `/api/ai-keys/${key.id}`, { name: 'Renomeada', secret: '' }),
      await call(s, 'POST', '/api/ai-keys', { provider: 'nope', name: 'x', secret: SECRET }),
      await call(s, 'POST', '/api/ai-keys', { provider: 'openai', name: 'Ok', secret: 12345 }),
      await call(s, 'PATCH', `/api/ai-keys/${key.id}`, { provider: 'openai', secret: SECRET }),
      await call(s, 'POST', `/api/ai-keys/${key.id}/test`),
    ]
    for (const r of responses) bodies.push(await r.text())
    const list = JSON.parse(bodies[0]!) as Json
    expect(list.items).toEqual([expect.objectContaining({ id: key.id, configured: true, hint: '…9f3a', in_use: true })])
    expect(responses[3]!.status).toBe(422)
    for (const b of bodies) expect(b).not.toContain('TOPSECRET')
    // audit sem segredo
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.companyId, s.companyId))
    expect(audits.some((a) => a.action === 'ai_keys.create')).toBe(true)
    expect(JSON.stringify(audits)).not.toContain('TOPSECRET')
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain('TOPSECRET')
  })
})

describe('AC-T38-02 PATCH', () => {
  it('segredo vazio mantém; trocar provedor → 422 em provider', async () => {
    const s = await signUp()
    const key = await createKey(s)
    const res = await call(s, 'PATCH', `/api/ai-keys/${key.id}`, { name: 'Outro nome', secret: '   ' })
    expect(res.status).toBe(200)
    expect((await json(res)).key).toMatchObject({ name: 'Outro nome', hint: '…9f3a' })
    const bad = await call(s, 'PATCH', `/api/ai-keys/${key.id}`, { provider: 'openai' })
    expect(bad.status).toBe(422)
    expect((await json(bad)).error).toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: [expect.objectContaining({ path: 'provider' })] } })
  })
})

describe('AC-T38-03 test', () => {
  it('provedor injetado; ok e erro redigido, sempre 200', async () => {
    const s = await signUp()
    const key = await createKey(s)
    probeError = null
    const ok = await call(s, 'POST', `/api/ai-keys/${key.id}/test`)
    expect(ok.status).toBe(200)
    expect(await json(ok)).toEqual({ ok: true, latency_ms: expect.any(Number) })
    probeError = 'chave $KEY recusada'
    const bad = await call(s, 'POST', `/api/ai-keys/${key.id}/test`)
    expect(bad.status).toBe(200)
    expect(await json(bad)).toMatchObject({ ok: false, error: 'chave [redacted] recusada' })
    probeError = null
  })
})

describe('AC-T38-04 excluir chave em uso', () => {
  it('409 com a lista de agentes; force=1 exclui', async () => {
    const s = await signUp()
    const key = await createKey(s, { provider: 'openai', name: 'OpenAI' })
    // o agente pode ser criado/publicado porque a empresa tem a chave (deps.aiProviderKeys virou BYOK)
    const created = await call(s, 'POST', '/api/ai-agents', { name: 'Leo', model: { provider: 'openai', model: 'gpt-5.4-mini' } })
    expect(created.status).toBe(201)
    const agent = (await json(created)).agent as Json
    const res = await call(s, 'DELETE', `/api/ai-keys/${key.id}`)
    expect(res.status).toBe(409)
    expect((await json(res)).error).toMatchObject({ code: 'CONFLICT', details: { agents: [{ id: agent.id, name: 'Leo' }], flows: [] } })
    expect((await call(s, 'DELETE', `/api/ai-keys/${key.id}?force=1`)).status).toBe(200)
    expect((await call(s, 'GET', `/api/ai-keys/${key.id}`)).status).toBe(404)
    expect((await db.select().from(aiAgents).where(eq(aiAgents.id, agent.id))).length).toBe(1)
  })
})

describe('AC-T38-06 modelos OpenRouter e vozes', () => {
  it('lista fornecedor/modelo; chave de outro provedor → 422; upstream falhou → 502 sem a chave', async () => {
    const s = await signUp()
    const key = await createKey(s)
    upstream = { status: 200, body: { data: [{ id: 'anthropic/claude-x', name: 'Claude X', context_length: 1000 }, { id: 'auto' }] } }
    const res = await call(s, 'GET', `/api/ai-keys/${key.id}/models`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ items: [{ id: 'anthropic/claude-x', name: 'Claude X', context_length: 1000 }] })
    upstream = { status: 401, body: { error: SECRET } }
    const fail = await call(s, 'GET', `/api/ai-keys/${key.id}/models`)
    expect(fail.status).toBe(502)
    expect(await fail.text()).not.toContain('TOPSECRET')
    const oa = await createKey(s, { provider: 'openai', name: 'OpenAI' })
    expect((await call(s, 'GET', `/api/ai-keys/${oa.id}/models`)).status).toBe(422)
    expect((await call(s, 'GET', `/api/ai-keys/${oa.id}/voices`)).status).toBe(422)
    const el = await createKey(s, { provider: 'elevenlabs', name: 'Voz' })
    upstream = { status: 200, body: { voices: [{ voice_id: 'v1', name: 'Ana' }] } }
    expect(await json(await call(s, 'GET', `/api/ai-keys/${el.id}/voices`))).toEqual({ items: [{ id: 'v1', name: 'Ana', category: null, preview_url: null }] })
  })
})

describe('permissões e isolamento', () => {
  it('só view → 403 em escrita/test; outra empresa → 404', async () => {
    const owner = await signUp()
    const key = await createKey(owner)
    const viewer = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['settings.integrations.view'] })
    const as = (method: string, path: string, body?: unknown) => call(viewer, method, path, body, owner.companyId)
    expect((await as('GET', '/api/ai-keys')).status).toBe(200)
    expect((await as('POST', '/api/ai-keys', { provider: 'openai', name: 'Nova', secret: 'k' })).status).toBe(403)
    expect((await as('PATCH', `/api/ai-keys/${key.id}`, { name: 'X y' })).status).toBe(403)
    expect((await as('POST', `/api/ai-keys/${key.id}/test`)).status).toBe(403)
    expect((await as('DELETE', `/api/ai-keys/${key.id}`)).status).toBe(403)
    const other = await signUp()
    expect((await call(other, 'GET', `/api/ai-keys/${key.id}`)).status).toBe(404)
    expect((await call(other, 'DELETE', `/api/ai-keys/${key.id}`)).status).toBe(404)
  })
})

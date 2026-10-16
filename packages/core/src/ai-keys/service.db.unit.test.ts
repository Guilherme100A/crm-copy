// Chaves BYOK (T38) com Postgres real; provedor e fetch fakes (nada sai para a rede).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiAgents, aiProviderKeys, companies, createDb, flowNodeActions, flowNodes, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { AiKeysError, ProviderNotConfiguredError } from './errors'
import { AiKeysService, redactSecret } from './service'

let temp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const rnd = () => randomBytes(4).toString('hex')
const SECRET = 'sk-test-SUPERSECRET-abcd'

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function company() {
  const [co] = await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}` }).returning({ id: companies.id })
  return co!.id
}

let clock = Date.parse('2026-01-01T00:00:00Z')
const svc = (extra: Partial<ConstructorParameters<typeof AiKeysService>[0]> = {}) =>
  new AiKeysService({ db, cipher, env: {}, now: () => new Date((clock += 1000)), ...extra })

const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

describe('CRUD e segredo', () => {
  it('cria com segredo cifrado e dica …abcd; DTO nunca traz o segredo', async () => {
    const co = await company()
    const s = svc()
    const key = await s.create(co, { provider: 'openai', name: 'Produção', secret: `  ${SECRET}  ` })
    expect(key).toMatchObject({ provider: 'openai', name: 'Produção', configured: true, hint: '…abcd', active: true, in_use: true, last_test_ok: null })
    expect(JSON.stringify(key)).not.toContain('SUPERSECRET')
    const [row] = await db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, key.id))
    expect(row!.secretEnc).not.toContain('SUPERSECRET')
    expect((await s.resolveCredentials(co, 'openai')).apiKey).toBe(SECRET)
    expect(JSON.stringify(await s.list(co))).not.toContain('SUPERSECRET')
  })

  it('aceita key_name/integration_token; validação devolve campos sem ecoar o segredo', async () => {
    const co = await company()
    const key = await svc().create(co, { provider: 'gemini', key_name: 'x', integration_token: SECRET }).catch((e: AiKeysError) => e)
    expect(key).toBeInstanceOf(AiKeysError)
    const err = key as AiKeysError
    expect((err.details!.fields as { path: string }[]).map((f) => f.path).sort()).toEqual(['name', 'provider'])
    expect(JSON.stringify(err.details)).not.toContain('SUPERSECRET')
    const ok = await svc().create(co, { provider: 'google', key_name: 'Gemini', integration_token: SECRET })
    expect(ok.name).toBe('Gemini')
  })

  it('AC-T38-02 PATCH com segredo vazio mantém; provedor diferente → validation em provider', async () => {
    const co = await company()
    const s = svc()
    const key = await s.create(co, { provider: 'anthropic', name: 'Anth', secret: SECRET })
    for (const secret of [undefined, '', '   ', null]) await s.update(co, key.id, { name: 'Anth 2', secret })
    expect((await s.resolveCredentials(co, 'anthropic')).apiKey).toBe(SECRET)
    expect((await s.get(co, key.id)).hint).toBe('…abcd')
    expect(await s.update(co, key.id, { provider: 'anthropic' })).toMatchObject({ provider: 'anthropic' })
    const err = (await caught(s.update(co, key.id, { provider: 'openai' }))) as AiKeysError
    expect(err.code).toBe('validation')
    expect(err.details!.fields).toEqual([expect.objectContaining({ path: 'provider' })])
    await s.update(co, key.id, { secret: 'sk-new-key-wxyz' })
    expect(await s.get(co, key.id)).toMatchObject({ hint: '…wxyz' })
    expect((await s.resolveCredentials(co, 'anthropic')).apiKey).toBe('sk-new-key-wxyz')
  })

  it('outra empresa → not_found', async () => {
    const a = await company()
    const b = await company()
    const key = await svc().create(a, { provider: 'openai', name: 'Empresa A', secret: SECRET })
    expect(((await caught(svc().get(b, key.id))) as AiKeysError).code).toBe('not_found')
    expect(((await caught(svc().get(b, 'nao-uuid'))) as AiKeysError).code).toBe('not_found')
    expect(((await caught(svc().credentialsForKey(b, key.id))) as AiKeysError).code).toBe('not_found')
  })
})

describe('chave efetiva (in_use) e AC-T38-05 resolveCredentials', () => {
  it('vale a ativa mais recente; inativa não conta; plataforma como fallback; sem nenhuma → ProviderNotConfiguredError', async () => {
    const co = await company()
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-platform' }
    const s = svc({ env })
    expect(await s.resolveCredentials(co, 'openai')).toEqual({ apiKey: 'sk-platform', source: 'platform' })
    const k1 = await s.create(co, { provider: 'openai', name: 'Um', secret: 'sk-one-1111' })
    const k2 = await s.create(co, { provider: 'openai', name: 'Dois', secret: 'sk-two-2222' })
    expect(await s.resolveCredentials(co, 'openai')).toEqual({ apiKey: 'sk-two-2222', source: 'company', keyId: k2.id })
    expect(Object.fromEntries((await s.list(co)).map((k) => [k.name, k.in_use]))).toEqual({ Um: false, Dois: true })
    // atualizar torna a chave a mais recente
    await s.update(co, k1.id, { name: 'Um atualizada' })
    expect((await s.resolveCredentials(co, 'openai')).keyId).toBe(k1.id)
    // desativada não vale
    await s.update(co, k1.id, { active: false })
    expect((await s.get(co, k1.id)).in_use).toBe(false)
    expect((await s.resolveCredentials(co, 'openai')).keyId).toBe(k2.id)
    await s.update(co, k2.id, { active: false })
    expect((await s.resolveCredentials(co, 'openai')).source).toBe('platform')
    expect(await s.isConfigured({ companyId: co, provider: 'openai' })).toBe(true)
    delete env.OPENAI_API_KEY
    const err = await caught(s.resolveCredentials(co, 'openai'))
    expect(err).toBeInstanceOf(ProviderNotConfiguredError)
    expect(err).toMatchObject({ code: 'provider_not_configured', provider: 'openai' })
    expect(await s.isConfigured({ companyId: co, provider: 'openai' })).toBe(false)
  })

  it('teste não muda qual chave vale', async () => {
    const co = await company()
    const s = svc({ probe: async () => undefined })
    const k1 = await s.create(co, { provider: 'groq', name: 'Um', secret: 'gsk-1111' })
    const k2 = await s.create(co, { provider: 'groq', name: 'Dois', secret: 'gsk-2222' })
    await s.test(co, k1.id)
    expect((await s.resolveCredentials(co, 'groq')).keyId).toBe(k2.id)
  })
})

describe('AC-T38-03 test', () => {
  it('usa o provedor injetado; erro devolvido sem a chave', async () => {
    const co = await company()
    const calls: unknown[] = []
    const ok = svc({ probe: async (i) => void calls.push({ provider: i.provider, secret: i.secret }) })
    const key = await ok.create(co, { provider: 'openrouter', name: 'OR', secret: SECRET })
    const r = await ok.test(co, key.id)
    expect(r).toEqual({ ok: true, latency_ms: expect.any(Number) })
    expect(calls).toEqual([{ provider: 'openrouter', secret: SECRET }])
    expect(await ok.get(co, key.id)).toMatchObject({ last_test_ok: true, last_tested_at: expect.any(String) })

    const bad = svc({ probe: async ({ secret }) => { throw new Error(`401 invalid api key ${secret} for request`) } })
    const r2 = await bad.test(co, key.id)
    expect(r2).toMatchObject({ ok: false, error: '401 invalid api key [redacted] for request' })
    expect(JSON.stringify(r2)).not.toContain('SUPERSECRET')
    expect((await bad.get(co, key.id)).last_test_ok).toBe(false)
  })

  it('redactSecret corta mensagens longas', () => {
    expect(redactSecret('x'.repeat(400), 'k')).toHaveLength(301)
  })
})

describe('AC-T38-04 exclusão de chave em uso', () => {
  it('agente do mesmo provedor usando a chave efetiva → conflict com agentes e fluxos; force exclui', async () => {
    const co = await company()
    const s = svc()
    const key = await s.create(co, { provider: 'openai', name: 'Prod', secret: SECRET })
    const [agent] = await db.insert(aiAgents).values({ companyId: co, name: 'Leo', model: { provider: 'openai', model: 'gpt-5.4-mini' } }).returning({ id: aiAgents.id })
    await db.insert(aiAgents).values({ companyId: co, name: 'Outro', model: { provider: 'anthropic', model: 'claude' } })
    const [flow] = await db.insert(flows).values({ companyId: co, name: 'Vendas' }).returning({ id: flows.id })
    const [node] = await db.insert(flowNodes).values({ companyId: co, flowId: flow!.id, key: 'n1', type: 'ai', name: 'IA', positionX: 0, positionY: 0 }).returning({ id: flowNodes.id })
    await db.insert(flowNodeActions).values({ companyId: co, nodeId: node!.id, key: 'a1', type: 'ai_call', config: { ai_integration_id: key.id } })

    const err = (await caught(s.remove(co, key.id))) as AiKeysError
    expect(err.code).toBe('conflict')
    expect(err.details).toEqual({ agents: [{ id: agent!.id, name: 'Leo' }], flows: [{ id: flow!.id, name: 'Vendas' }] })
    // chave mais recente do mesmo provedor: a antiga deixa de ser usada pelos agentes (o fluxo ainda aponta para ela)
    await s.create(co, { provider: 'openai', name: 'Nova', secret: 'sk-new-9999' })
    expect((await s.usage(co, key.id)).agents).toEqual([])
    await s.remove(co, key.id, { force: true })
    expect(((await caught(s.get(co, key.id))) as AiKeysError).code).toBe('not_found')
  })

  it('sem uso exclui direto', async () => {
    const co = await company()
    const s = svc()
    const key = await s.create(co, { provider: 'elevenlabs', name: 'Voz', secret: SECRET })
    await expect(s.remove(co, key.id)).resolves.toMatchObject({ usage: { agents: [], flows: [] } })
  })
})

describe('AC-T38-06 modelos e vozes', () => {
  const fakeFetch = (body: unknown, status = 200) => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fn, seen }
  }

  it('OpenRouter: GET <base>/models com Bearer; só ids fornecedor/modelo', async () => {
    const co = await company()
    const f = fakeFetch({ data: [{ id: 'anthropic/claude-x', name: 'Claude X', context_length: 200000 }, { id: 'openrouter-auto' }, { id: 'openai/gpt-5', name: '' }] })
    const s = svc({ fetch: f.fn, env: { OPENROUTER_API_URL: 'http://fake.local/api/v1/' } })
    const key = await s.create(co, { provider: 'openrouter', name: 'OR', secret: SECRET })
    expect(await s.models(co, key.id)).toEqual([
      { id: 'anthropic/claude-x', name: 'Claude X', context_length: 200000 },
      { id: 'openai/gpt-5', name: 'openai/gpt-5', context_length: null },
    ])
    expect(f.seen[0]).toMatchObject({ url: 'http://fake.local/api/v1/models', headers: { authorization: `Bearer ${SECRET}` } })
  })

  it('upstream falhou → upstream sem a chave; provedor errado → validation', async () => {
    const co = await company()
    const s = svc({ fetch: fakeFetch({ error: SECRET }, 401).fn })
    const or = await s.create(co, { provider: 'openrouter', name: 'OR', secret: SECRET })
    const err = (await caught(s.models(co, or.id))) as AiKeysError
    expect(err).toMatchObject({ code: 'upstream', message: 'openrouter respondeu 401' })
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain('SUPERSECRET')
    const oa = await s.create(co, { provider: 'openai', name: 'OA', secret: SECRET })
    expect(((await caught(s.models(co, oa.id))) as AiKeysError).details!.fields).toEqual([expect.objectContaining({ path: 'provider' })])
    expect(((await caught(s.voices(co, oa.id))) as AiKeysError).code).toBe('validation')
  })

  it('ElevenLabs: vozes com xi-api-key', async () => {
    const co = await company()
    const f = fakeFetch({ voices: [{ voice_id: 'v1', name: 'Ana', category: 'premade', preview_url: 'http://x/p.mp3' }, { name: 'sem id' }] })
    const s = svc({ fetch: f.fn })
    const key = await s.create(co, { provider: 'elevenlabs', name: 'EL', secret: SECRET })
    expect(await s.voices(co, key.id)).toEqual([{ id: 'v1', name: 'Ana', category: 'premade', preview_url: 'http://x/p.mp3' }])
    expect(f.seen[0]).toMatchObject({ url: 'https://api.elevenlabs.io/v1/voices', headers: { 'xi-api-key': SECRET } })
  })
})

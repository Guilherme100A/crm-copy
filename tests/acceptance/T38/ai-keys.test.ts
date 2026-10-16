// AC-T38-01..06 — chaves de provedores de IA (BYOK): segredo nunca exposto, PATCH, teste com provedor fake,
// exclusão bloqueada por agente, resolveCredentials e modelos da OpenRouter (servidor HTTP local fake).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { createKey, type Env, fieldPaths, newOwner, newSecret, startEnv } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('T38 — segredo nunca exposto', () => {
  it('AC-T38-01 o segredo não aparece em nenhuma resposta da API; listagem mostra só configured e a dica', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-ant')
    const responses: Array<{ status: number; text: string }> = []
    const { key, res } = await createKey(o, 'anthropic', secret)
    responses.push(res)
    expect(key.configured).toBe(true)
    expect(key.hint).toBe(`…${secret.slice(-4)}`)

    const list = await o.c.get('/api/ai-keys')
    responses.push(list)
    expect(list.status).toBe(200)
    const item = list.body.items.find((k: any) => k.id === key.id)
    expect(item).toMatchObject({ provider: 'anthropic', configured: true, hint: `…${secret.slice(-4)}` })
    responses.push(await o.c.get(`/api/ai-keys/${key.id}`))
    responses.push(await o.c.patch(`/api/ai-keys/${key.id}`, { name: 'Renomeada' }))
    responses.push(await o.c.post(`/api/ai-keys/${key.id}/test`, {}))
    // erro de validação com o segredo no corpo não pode ecoá-lo
    const bad = await o.c.post('/api/ai-keys', { provider: 'anthropic', name: 'x', secret })
    expect(bad.status).toBe(422)
    responses.push(bad)
    const badProvider = await o.c.post('/api/ai-keys', { provider: 'inexistente', name: 'Chave ruim', secret })
    expect(badProvider.status).toBe(422)
    responses.push(badProvider)

    for (const r of responses) {
      expect(r.text, `resposta ${r.status} vazou o segredo`).not.toContain(secret)
      expect(r.text).not.toContain(secret.slice(0, 20))
    }
  })

  it('AC-T38-01 o segredo não aparece no log (output do pino capturado)', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-oai')
    const before = env.logs.length
    const { key } = await createKey(o, 'openai', secret)
    await o.c.patch(`/api/ai-keys/${key.id}`, { secret: newSecret('sk-oai2') })
    await o.c.post(`/api/ai-keys/${key.id}/test`, {})
    await o.c.post('/api/ai-keys', { provider: 'openai', name: 'x', secret })
    const out = env.logs.slice(before).join('')
    expect(out.length, 'nenhuma linha de log capturada (captura não funcionou)').toBeGreaterThan(0)
    expect(out).toContain('/api/ai-keys')
    expect(out).not.toContain(secret)
    expect(out).not.toContain(secret.slice(-16))
  })

  it('AC-T38-01 o segredo fica cifrado no banco (nunca em texto puro)', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-gg')
    const { key } = await createKey(o, 'google', secret)
    const rows = await env.q(`SELECT * FROM crm.ai_provider_keys WHERE id = $1`, [key.id])
    expect(rows).toHaveLength(1)
    const dump = JSON.stringify(rows[0], (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v))
    expect(dump).not.toContain(secret)
  })
})

describe('T38 — PATCH', () => {
  it('AC-T38-02 PATCH com segredo vazio mantém o segredo atual', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-keep')
    const { key } = await createKey(o, 'openai', secret)
    const svc = new env.core.AiKeysService({ db: env.db, env: {} })
    for (const blank of ['', '   ', undefined]) {
      const body: Record<string, unknown> = { name: `Nome ${Math.random().toString(36).slice(2, 6)}` }
      if (blank !== undefined) body.secret = blank
      const res = await o.c.patch(`/api/ai-keys/${key.id}`, body)
      expect(res.status, res.text).toBe(200)
      expect(res.body.key.hint).toBe(`…${secret.slice(-4)}`)
      expect((await svc.resolveCredentials(o.companyId, 'openai')).apiKey).toBe(secret)
    }
    const fresh = newSecret('sk-new')
    const res = await o.c.patch(`/api/ai-keys/${key.id}`, { secret: fresh })
    expect(res.body.key.hint).toBe(`…${fresh.slice(-4)}`)
    expect((await svc.resolveCredentials(o.companyId, 'openai')).apiKey).toBe(fresh)
  })

  it('AC-T38-02 trocar o provedor → 422 (o mesmo provedor é aceito)', async () => {
    const o = await newOwner(env)
    const { key } = await createKey(o, 'openai')
    const res = await o.c.patch(`/api/ai-keys/${key.id}`, { provider: 'anthropic' })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('provider')
    expect((await o.c.get(`/api/ai-keys/${key.id}`)).body.key.provider).toBe('openai')
    const same = await o.c.patch(`/api/ai-keys/${key.id}`, { provider: 'openai', name: 'Mesma' })
    expect(same.status, same.text).toBe(200)
  })
})

describe('T38 — testar chave', () => {
  it('AC-T38-03 test usa o provedor injetado com o segredo real e devolve { ok, latency_ms }', async () => {
    const o = await newOwner(env)
    const secret = newSecret('gsk')
    const { key } = await createKey(o, 'groq', secret)
    env.probeFailure.fn = null
    const before = env.probeCalls.length
    const res = await o.c.post(`/api/ai-keys/${key.id}/test`, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.latency_ms).toBe('number')
    expect(res.body.latency_ms).toBeGreaterThanOrEqual(0)
    expect(env.probeCalls.slice(before)).toEqual([{ provider: 'groq', secret }])
  })

  it('AC-T38-03 falha do provedor → { ok: false, latency_ms, error } com o erro sem a chave', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-fail')
    const { key } = await createKey(o, 'openai', secret)
    env.probeFailure.fn = (s) => new Error(`401 Unauthorized: invalid api key ${s} (key ${s} revoked)`)
    try {
      const res = await o.c.post(`/api/ai-keys/${key.id}/test`, {})
      expect(res.status, res.text).toBe(200)
      expect(res.body.ok).toBe(false)
      expect(typeof res.body.latency_ms).toBe('number')
      expect(typeof res.body.error).toBe('string')
      expect(res.body.error).toContain('401')
      expect(res.text).not.toContain(secret)
    } finally {
      env.probeFailure.fn = null
    }
  })
})

describe('T38 — excluir chave em uso', () => {
  it('AC-T38-04 excluir chave usada por agente → 409 com a lista de agentes', async () => {
    const o = await newOwner(env)
    const { key } = await createKey(o, 'openai')
    const agent = await o.c.post('/api/ai-agents', { name: 'Vendedor T38', model: { provider: 'openai', model: 'gpt-5.4-mini' } })
    expect(agent.status, agent.text).toBe(201)
    const res = await o.c.delete(`/api/ai-keys/${key.id}`)
    expectApiError(res, 'CONFLICT', 409)
    expect(res.body.error.details?.agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: agent.body.agent.id, name: 'Vendedor T38' })]))
    expect((await o.c.get(`/api/ai-keys/${key.id}`)).status).toBe(200)
  })

  it('AC-T38-04 chave sem agentes é excluída; force=1 exclui mesmo em uso', async () => {
    const o = await newOwner(env)
    const { key: unused } = await createKey(o, 'elevenlabs')
    const del = await o.c.delete(`/api/ai-keys/${unused.id}`)
    expect(del.status, del.text).toBe(200)
    expectApiError(await o.c.get(`/api/ai-keys/${unused.id}`), 'NOT_FOUND', 404)

    const { key } = await createKey(o, 'anthropic')
    expect((await o.c.post('/api/ai-agents', { name: 'Suporte T38', model: { provider: 'anthropic', model: 'claude-teste' } })).status).toBe(201)
    expect((await o.c.delete(`/api/ai-keys/${key.id}`)).status).toBe(409)
    expect((await o.c.delete(`/api/ai-keys/${key.id}?force=1`)).status).toBe(200)
  })
})

describe('T38 — chave em uso entre várias do mesmo provedor', () => {
  it('AC-T38-04 só a chave ativa mais recente do provedor está em uso: a antiga e a inativa excluem sem 409', async () => {
    const o = await newOwner(env)
    const { key: older } = await createKey(o, 'openai')
    const { key: newer } = await createKey(o, 'openai')
    expect((await o.c.post('/api/ai-agents', { name: 'Agente das duas', model: { provider: 'openai', model: 'gpt-5.4-mini' } })).status).toBe(201)
    const list = (await o.c.get('/api/ai-keys')).body.items
    expect(list.find((k: any) => k.id === newer.id).in_use).toBe(true)
    expect(list.find((k: any) => k.id === older.id).in_use).toBe(false)
    expect((await o.c.delete(`/api/ai-keys/${newer.id}`)).status).toBe(409)

    // desativar a mais recente passa o uso para a outra
    const off = await o.c.patch(`/api/ai-keys/${newer.id}`, { active: false })
    expect(off.status, off.text).toBe(200)
    expect(off.body.key.in_use).toBe(false)
    expect((await o.c.delete(`/api/ai-keys/${older.id}`)).status).toBe(409)
    const del = await o.c.delete(`/api/ai-keys/${newer.id}`)
    expect(del.status, del.text).toBe(200)
  })
})

describe('T38 — resolveCredentials', () => {
  it('AC-T38-05 prefere a chave da empresa à da plataforma', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-emp')
    const { key } = await createKey(o, 'openai', secret)
    const svc = new env.core.AiKeysService({ db: env.db, env: { OPENAI_API_KEY: 'sk-plataforma-t38' } })
    const r = await svc.resolveCredentials(o.companyId, 'openai')
    expect(r).toMatchObject({ apiKey: secret, source: 'company', keyId: key.id })
  })

  it('AC-T38-05 sem chave da empresa cai para a da plataforma (env)', async () => {
    const o = await newOwner(env)
    const svc = new env.core.AiKeysService({ db: env.db, env: { GOOGLE_API_KEY: 'g-plataforma-t38' } })
    const r = await svc.resolveCredentials(o.companyId, 'google')
    expect(r.apiKey).toBe('g-plataforma-t38')
    expect(r.source).toBe('platform')
  })

  it('AC-T38-05 sem nenhuma chave → ProviderNotConfiguredError tipado', async () => {
    const o = await newOwner(env)
    const svc = new env.core.AiKeysService({ db: env.db, env: {} })
    const err = await svc.resolveCredentials(o.companyId, 'groq').then(
      () => null,
      (e: any) => e,
    )
    expect(err).toBeInstanceOf(env.core.ProviderNotConfiguredError)
    expect(err.code).toBe('provider_not_configured')
    expect(err.provider).toBe('groq')
  })

  it('AC-T38-05 a chave de outra empresa nunca é usada', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    await createKey(a, 'anthropic', newSecret('sk-da-a'))
    const svc = new env.core.AiKeysService({ db: env.db, env: { ANTHROPIC_API_KEY: 'sk-plataforma' } })
    expect(await svc.resolveCredentials(b.companyId, 'anthropic')).toMatchObject({ apiKey: 'sk-plataforma', source: 'platform' })
    expectApiError(await b.c.get(`/api/ai-keys/${(await a.c.get('/api/ai-keys')).body.items[0].id}`), 'NOT_FOUND', 404)
  })
})

describe('T38 — modelos OpenRouter', () => {
  it('AC-T38-06 GET /api/ai-keys/:id/models devolve os modelos da OpenRouter no formato fornecedor/modelo', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-or')
    const { key } = await createKey(o, 'openrouter', secret)
    env.openrouter.reply = {
      status: 200,
      body: {
        data: [
          { id: 'anthropic/claude-sonnet-x', name: 'Claude Sonnet X', context_length: 200000 },
          { id: 'openai/gpt-5.4-mini', name: 'GPT 5.4 mini', context_length: 128000 },
          { id: 'sem-fornecedor', name: 'Inválido' },
        ],
      },
    }
    const before = env.openrouter.requests.length
    const res = await o.c.get(`/api/ai-keys/${key.id}/models`)
    expect(res.status, res.text).toBe(200)
    const ids = res.body.items.map((m: any) => m.id)
    expect(ids).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-x', 'openai/gpt-5.4-mini']))
    expect(ids).not.toContain('sem-fornecedor')
    for (const id of ids) expect(id).toMatch(/^[^/\s]+\/[^\s]+$/)
    expect(res.body.items.find((m: any) => m.id === 'openai/gpt-5.4-mini').name).toBe('GPT 5.4 mini')

    const reqs = env.openrouter.requests.slice(before)
    expect(reqs).toHaveLength(1)
    expect(reqs[0]!.path).toMatch(/\/models/)
    expect(reqs[0]!.authorization).toBe(`Bearer ${secret}`)
    expect(res.text).not.toContain(secret)
  })

  it('AC-T38-06 falha da OpenRouter → 502 UPSTREAM_ERROR sem a chave', async () => {
    const o = await newOwner(env)
    const secret = newSecret('sk-or')
    const { key } = await createKey(o, 'openrouter', secret)
    env.openrouter.reply = { status: 500, body: { error: { message: `boom ${secret}` } } }
    const res = await o.c.get(`/api/ai-keys/${key.id}/models`)
    expectApiError(res, 'UPSTREAM_ERROR', 502)
    expect(res.text).not.toContain(secret)
  })

  it('AC-T38-06 /models de chave que não é openrouter → 422', async () => {
    const o = await newOwner(env)
    const { key } = await createKey(o, 'openai')
    const res = await o.c.get(`/api/ai-keys/${key.id}/models`)
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('provider')
  })
})

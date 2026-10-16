// AC-T39-01..06 — CRUD de agentes de IA via HTTP: defaults de settings, publicar/pausar, limite, duplicar, excluir com vínculos e chave de provedor.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectApiError } from '../helpers/http'
import {
  createAgent,
  type Env,
  FIELDS,
  linkChat,
  linkFlow,
  MODEL,
  newOwner,
  readyAgent,
  sameUserOn,
  setAgentLimit,
  SKILLS,
  startEnv,
  strip,
} from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await env?.close()
})

const fieldPaths = (res: { body: any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

describe('T39 — settings', () => {
  it('AC-T39-01 criar agente sem settings aplica os defaults de 07#3.2', async () => {
    const { c } = await newOwner(env)
    const defaults = env.core.AGENT_SETTINGS_DEFAULTS
    expect(defaults, '@crm/core deve exportar AGENT_SETTINGS_DEFAULTS').toBeTruthy()
    // valores fixados pela spec 07#3.2
    expect(defaults).toMatchObject({
      buffer_enabled: true,
      buffer_seconds: 5,
      split_messages: true,
      audio_choice_enabled: true,
      audio_max_per_conversation: 3,
      understand_audio: true,
      understand_image: true,
      understand_receipt: true,
      validate_receipt_pix_key: false,
      validate_receipt_recipient: false,
      sign_name: false,
      business_hours_only: false,
      pause_on_human: true,
      stall_limit_enabled: true,
      stall_limit: 12,
      engine: 'balanced',
      no_balance_action: 'none',
    })
    const res = await c.post('/api/ai-agents', {})
    expect(res.status, res.text).toBe(201)
    expect(res.body.agent.settings).toEqual(defaults)
    expect(res.body.agent.status).toBe('draft')
    const got = await c.get(`/api/ai-agents/${res.body.agent.id}`)
    expect(got.body.agent.settings).toEqual(defaults)
  })

  it('AC-T39-01 agente em branco vem com os 5 campos de coleta padrão', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c)
    const fields = [...agent.collection_fields].sort((a: any, b: any) => a.position - b.position)
    expect(fields.map((f: any) => [f.key, f.enabled])).toEqual([
      ['nome', true],
      ['cidade', true],
      ['produto', true],
      ['email', false],
      ['recompra', false],
    ])
  })

  it('AC-T39-01 settings parciais são mescladas sobre os defaults', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c, { settings: { buffer_seconds: 9, sign_name: true } })
    expect(agent.settings).toEqual({ ...env.core.AGENT_SETTINGS_DEFAULTS, buffer_seconds: 9, sign_name: true })
  })

  it.each([
    ['buffer_seconds', -1],
    ['engine', 'turbo'],
    ['stall_limit', 'muitos'],
    ['no_balance_action', 'explodir'],
  ])('AC-T39-01 settings.%s inválido → 422 com o campo', async (field, value) => {
    const { c } = await newOwner(env)
    const res = await c.post('/api/ai-agents', { settings: { [field]: value } })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain(`settings.${field}`)
    expect((await c.get('/api/ai-agents')).body.items).toHaveLength(0)
  })

  it('AC-T39-01 PATCH com settings inválidas → 422 com o campo e nada muda', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c)
    const res = await c.patch(`/api/ai-agents/${agent.id}`, { settings: { buffer_seconds: -5 } })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('settings.buffer_seconds')
    expect((await c.get(`/api/ai-agents/${agent.id}`)).body.agent.settings.buffer_seconds).toBe(5)
  })
})

describe('T39 — publicar e pausar', () => {
  it('AC-T39-02 publish sem prompt → 422', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c, { model: MODEL })
    const res = await c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(res.status, res.text).toBe(422)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).body.agent.status).toBe('draft')
  })

  it('AC-T39-02 publish sem modelo (sem model e sem preset) → 422', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c, { generated_prompt: 'Você vende cursos.', model: null })
    const res = await c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(res.status, res.text).toBe(422)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).body.agent.status).toBe('draft')
  })

  it('AC-T39-02 publish → active; pause → paused; publish de novo → active', async () => {
    const { c } = await newOwner(env)
    const agent = await readyAgent(c)
    const pub = await c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(pub.status, pub.text).toBe(200)
    expect(pub.body.agent.status).toBe('active')
    const pause = await c.post(`/api/ai-agents/${agent.id}/pause`, {})
    expect(pause.status, pause.text).toBe(200)
    expect(pause.body.agent.status).toBe('paused')
    const again = await c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(again.body.agent.status).toBe('active')
  })

  it('AC-T39-02 modelo vindo do preset da empresa permite publicar sem model explícito', async () => {
    const { c, companyId } = await newOwner(env)
    await env.q(`UPDATE crm.companies SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai_presets', $2::jsonb) WHERE id = $1`, [
      companyId,
      JSON.stringify({ balanced: MODEL }),
    ])
    const agent = await createAgent(c, { generated_prompt: 'Você agenda consultas.', model: null })
    const pub = await c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(pub.status, pub.text).toBe(200)
    expect(pub.body.agent.status).toBe('active')
  })

  it('AC-T39-02 transições inválidas → 409 (publish de active, pause de draft, pause de paused)', async () => {
    const { c } = await newOwner(env)
    const draft = await readyAgent(c)
    expectApiError(await c.post(`/api/ai-agents/${draft.id}/pause`, {}), 'INVALID_TRANSITION', 409)

    const active = await readyAgent(c)
    await c.post(`/api/ai-agents/${active.id}/publish`, {})
    expectApiError(await c.post(`/api/ai-agents/${active.id}/publish`, {}), 'INVALID_TRANSITION', 409)

    await c.post(`/api/ai-agents/${active.id}/pause`, {})
    expectApiError(await c.post(`/api/ai-agents/${active.id}/pause`, {}), 'INVALID_TRANSITION', 409)
  })
})

describe('T39 — limite de agentes', () => {
  it('AC-T39-03 sem limite definido a empresa cria quantos agentes quiser', async () => {
    const { c } = await newOwner(env)
    for (let i = 0; i < 12; i++) await createAgent(c, { name: `Agente ${i}` })
    const list = await c.get('/api/ai-agents')
    expect(list.body.items).toHaveLength(12)
    expect(list.body.quota?.limit ?? null).toBeNull()
  })

  it('AC-T39-03 limite definido e atingido → criar 409 LIMIT_REACHED', async () => {
    const { c, companyId } = await newOwner(env)
    await setAgentLimit(env, companyId, 3)
    for (let i = 0; i < 3; i++) await createAgent(c)
    expectApiError(await c.post('/api/ai-agents', {}), 'LIMIT_REACHED', 409)
    const list = await c.get('/api/ai-agents')
    expect(list.body.items).toHaveLength(3)
    expect(list.body.quota).toMatchObject({ used: 3, limit: 3 })
  })

  it('AC-T39-03 limite atingido → duplicar 409 LIMIT_REACHED', async () => {
    const { c, companyId } = await newOwner(env)
    const a = await createAgent(c)
    await createAgent(c)
    await setAgentLimit(env, companyId, 2)
    expectApiError(await c.post(`/api/ai-agents/${a.id}/duplicate`, {}), 'LIMIT_REACHED', 409)
    expect((await c.get('/api/ai-agents')).body.items).toHaveLength(2)
  })

  it('AC-T39-03 abaixo do limite cria normalmente; o limite é por empresa', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    await setAgentLimit(env, a.companyId, 2)
    await createAgent(a.c)
    await createAgent(a.c)
    expectApiError(await a.c.post('/api/ai-agents', {}), 'LIMIT_REACHED', 409)
    for (let i = 0; i < 4; i++) await createAgent(b.c)
    expect((await b.c.get('/api/ai-agents')).body.items).toHaveLength(4)
  })
})

describe('T39 — duplicar', () => {
  it('AC-T39-04 duplicate copia settings, habilidades e campos de coleta, com status draft', async () => {
    const { c } = await newOwner(env)
    const source = await readyAgent(c, { settings: { buffer_seconds: 11, engine: 'advanced', sign_name: true }, skills: SKILLS, collection_fields: FIELDS })
    await c.post(`/api/ai-agents/${source.id}/publish`, {})

    const res = await c.post(`/api/ai-agents/${source.id}/duplicate`, {})
    expect(res.status, res.text).toBe(201)
    const copy = res.body.agent
    const orig = (await c.get(`/api/ai-agents/${source.id}`)).body.agent
    expect(copy.id).not.toBe(orig.id)
    expect(copy.status).toBe('draft')
    expect(orig.status).toBe('active')
    expect(copy.settings).toEqual(orig.settings)
    expect(strip(copy.skills)).toEqual(strip(orig.skills))
    expect(strip(copy.skills)).toHaveLength(2)
    expect(strip(copy.collection_fields)).toEqual(strip(orig.collection_fields))
    expect(copy.collection_fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['nome', 'placa']))
    // ids das coleções são novos
    const ids = (xs: any[]) => xs.map((x) => x.id).filter(Boolean)
    for (const id of ids(copy.skills)) expect(ids(orig.skills)).not.toContain(id)
    for (const id of ids(copy.collection_fields)) expect(ids(orig.collection_fields)).not.toContain(id)
  })

  it('AC-T39-04 alterar a cópia não altera o original', async () => {
    const { c } = await newOwner(env)
    const source = await createAgent(c, { skills: SKILLS })
    const copy = (await c.post(`/api/ai-agents/${source.id}/duplicate`, {})).body.agent
    await c.patch(`/api/ai-agents/${copy.id}`, { settings: { buffer_seconds: 30 }, skills: [] })
    const orig = (await c.get(`/api/ai-agents/${source.id}`)).body.agent
    expect(orig.settings.buffer_seconds).toBe(5)
    expect(orig.skills).toHaveLength(2)
  })
})

describe('T39 — excluir com vínculos', () => {
  it('AC-T39-05 agente vinculado a fluxo → DELETE 409 com a referência do fluxo', async () => {
    const { c, companyId } = await newOwner(env)
    const agent = await createAgent(c)
    const flow = await linkFlow(env, companyId, agent.id)
    const res = await c.delete(`/api/ai-agents/${agent.id}`)
    expectApiError(res, 'CONFLICT', 409)
    const refs = res.body.error.details?.references
    expect(refs?.flows?.map((f: any) => f.id), res.text).toContain(flow.id)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).status).toBe(200)
  })

  it('AC-T39-05 agente atendendo chat ativo → DELETE 409 com a referência do chat', async () => {
    const { c, companyId } = await newOwner(env)
    const agent = await createAgent(c)
    const chatId = await linkChat(env, companyId, agent.id, 'attending')
    const res = await c.delete(`/api/ai-agents/${agent.id}`)
    expectApiError(res, 'CONFLICT', 409)
    expect(res.body.error.details?.references?.chats?.map((x: any) => x.id), res.text).toContain(chatId)
  })

  it('AC-T39-05 chat resolvido não impede a exclusão', async () => {
    const { c, companyId } = await newOwner(env)
    const agent = await createAgent(c)
    await linkChat(env, companyId, agent.id, 'resolved')
    const res = await c.delete(`/api/ai-agents/${agent.id}`)
    expect(res.status, res.text).toBeLessThan(300)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).status).toBe(404)
  })

  it('AC-T39-05 com force=1 exclui mesmo vinculado', async () => {
    const { c, companyId } = await newOwner(env)
    const agent = await createAgent(c)
    await linkFlow(env, companyId, agent.id)
    const chatId = await linkChat(env, companyId, agent.id, 'waiting')
    const res = await c.delete(`/api/ai-agents/${agent.id}?force=1`)
    expect(res.status, res.text).toBeLessThan(300)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).status).toBe(404)
    const [chat] = await env.q(`SELECT ai_agent_id FROM crm.chats WHERE id = $1`, [chatId])
    expect(chat.ai_agent_id).toBeNull()
  })

  it('AC-T39-05 agente sem vínculos é excluído direto', async () => {
    const { c } = await newOwner(env)
    const agent = await createAgent(c)
    expect((await c.delete(`/api/ai-agents/${agent.id}`)).status).toBeLessThan(300)
    expect((await c.get(`/api/ai-agents/${agent.id}`)).status).toBe(404)
  })
})

describe('T39 — chave do provedor', () => {
  const GOOGLE = { provider: 'google', model: 'gemini-teste-t39' }

  it('AC-T39-06 modelo de provedor sem chave (empresa nem plataforma) → 422 provider_not_configured no POST e no PATCH', async () => {
    const noKeys = env.makeApp(() => false)
    const owner = await newOwner(env, noKeys)
    const post = await owner.c.post('/api/ai-agents', { model: GOOGLE })
    expect(post.status, post.text).toBe(422)
    expect(post.text).toContain('provider_not_configured')

    const agent = await createAgent(owner.c, { model: null })
    const patch = await owner.c.patch(`/api/ai-agents/${agent.id}`, { model: GOOGLE })
    expect(patch.status, patch.text).toBe(422)
    expect(patch.text).toContain('provider_not_configured')
    expect((await owner.c.get(`/api/ai-agents/${agent.id}`)).body.agent.model ?? null).toBeNull()
  })

  it('AC-T39-06 publish com modelo resolvido (preset) sem chave → 422 provider_not_configured', async () => {
    const noKeys = env.makeApp(() => false)
    const owner = await newOwner(env, noKeys)
    await env.q(`UPDATE crm.companies SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai_presets', $2::jsonb) WHERE id = $1`, [
      owner.companyId,
      JSON.stringify({ balanced: GOOGLE }),
    ])
    const agent = await createAgent(owner.c, { generated_prompt: 'Você responde dúvidas.', model: null })
    const res = await owner.c.post(`/api/ai-agents/${agent.id}/publish`, {})
    expect(res.status, res.text).toBe(422)
    expect(res.text).toContain('provider_not_configured')
    expect((await owner.c.get(`/api/ai-agents/${agent.id}`)).body.agent.status).toBe('draft')
  })

  it('AC-T39-06 chave da empresa basta: só a empresa com chave aceita o modelo', async () => {
    const holder = { companyId: '' }
    const perCompany = env.makeApp(({ companyId, provider }) => provider === 'google' && companyId === holder.companyId)
    const withKey = await newOwner(env, perCompany)
    holder.companyId = withKey.companyId
    const without = await newOwner(env, perCompany)
    expect((await withKey.c.post('/api/ai-agents', { model: GOOGLE })).status).toBe(201)
    expect((await without.c.post('/api/ai-agents', { model: GOOGLE })).status).toBe(422)
  })

  it('AC-T39-06 chave da plataforma (env) basta quando a empresa não tem chave', async () => {
    const platform = env.makeApp(undefined)
    const owner = await newOwner(env, platform)
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) vi.stubEnv(k, '')
    const off = await owner.c.post('/api/ai-agents', { model: GOOGLE })
    expect(off.status, off.text).toBe(422)
    expect(off.text).toContain('provider_not_configured')
    vi.stubEnv('GOOGLE_API_KEY', 'chave-falsa-de-teste')
    const on = await owner.c.post('/api/ai-agents', { model: GOOGLE })
    expect(on.status, on.text).toBe(201)
    vi.unstubAllEnvs()
    // mesmo cookie em outro app continua válido (sessão no banco)
    expect((await sameUserOn(env.app, owner).get('/api/ai-agents')).status).toBe(200)
  })
})

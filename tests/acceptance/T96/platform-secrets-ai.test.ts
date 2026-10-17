// AC-T96-04 pela API: segredos de plataforma (IA/ElevenLabs/Groq) só de escrita — a leitura devolve `configured`, a
// origem e a máscara, nunca o valor — e o uso de IA por empresa × modelo agregado de crm.ai_usage.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uniqueId } from '../helpers/factories'
import { owner, platformAdmin, startEnv, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const KEYS = ['anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq']
// ambiente das chaves de plataforma injetado (adminOps.env): só a do Groq vem do env
const PLATFORM_ENV = { GROQ_API_KEY: 'gsk-env-valor-9876' }

let env: Env
let admin: User

beforeAll(async () => {
  env = await startEnv({ adminOps: { env: PLATFORM_ENV } })
  admin = await platformAdmin(env)
}, 120_000)

afterAll(async () => {
  await env?.close()
})

describe('T96 — segredos de plataforma só de escrita (AC-T96-04)', () => {
  it('AC-T96-04 lista as chaves de IA/ElevenLabs/Groq com configured, origem e máscara; nada configurado → configured false', async () => {
    const r = await admin.c.get('/api/admin/platform-secrets')
    expect(r.status, r.text).toBe(200)
    expect(r.body.items.map((i: Any) => i.key).sort()).toEqual([...KEYS].sort())
    const byKey = new Map<string, Any>(r.body.items.map((i: Any) => [i.key, i]))
    expect(byKey.get('openai')).toMatchObject({ configured: false, source: null, hint: null })
    // vindo do ambiente: configured, origem env, máscara com os 4 últimos e nunca o valor
    expect(byKey.get('groq')).toMatchObject({ configured: true, source: 'env', env_var: 'GROQ_API_KEY' })
    expect(byKey.get('groq').hint).toContain('9876')
    expect(r.text).not.toContain(PLATFORM_ENV.GROQ_API_KEY)
  })

  it('AC-T96-04 gravar o segredo: resposta e leituras devolvem só configured + máscara; banco guarda cifrado; auditoria sem o valor', async () => {
    const secret = `sk-t96-${randomUUID()}-ABCD`
    const put = await admin.c.put('/api/admin/platform-secrets/openai', { value: secret })
    expect(put.status, put.text).toBe(200)
    expect(put.body.secret).toMatchObject({ key: 'openai', configured: true, source: 'db', updated_by_user_id: admin.userId })
    expect(put.body.secret.hint).toContain('ABCD')
    expect(put.body.secret.hint).not.toContain(secret.slice(0, -4))
    expect(put.text).not.toContain(secret)

    const one = await admin.c.get('/api/admin/platform-secrets/openai')
    expect(one.status).toBe(200)
    expect(one.body.secret).toMatchObject({ configured: true, source: 'db' })
    expect(one.text).not.toContain(secret)
    const list = await admin.c.get('/api/admin/platform-secrets')
    expect(list.text).not.toContain(secret)

    const rows = await env.q(`SELECT * FROM crm.platform_secrets WHERE key = 'openai'`)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain(secret)

    const audit = await env.q(`SELECT company_id, action, detail FROM crm.audit_logs WHERE action LIKE 'admin.platform_secret.%' AND target_id = 'openai'`)
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit[0]).toMatchObject({ company_id: null, action: 'admin.platform_secret.update' })
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(JSON.stringify(audit)).not.toContain('ABCD')

    // trocar o segredo troca a máscara
    const put2 = await admin.c.put('/api/admin/platform-secrets/openai', { value: 'sk-outro-WXYZ' })
    expect(put2.body.secret.hint).toContain('WXYZ')
    expect(put2.text).not.toContain('sk-outro')
  })

  it('AC-T96-04 segredo salvo tem precedência sobre o env; excluir volta ao env', async () => {
    const put = await admin.c.put('/api/admin/platform-secrets/groq', { value: 'gsk-db-valor-1111' })
    expect(put.body.secret).toMatchObject({ source: 'db' })
    expect(put.body.secret.hint).toContain('1111')

    const del = await admin.c.delete('/api/admin/platform-secrets/groq')
    expect(del.status, del.text).toBe(200)
    expect(del.body.removed).toBe(true)
    expect(del.body.secret).toMatchObject({ key: 'groq', configured: true, source: 'env' })
    expect(del.body.secret.hint).toContain('9876')
    expect(del.text).not.toContain('gsk-')
    const audit = await env.q(`SELECT company_id FROM crm.audit_logs WHERE action = 'admin.platform_secret.delete' AND target_id = 'groq'`)
    expect(audit).toEqual([{ company_id: null }])

    const again = await admin.c.delete('/api/admin/platform-secrets/groq')
    expect(again.body.removed).toBe(false)
  })

  it('AC-T96-04 o segredo salvo vale no runtime: provedor sem chave fica disponível para os agentes da empresa', async () => {
    const saved = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    try {
      const o = await owner(env)
      const avail = async () => {
        const r = await o.c.get('/api/ai-agents/model-options')
        expect(r.status, r.text).toBe(200)
        return r.body.providers.find((p: Any) => p.provider === 'openrouter')?.available
      }
      expect(await avail()).toBe(false)
      expect((await admin.c.put('/api/admin/platform-secrets/openrouter', { value: 'sk-or-t96-7777' })).status).toBe(200)
      expect(await avail()).toBe(true)
      expect((await admin.c.delete('/api/admin/platform-secrets/openrouter')).status).toBe(200)
      expect(await avail()).toBe(false)
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved
    }
  })

  it('AC-T96-04 validação: valor vazio → 422; chave desconhecida → 404; dono → 403; sem sessão → 401', async () => {
    for (const body of [{}, { value: '' }, { value: '   ' }, { value: 123 }]) {
      const r = await admin.c.put('/api/admin/platform-secrets/anthropic', body)
      expect(r.status, JSON.stringify(body)).toBe(422)
    }
    expect((await admin.c.get('/api/admin/platform-secrets/anthropic')).body.secret.configured).toBe(false)
    expect((await admin.c.put('/api/admin/platform-secrets/stripe', { value: 'x' })).status).toBe(404)
    expect((await admin.c.get('/api/admin/platform-secrets/stripe')).status).toBe(404)

    const o = await owner(env)
    expect((await o.c.get('/api/admin/platform-secrets')).status).toBe(403)
    expect((await o.c.put('/api/admin/platform-secrets/anthropic', { value: 'sk-intruso' })).status).toBe(403)
    expect((await env.app.request('/api/admin/platform-secrets')).status).toBe(401)
    expect((await admin.c.get('/api/admin/platform-secrets/anthropic')).body.secret.configured).toBe(false)
  })
})

describe('T96 — uso de IA por empresa e modelo (AC-T96-04)', () => {
  async function usage(companyId: string, provider: string, model: string, at: string, o: { input: number; output: number; cost: number; billed: number; credits: number; status?: string }) {
    await env.q(
      `INSERT INTO crm.ai_usage (company_id, request_id, provider, model, input_tokens, output_tokens, cost_micros, billed_micros, credits, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [companyId, uniqueId('req-t96'), provider, model, o.input, o.output, o.cost, o.billed, o.credits, o.status ?? 'charged', at],
    )
  }

  it('AC-T96-04 agrega crm.ai_usage por empresa × provedor × modelo (erro fora; reembolso só nos tokens) com totais e filtros', async () => {
    const a = await owner(env)
    const b = await owner(env)
    const D = '2026-09-10T12:00:00.000Z'
    await usage(a.companyId, 'openai', 'gpt-t96', D, { input: 100, output: 10, cost: 1000, billed: 2000, credits: 20 })
    await usage(a.companyId, 'openai', 'gpt-t96', D, { input: 50, output: 5, cost: 500, billed: 1000, credits: 10 })
    await usage(a.companyId, 'anthropic', 'claude-t96', D, { input: 7, output: 3, cost: 300, billed: 600, credits: 6 })
    await usage(a.companyId, 'openai', 'gpt-t96', D, { input: 999, output: 999, cost: 0, billed: 0, credits: 0, status: 'error' })
    await usage(b.companyId, 'openai', 'gpt-t96', D, { input: 1, output: 1, cost: 10, billed: 20, credits: 1 })
    await usage(b.companyId, 'openai', 'gpt-t96', D, { input: 2, output: 2, cost: 40, billed: 80, credits: 4, status: 'refunded' })
    await usage(b.companyId, 'openai', 'gpt-t96', '2026-08-01T00:00:00.000Z', { input: 5, output: 5, cost: 50, billed: 100, credits: 5 })

    const range = 'from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z'
    const r = await admin.c.get(`/api/admin/ai/usage?${range}`)
    expect(r.status, r.text).toBe(200)
    const mine = r.body.items.filter((i: Any) => [a.companyId, b.companyId].includes(i.company_id))
    const key = (i: Any) => `${i.company_id}|${i.provider}|${i.model}`
    const by = new Map<string, Any>(mine.map((i: Any) => [key(i), i]))
    expect(mine).toHaveLength(3)
    expect(by.get(`${a.companyId}|openai|gpt-t96`)).toMatchObject({ count: 2, input_tokens: 150, output_tokens: 15, cost_micros: 1500, billed_micros: 3000, credits: 30 })
    expect(by.get(`${a.companyId}|anthropic|claude-t96`)).toMatchObject({ count: 1, input_tokens: 7, output_tokens: 3, cost_micros: 300, billed_micros: 600, credits: 6 })
    const bRow = by.get(`${b.companyId}|openai|gpt-t96`)
    expect(bRow).toMatchObject({ cost_micros: 10, billed_micros: 20, credits: 1 })
    expect(typeof bRow.company_name).toBe('string')
    expect(bRow.company_name.length).toBeGreaterThan(0)

    // totais = soma das linhas
    const sum = (k: string) => r.body.items.reduce((s: number, i: Any) => s + i[k], 0)
    for (const k of ['count', 'input_tokens', 'output_tokens', 'cost_micros', 'billed_micros', 'credits']) expect(r.body.totals[k], k).toBe(sum(k))

    const onlyA = await admin.c.get(`/api/admin/ai/usage?${range}&company_id=${a.companyId}`)
    expect(onlyA.body.items.every((i: Any) => i.company_id === a.companyId)).toBe(true)
    expect(onlyA.body.items).toHaveLength(2)
    expect(onlyA.body.totals.credits).toBe(36)

    const onlyModel = await admin.c.get(`/api/admin/ai/usage?${range}&company_id=${a.companyId}&model=claude-t96`)
    expect(onlyModel.body.items.map((i: Any) => i.model)).toEqual(['claude-t96'])

    // fora do período não entra
    const aug = await admin.c.get(`/api/admin/ai/usage?from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z&company_id=${b.companyId}`)
    expect(aug.body.items).toHaveLength(1)
    expect(aug.body.items[0]).toMatchObject({ count: 1, credits: 5 })
  })

  it('AC-T96-04 período invertido ou data inválida → 422; dono → 403', async () => {
    expect((await admin.c.get('/api/admin/ai/usage?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z')).status).toBe(422)
    expect((await admin.c.get('/api/admin/ai/usage?from=ontem')).status).toBe(422)
    const o = await owner(env)
    expect((await o.c.get('/api/admin/ai/usage')).status).toBe(403)
  })
})

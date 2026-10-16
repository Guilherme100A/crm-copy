// AC-T42-01..04 — nós externos: HTTP (variáveis, mapeamento, falhas, proteção de rede) e IA (structured output, saída
// padrão, erro, medição com feature flow_ai e cota). Contrato combinado com o Operário (Bigorna); apoio em ./support.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { action, company, def, edge, httpDef, local, marker, node, run, startEnv, type Env } from './support'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('T42 — make_http_request', () => {
  it('AC-T42-01 aplica método, headers e corpo com variáveis e mapeia response.* para variáveis', async () => {
    const c = await company(env, { contactName: 'Maria Souza' })
    const before = env.requests.length
    const r = await run(
      env,
      c,
      httpDef({
        request_method: 'POST',
        request_url: `${env.base}/ok?nome={first_name}`,
        request_headers: { 'X-Cliente': '{{customer.full_name}}', Authorization: 'Bearer token-fixo' },
        request_body: { cliente: '{{customer.full_name}}', origem: 'fluxo' },
        response_mapping: { status_pedido: 'data.status', primeiro_item: 'data.items.0.id', total: 'data.total' },
      }),
      local(),
    )
    expect(r.visited, JSON.stringify(r)).toEqual(['S'])
    const req = env.requests.slice(before).at(-1)!
    expect(req.method).toBe('POST')
    expect(new URL(req.url, 'http://x').searchParams.get('nome')).toBe('Maria')
    expect(req.headers['x-cliente']).toBe('Maria Souza')
    expect(req.headers.authorization).toBe('Bearer token-fixo')
    expect(String(req.headers['content-type'])).toContain('application/json')
    expect(JSON.parse(req.body)).toEqual({ cliente: 'Maria Souza', origem: 'fluxo' })
    expect(r.vars.status_pedido).toBe('pago')
    expect(r.vars.primeiro_item).toBe(42)
    expect(r.vars.total).toBe(99.9)
    expect(r.vars.response).toMatchObject({ status: 200, ok: true })
    expect(r.vars.response.data.data.status).toBe('pago')
    expect(r.vars.http_error ?? null).toBeNull()
  })

  it('AC-T42-01 GET com corpo string não-JSON vai como text/plain e resposta texto vira data', async () => {
    const c = await company(env)
    const before = env.requests.length
    const r = await run(env, c, httpDef({ request_method: 'PUT', request_url: `${env.base}/text`, request_body: 'linha simples' }), local())
    expect(r.visited).toEqual(['S'])
    const req = env.requests.slice(before).at(-1)!
    expect(req.method).toBe('PUT')
    expect(String(req.headers['content-type'])).toContain('text/plain')
    expect(req.body).toBe('linha simples')
    expect(r.vars.response.data).toBe('olá texto')
  })

  it.each([404, 500])('AC-T42-01 resposta não 2xx (%s) segue failure', async (code) => {
    const c = await company(env)
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: `${env.base}/status/${code}`, response_mapping: { erro: 'erro' } }), local())
    expect(r.visited).toEqual(['F'])
    expect(r.vars.http_error).toBe(`http_status_${code}`)
    expect(r.vars.response?.status).toBe(code)
  })

  it('AC-T42-01 timeout segue failure com http_error = timeout', async () => {
    const c = await company(env)
    const t0 = Date.now()
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: `${env.base}/slow` }), local({ timeoutMs: 300 }))
    expect(Date.now() - t0).toBeLessThan(2_900) // não esperou os 3 s do servidor
    expect(r.visited).toEqual(['F'])
    expect(r.vars.http_error).toBe('timeout')
  })
})

describe('T42 — proteção de rede (SSRF)', () => {
  it('AC-T42-02 recusa endereço de loopback (127.0.0.1) sem liberar o host, sem conectar', async () => {
    const c = await company(env)
    const before = env.requests.length
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: `${env.base}/ok` }), { http: { timeoutMs: 1_000 } })
    expect(r.visited).toEqual(['F'])
    expect(r.vars.http_error).toBe('ssrf_blocked')
    expect(env.requests.length, 'não pode ter conectado ao servidor').toBe(before)
  })

  it('AC-T42-02 recusa nome que resolve para rede privada (DNS), sem conectar', async () => {
    const c = await company(env)
    const looked: string[] = []
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: 'http://api.example.test/pedido' }), {
      http: { timeoutMs: 1_000, lookup: async (host: string) => (looked.push(host), [{ address: '10.0.0.1', family: 4 }]) },
    })
    expect(looked).toContain('api.example.test')
    expect(r.visited).toEqual(['F'])
    expect(r.vars.http_error).toBe('ssrf_blocked')
  })

  it('AC-T42-02 recusa redirect para rede privada (mesmo partindo de host liberado)', async () => {
    const c = await company(env)
    const before = env.requests.length
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: `${env.base}/redirect?to=${encodeURIComponent('http://10.0.0.1/interno')}` }), local())
    expect(r.visited).toEqual(['F'])
    expect(r.vars.http_error).toBe('ssrf_blocked')
    // só a 1ª requisição (ao servidor local) aconteceu
    expect(env.requests.slice(before).map((x) => new URL(x.url, 'http://x').pathname)).toEqual(['/redirect'])
  })

  it('AC-T42-02 localhost sem liberação é recusado antes de conectar', async () => {
    const c = await company(env)
    const before = env.requests.length
    const port = new URL(env.base).port
    const r = await run(env, c, httpDef({ request_method: 'GET', request_url: `http://localhost:${port}/ok` }), { http: { timeoutMs: 1_000 } })
    expect(r.vars.http_error).toBe('ssrf_blocked')
    expect(env.requests.length).toBe(before)
  })

  it('AC-T42-02 isBlockedAddress: loopback, privados, link-local e ::1 bloqueados; público liberado', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.0.10', '169.254.169.254', '::1']) expect(env.core.isBlockedAddress(ip), ip).toBe(true)
    expect(env.core.isBlockedAddress('8.8.8.8')).toBe(false)
  })
})

describe('T42 — ai_call', () => {
  /** start → A (ai) ─output:compra→ C / ─output:duvida→ D / ─output:outro→ O / ─success→ S / ─failure→ F */
  const aiDef = (config: Record<string, unknown>) =>
    def(
      [node('A', 'ai', [action('A-a', 'ai_call', config)]), marker('C'), marker('D'), marker('O'), marker('S'), marker('F')],
      [
        edge('start', 'source', 'A'),
        edge('A', 'output:compra', 'C'),
        edge('A', 'output:duvida', 'D'),
        edge('A', 'output:outro', 'O'),
        edge('A', 'success', 'S'),
        edge('A', 'failure', 'F'),
      ],
    )
  const conditions = {
    provider: 'gpt',
    user_message: 'O cliente {first_name} disse: quero comprar o curso',
    output_conditions: [
      { prompt: 'cliente quer comprar', output_key: 'compra' },
      { prompt: 'cliente tem dúvida', output_key: 'duvida' },
    ],
    fallback_output_key: 'outro',
  }
  const guard = () => new env.core.UsageGuard({ db: env.db, redis: env.redis })

  it('AC-T42-03 saídas condicionais usam structured output e seguem output:<chave>', async () => {
    const c = await company(env, { contactName: 'Joana Lima' })
    const llm = new env.ai.FakeLlm([env.ai.output({ output_key: 'compra' })])
    const r = await run(env, c, aiDef(conditions), { llm, guard: guard() })
    expect(r.visited, JSON.stringify(r)).toEqual(['C'])
    expect(r.vars.ai.output).toBe('compra')
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].output, 'deveria pedir structured output').toBeTruthy()
    expect(JSON.stringify(llm.calls[0].messages)).toContain('Joana')
  })

  it('AC-T42-03 resposta inválida (chave fora das condições) usa a saída padrão', async () => {
    const c = await company(env)
    const llm = new env.ai.FakeLlm([env.ai.output({ output_key: 'inexistente' })])
    const r = await run(env, c, aiDef(conditions), { llm, guard: guard() })
    expect(r.visited).toEqual(['O'])
  })

  it('AC-T42-03 sem condições, a resposta vai para ai.response e segue success', async () => {
    const c = await company(env)
    const llm = new env.ai.FakeLlm([env.ai.text('Olá! Posso ajudar.')])
    const r = await run(env, c, aiDef({ provider: 'gpt', user_message: 'oi', response_variable: 'resposta_ia' }), { llm, guard: guard() })
    expect(r.visited).toEqual(['S'])
    expect(r.vars.ai.response).toBe('Olá! Posso ajudar.')
    expect(r.vars.resposta_ia).toBe('Olá! Posso ajudar.')
  })

  it('AC-T42-03 erro do LLM → failure com ai.fail.reason', async () => {
    const c = await company(env)
    const llm = new env.ai.FakeLlm([env.ai.fail(new Error('provedor indisponível'))])
    const r = await run(env, c, aiDef({ ...conditions, fail_reason_variable: 'motivo_falha' }), { llm, guard: guard() })
    expect(r.visited).toEqual(['F'])
    expect(typeof r.vars.ai.fail.reason).toBe('string')
    expect(r.vars.ai.fail.reason.length).toBeGreaterThan(0)
    expect(r.vars.motivo_falha).toBe(r.vars.ai.fail.reason)
  })
})

describe('T42 — medição e cota', () => {
  const simple = def(
    [node('A', 'ai', [action('A-a', 'ai_call', { provider: 'gpt', user_message: 'resuma' })]), marker('S'), marker('F')],
    [edge('start', 'source', 'A'), edge('A', 'success', 'S'), edge('A', 'failure', 'F')],
  )

  it("AC-T42-04 toda chamada de IA do nó grava ai_usage com feature 'flow_ai'", async () => {
    const c = await company(env)
    const llm = new env.ai.FakeLlm([env.ai.text('resumo', { usage: { inputTokens: 1200, outputTokens: 300 } })])
    const r = await run(env, c, simple, { llm, guard: new env.core.UsageGuard({ db: env.db, redis: env.redis }) })
    expect(r.visited).toEqual(['S'])
    const rows = await env.q(`SELECT feature, agent_id, input_tokens, output_tokens, status FROM crm.ai_usage WHERE company_id = $1`, [c.companyId])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ feature: 'flow_ai', agent_id: null, status: 'charged' })
    expect(Number(rows[0].input_tokens)).toBe(1200)
    expect(Number(rows[0].output_tokens)).toBe(300)
  })

  it('AC-T42-04 cota esgotada → failure com motivo quota_exceeded, sem chamar o LLM', async () => {
    const c = await company(env, { wallet: 0 })
    const llm = new env.ai.FakeLlm([env.ai.text('não deveria sair')])
    const r = await run(env, c, simple, { llm, guard: new env.core.UsageGuard({ db: env.db, redis: env.redis }) })
    expect(r.visited).toEqual(['F'])
    expect(r.vars.ai.fail.reason).toBe('quota_exceeded')
    expect(llm.calls).toHaveLength(0)
    expect(await env.q(`SELECT 1 FROM crm.ai_usage WHERE company_id = $1 AND status = 'charged'`, [c.companyId])).toHaveLength(0)
  })

  it('AC-T42-04 cota hard mensal estourada também barra com quota_exceeded', async () => {
    const c = await company(env)
    await env.q(`INSERT INTO crm.ai_quotas (company_id, period, max_credits, hard) VALUES ($1, 'month', 1, true)`, [c.companyId])
    const g = new env.core.UsageGuard({ db: env.db, redis: env.redis })
    await g.commit({ requestId: crypto.randomUUID(), companyId: c.companyId, provider: 'openai', model: 'gpt-4.1-mini', feature: 'outro', usage: { inputTokens: 1_000_000, outputTokens: 0 } })
    const llm = new env.ai.FakeLlm([env.ai.text('não deveria sair')])
    const r = await run(env, c, simple, { llm, guard: g })
    expect(r.visited).toEqual(['F'])
    expect(r.vars.ai.fail.reason).toBe('quota_exceeded')
    expect(llm.calls).toHaveLength(0)
  })
})

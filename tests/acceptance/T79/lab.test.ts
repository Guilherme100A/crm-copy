// AC-T79-01..04: teste ao vivo do agente, teto diário (eval_cap), generate-prompt com blocos travados e criação assistida.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import {
  COMPOSED,
  FIELDS,
  MODEL,
  SKILL_HUMAN,
  balanceOf,
  closedPortUrl,
  getAgent,
  lab,
  newAgent,
  newMember,
  newOwner,
  setBalance,
  startSite,
  waitRun,
  type Env,
  startEnv,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const textOf = (m: Any): string => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: Any) => p?.text ?? '').join('\n'))
const allText = (req: Any) => (req?.messages ?? []).map(textOf).join('\n')
const usageRows = (companyId: string, feature: string) =>
  env.q(`SELECT * FROM crm.ai_usage WHERE company_id = $1 AND feature = $2 ORDER BY created_at`, [companyId, feature])

describe('AC-T79-01 teste ao vivo com o runtime do T68', () => {
  it('AC-T79-01 resposta de texto: blocos, trace, créditos cobrados na carteira e sem WhatsApp', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    const agent = await newAgent(o, { generated_prompt: 'Você é a Bia, atendente da Escola Horizonte. PROMPT-T79-A' })
    l.llm.enqueue(env.ai.text('Olá! Temos cursos de inglês e espanhol.'))
    const before = await balanceOf(env, o.companyId)
    const sentBefore = env.gateway.sent.length

    const res = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'Quais cursos vocês têm?' })
    expect(res.status, res.text).toBe(200)
    const b = res.body
    expect(b.blocks).toEqual([{ type: 'text', text: 'Olá! Temos cursos de inglês e espanhol.' }])
    expect(b.skills_fired).toEqual([])
    expect(b.fields_filled).toEqual({})
    expect(b.handoff).toBeNull()
    expect(b.trace.model).toEqual(MODEL)
    expect(b.trace.instructions).toContain('PROMPT-T79-A')
    expect(Array.isArray(b.trace.tool_calls)).toBe(true)
    expect(b.charged_credits).toBeGreaterThan(0)
    expect(b.usage.input_tokens).toBeGreaterThan(0)
    expect(b.eval).toMatchObject({ used: 1 })

    // o LLM recebeu o texto do teste
    expect(l.llm.callCount).toBe(1)
    expect(allText(l.llm.calls[0])).toContain('Quais cursos vocês têm?')
    // cobrança: carteira debitada e linha de uso do teste
    expect(await balanceOf(env, o.companyId)).toBe(before - b.charged_credits)
    const rows = await usageRows(o.companyId, 'ai_agent_test')
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agent.id)
    expect(Number(rows[0].credits)).toBe(b.charged_credits)
    // modo teste: nada vai para o WhatsApp
    expect(env.gateway.sent.length).toBe(sentBefore)
  })

  it('AC-T79-01 habilidades disparadas e campos preenchidos são registrados sem efeito; histórico e DELETE', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    const agent = await newAgent(o, { skills: [SKILL_HUMAN], collection_fields: FIELDS })
    const chatsBefore = await env.q(`SELECT count(*)::int AS n FROM crm.chats WHERE company_id = $1`, [o.companyId])

    l.llm.enqueue(
      env.ai.toolCalls([
        { name: 'fill_field', input: { key: 'nome', value: 'Ana' } },
        { name: 'transfer_human', input: { reason: 'cliente pediu humano' } },
      ]),
      env.ai.text('Certo, Ana! Vou te passar para uma pessoa.'),
    )
    const r1 = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'Sou a Ana, quero falar com uma pessoa' })
    expect(r1.status, r1.text).toBe(200)
    expect(r1.body.fields_filled).toEqual({ nome: 'Ana' })
    expect(r1.body.collected).toEqual({ nome: 'Ana' })
    expect(r1.body.skills_fired).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'transfer_human', action_type: 'transfer_human' })]))
    expect(r1.body.trace.tool_calls.map((t: Any) => t.name)).toEqual(expect.arrayContaining(['fill_field', 'transfer_human']))
    expect(r1.body.blocks.map((x: Any) => x.text).join(' ')).toContain('Certo, Ana!')
    // sem efeito: agente continua igual e nenhum chat foi criado/alterado
    const after = await getAgent(o, agent.id)
    expect(after.status).toBe(agent.status)
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.chats WHERE company_id = $1`, [o.companyId]))[0].n).toBe(chatsBefore[0].n)
    expect(await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND name = 'Ana'`, [o.companyId])).toHaveLength(0)

    // segundo turno: campos do turno × acumulado; o histórico do teste chega ao LLM
    l.llm.enqueue(env.ai.toolCall('fill_field', { key: 'email', value: 'ana@example.test' }), env.ai.text('Anotado!'))
    const r2 = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'meu e-mail é ana@example.test' })
    expect(r2.status, r2.text).toBe(200)
    expect(r2.body.fields_filled).toEqual({ email: 'ana@example.test' })
    expect(r2.body.collected).toEqual({ nome: 'Ana', email: 'ana@example.test' })
    expect(allText(l.llm.calls.at(-1))).toContain('Sou a Ana, quero falar com uma pessoa')

    // "Limpar conversa": zera o histórico e o acumulado, sem mexer no cadastro
    const del = await o.c.delete(`/api/ai-agents/${agent.id}/test-messages`)
    expect(del.status, del.text).toBe(200)
    expect(del.body).toEqual({ ok: true })
    l.llm.enqueue(env.ai.text('Olá de novo!'))
    const r3 = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' })
    expect(r3.status, r3.text).toBe(200)
    expect(r3.body.collected).toEqual({})
    expect(allText(l.llm.calls.at(-1))).not.toContain('Sou a Ana')
    expect((await getAgent(o, agent.id)).name).toBe(agent.name)
  })

  it('AC-T79-01 draft sobrepõe os campos só no teste; nada é salvo; draft inválido → 422', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    const agent = await newAgent(o, { generated_prompt: 'PROMPT-SALVO-T79' })
    l.llm.enqueue(env.ai.text('Resposta do rascunho'))
    const res = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, {
      text: 'oi',
      draft: { generated_prompt: 'PROMPT-RASCUNHO-T79', name: 'Nome do rascunho' },
    })
    expect(res.status, res.text).toBe(200)
    expect(res.body.trace.instructions).toContain('PROMPT-RASCUNHO-T79')
    expect(res.body.trace.instructions).not.toContain('PROMPT-SALVO-T79')
    const saved = await getAgent(o, agent.id)
    expect(saved.generated_prompt).toBe('PROMPT-SALVO-T79')
    expect(saved.name).toBe(agent.name)

    const bad = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi', draft: { personality: 'nao-existe' } })
    expect(bad.status, bad.text).toBe(422)
    expectApiError(await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: '' }), 'VALIDATION_ERROR', 422)
  })

  it('AC-T79-01 sem saldo → 429 QUOTA_EXCEEDED (no_balance), LLM não chamado e não conta no eval_cap', async () => {
    const l = lab(env)
    const o = await newOwner(env, l, 0)
    const agent = await newAgent(o)
    const res = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' })
    expectApiError(res, 'QUOTA_EXCEEDED', 429)
    expect(res.body.error.details?.reason).toBe('no_balance')
    expect(l.llm.callCount).toBe(0)

    await setBalance(env, o.companyId, 1_000_000_000)
    l.llm.enqueue(env.ai.text('Agora sim'))
    const ok = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.eval.used).toBe(1)
  })

  it('AC-T79-01 permissão flows.edit e isolamento: outra empresa → 404', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    const agent = await newAgent(o)
    const viewer = await newMember(env, l, o.companyId, ['flows.view'])
    expectApiError(await viewer.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' }), 'FORBIDDEN', 403)
    const stranger = await newOwner(env, l)
    expectApiError(await stranger.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' }), 'NOT_FOUND', 404)
    expectApiError(await o.c.post(`/api/ai-agents/${uuid()}/test-messages`, { text: 'oi' }), 'NOT_FOUND', 404)
    expect(l.llm.callCount).toBe(0)
  })
})

describe('AC-T79-02 teto diário de testes por empresa', () => {
  it('AC-T79-02 ao exceder o eval_cap → 429 com reason eval_cap, sem chamar o LLM; outra empresa segue livre', async () => {
    const l = lab(env, { evalCap: 2 })
    const o = await newOwner(env, l)
    const agent = await newAgent(o)
    for (let i = 1; i <= 2; i++) {
      l.llm.enqueue(env.ai.text(`resposta ${i}`))
      const ok = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: `msg ${i}` })
      expect(ok.status, ok.text).toBe(200)
      expect(ok.body.eval).toEqual({ used: i, limit: 2 })
    }
    const calls = l.llm.callCount
    const balance = await balanceOf(env, o.companyId)
    const over = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'msg 3' })
    expectApiError(over, 'QUOTA_EXCEEDED', 429)
    expect(over.body.error.details).toMatchObject({ reason: 'eval_cap', limit: 2, used: 2 })
    expect(l.llm.callCount).toBe(calls)
    expect(await balanceOf(env, o.companyId)).toBe(balance)

    // o teto é da empresa (vale para outro agente da mesma empresa) e não afeta outra empresa
    const agent2 = await newAgent(o)
    expectApiError(await o.c.post(`/api/ai-agents/${agent2.id}/test-messages`, { text: 'outro agente' }), 'QUOTA_EXCEEDED', 429)
    const other = await newOwner(env, l)
    const otherAgent = await newAgent(other)
    l.llm.enqueue(env.ai.text('livre'))
    const free = await other.c.post(`/api/ai-agents/${otherAgent.id}/test-messages`, { text: 'oi' })
    expect(free.status, free.text).toBe(200)
    expect(free.body.eval).toEqual({ used: 1, limit: 2 })
  })
})

describe('AC-T79-03 generate-prompt respeita os blocos travados', () => {
  const LOCKED_SAFETY = '  Nunca prometa resultados garantidos.\n\tResponda só sobre a escola.  '
  const LOCKED_RULES = 'REGRA TRAVADA: preços só pelo site oficial.'

  async function agentWithBlocks() {
    const l = lab(env)
    const o = await newOwner(env, l)
    const agent = await newAgent(o, {
      generated_prompt: '',
      purpose: 'Vender cursos de idiomas PURPOSE-T79',
      audience: '',
      personality: 'consultative',
      primary_goal: 'sell',
      example_messages: 'Oi! Quer conhecer nossas turmas? EXEMPLO-T79',
      business_rules: 'Regra do formulário que deve sumir RULES-FORM-T79',
      never_talk_about: 'Política NEVER-T79',
    })
    await env.q(`UPDATE crm.ai_agents SET locked_blocks = $2::jsonb WHERE id = $1`, [
      agent.id,
      JSON.stringify([
        { key: 'safety', title: 'Segurança', text: LOCKED_SAFETY },
        { key: 'rules', title: 'Regras', text: LOCKED_RULES },
      ]),
    ])
    return { l, o, agent }
  }

  it('AC-T79-03 monta o prompt dos campos e insere os blocos travados verbatim', async () => {
    const { l, o, agent } = await agentWithBlocks()
    const res = await o.c.post(`/api/ai-agents/${agent.id}/generate-prompt`, {})
    expect(res.status, res.text).toBe(200)
    const { prompt, blocks } = res.body
    expect(typeof prompt).toBe('string')

    // campos preenchidos viram blocos destravados; campo vazio é omitido
    for (const marker of ['PURPOSE-T79', 'EXEMPLO-T79', 'NEVER-T79']) expect(prompt).toContain(marker)
    expect(blocks.filter((b: Any) => !b.locked).map((b: Any) => b.text).join('\n')).toContain('PURPOSE-T79')
    expect(blocks.map((b: Any) => b.key)).not.toContain('audience')

    // travados: texto byte a byte no prompt e no bloco
    const safety = blocks.find((b: Any) => b.key === 'safety')
    expect(safety).toMatchObject({ locked: true, text: LOCKED_SAFETY })
    expect(prompt).toContain(LOCKED_SAFETY)
    // travado com o mesmo key de um bloco de campo prevalece sobre o campo
    const rules = blocks.filter((b: Any) => b.key === 'rules')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ locked: true, text: LOCKED_RULES })
    expect(prompt).toContain(LOCKED_RULES)
    expect(prompt).not.toContain('RULES-FORM-T79')
    // todo bloco está no prompt, na ordem dos blocos
    let pos = -1
    for (const b of blocks) {
      const at = prompt.indexOf(b.text, pos + 1)
      expect(at, `bloco ${b.key} fora do prompt ou fora de ordem`).toBeGreaterThan(pos)
      pos = at
    }
    // determinístico e sem LLM
    expect(l.llm.callCount).toBe(0)
    const again = await o.c.post(`/api/ai-agents/${agent.id}/generate-prompt`, {})
    expect(again.body.prompt).toBe(prompt)
  })

  it('AC-T79-03 salva generated_prompt, last_generated_prompt e prompt_edited=false', async () => {
    const { o, agent } = await agentWithBlocks()
    // edição à mão antes de gerar
    const patch = await o.c.patch(`/api/ai-agents/${agent.id}`, { generated_prompt: 'editado à mão' })
    expect(patch.status, patch.text).toBe(200)
    const res = await o.c.post(`/api/ai-agents/${agent.id}/generate-prompt`, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body.agent.generated_prompt).toBe(res.body.prompt)
    const saved = await getAgent(o, agent.id)
    expect(saved.generated_prompt).toBe(res.body.prompt)
    expect(saved.last_generated_prompt).toBe(res.body.prompt)
    expect(saved.prompt_edited).toBe(false)
  })

  it('AC-T79-03 o teste ao vivo com prompt vazio usa o prompt gerado (com os travados)', async () => {
    const { l, o, agent } = await agentWithBlocks()
    l.llm.enqueue(env.ai.text('ok'))
    const res = await o.c.post(`/api/ai-agents/${agent.id}/test-messages`, { text: 'oi' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.trace.instructions).toContain(LOCKED_SAFETY)
    expect(res.body.trace.instructions).toContain('PURPOSE-T79')
  })

  it('AC-T79-03 permissão flows.edit e outra empresa → 404', async () => {
    const { l, o, agent } = await agentWithBlocks()
    const viewer = await newMember(env, l, o.companyId, ['flows.view'])
    expectApiError(await viewer.c.post(`/api/ai-agents/${agent.id}/generate-prompt`, {}), 'FORBIDDEN', 403)
    const stranger = await newOwner(env, l)
    expectApiError(await stranger.c.post(`/api/ai-agents/${agent.id}/generate-prompt`, {}), 'NOT_FOUND', 404)
  })
})

const SITE_HTML = `<!doctype html><html><head><title>Doceria Aurora</title></head><body>
<h1>Doceria Aurora</h1><p>Bolos artesanais, doces finos e tortas por encomenda para aniversários e casamentos.
Entregamos em toda a cidade com agendamento de 48 horas.</p></body></html>`
const PITCH = 'Vendo bolos e doces por encomenda para festas e eventos.'

const runEvents = (l: Any, companyId: string) =>
  l.published.filter((p: Any) => p.companyId === companyId && p.type === 'ai_agent.run.updated').map((p: Any) => p.data.run)

describe('AC-T79-04 criação assistida como job', () => {
  it('AC-T79-04 pitch + site: estágios extract → compose → persist, agente criado com fonte site e SSE por etapa', async () => {
    const site = await startSite(SITE_HTML)
    try {
      const l = lab(env)
      const o = await newOwner(env, l)
      l.llm.enqueue(env.ai.output(COMPOSED))
      const res = await o.c.post('/api/ai-agents/runs', { pitch: PITCH, site_url: site.url })
      expect(res.status, res.text).toBe(202)
      expect(['queued', 'running', 'completed']).toContain(res.body.run.status)
      const run = await waitRun(o, res.body.run.id)
      expect(run).toMatchObject({ status: 'completed', error_message: null, warnings: [] })
      expect(run.stages_done).toEqual(['extract', 'compose', 'persist'])
      expect(site.hits.length).toBeGreaterThan(0)

      // compose usou o site e o pitch
      expect(l.llm.callCount).toBe(1)
      const composeReq = JSON.stringify([l.llm.calls[0].instructions, l.llm.calls[0].messages])
      expect(composeReq).toContain('Doceria Aurora')
      expect(composeReq).toContain('bolos e doces por encomenda')
      expect((await env.q(`SELECT * FROM crm.ai_usage WHERE company_id = $1 AND feature = 'ai_agent_create'`, [o.companyId])).length).toBeGreaterThan(0)

      // persist: agente rascunho com os campos compostos e o prompt gerado; fonte de conhecimento do site
      const agent = await getAgent(o, run.agent_id)
      expect(agent).toMatchObject({ name: COMPOSED.name, status: 'draft', purpose: COMPOSED.purpose, personality: 'seller', primary_goal: 'sell' })
      expect(agent.generated_prompt.length).toBeGreaterThan(0)
      const sources = await env.q(`SELECT kind, url FROM crm.ai_knowledge_sources WHERE agent_id = $1`, [run.agent_id])
      expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'site' })]))

      // SSE ai_agent.run.updated a cada mudança: passa pelos 3 estágios e termina em completed
      const events = runEvents(l, o.companyId)
      expect(events.length).toBeGreaterThanOrEqual(4)
      expect(events.every((e: Any) => e.id === run.id)).toBe(true)
      const stages = events.map((e: Any) => e.stage).filter(Boolean)
      for (const s of ['extract', 'compose', 'persist']) expect(stages).toContain(s)
      expect(stages.indexOf('extract')).toBeLessThan(stages.indexOf('compose'))
      expect(stages.indexOf('compose')).toBeLessThan(stages.indexOf('persist'))
      expect(events.at(-1)).toMatchObject({ status: 'completed', agent_id: run.agent_id })
    } finally {
      await site.close()
    }
  })

  it('AC-T79-04 site ilegível → warning site_unread (o run ainda completa)', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    l.llm.enqueue(env.ai.output(COMPOSED))
    const res = await o.c.post('/api/ai-agents/runs', { pitch: PITCH, site_url: await closedPortUrl() })
    expect(res.status, res.text).toBe(202)
    const run = await waitRun(o, res.body.run.id)
    expect(run.status).toBe('completed')
    expect(run.warnings).toContain('site_unread')
    expect(run.warnings).not.toContain('empty_knowledge')
    expect(await env.q(`SELECT * FROM crm.ai_knowledge_sources WHERE agent_id = $1 AND kind = 'site'`, [run.agent_id])).toHaveLength(0)
  })

  it('AC-T79-04 conhecimento insuficiente → warning empty_knowledge (com e sem site)', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    l.llm.enqueue(env.ai.output(COMPOSED))
    const r1 = await o.c.post('/api/ai-agents/runs', { pitch: 'Vendo bolo' })
    expect(r1.status, r1.text).toBe(202)
    const run1 = await waitRun(o, r1.body.run.id)
    expect(run1.status).toBe('completed')
    expect(run1.warnings).toContain('empty_knowledge')
    expect(run1.warnings).not.toContain('site_unread')

    l.llm.enqueue(env.ai.output(COMPOSED))
    const r2 = await o.c.post('/api/ai-agents/runs', { pitch: 'Vendo bolo', site_url: await closedPortUrl() })
    expect(r2.status, r2.text).toBe(202)
    const run2 = await waitRun(o, r2.body.run.id)
    expect(run2.warnings).toEqual(expect.arrayContaining(['site_unread', 'empty_knowledge']))
  })

  it('AC-T79-04 um run por empresa por vez: create_in_progress → 409; outra empresa livre', async () => {
    const l = lab(env, { runMode: 'capture' })
    const o = await newOwner(env, l)
    const first = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expect(first.status, first.text).toBe(202)
    expect(first.body.run.status).toBe('queued')
    expect(l.enqueued).toEqual(expect.arrayContaining([{ runId: first.body.run.id, companyId: o.companyId }]))

    const second = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expectApiError(second, 'CONFLICT', 409)
    expect(second.body.error.details).toMatchObject({ reason: 'create_in_progress', run_id: first.body.run.id })

    const other = await newOwner(env, l)
    expect((await other.c.post('/api/ai-agents/runs', { pitch: PITCH })).status).toBe(202)
  })

  it('AC-T79-04 trava liberada ao terminar (sucesso e falha); falha por saldo → failed com no_balance', async () => {
    const l = lab(env)
    const o = await newOwner(env, l)
    l.llm.enqueue(env.ai.output(COMPOSED))
    const ok = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expect(ok.status, ok.text).toBe(202)
    expect((await waitRun(o, ok.body.run.id)).status).toBe('completed')

    await setBalance(env, o.companyId, 0)
    const poor = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expect(poor.status, poor.text).toBe(202)
    const failed = await waitRun(o, poor.body.run.id)
    expect(failed).toMatchObject({ status: 'failed', error_message: 'no_balance', agent_id: null })
    expect(runEvents(l, o.companyId).at(-1)).toMatchObject({ id: failed.id, status: 'failed' })

    await setBalance(env, o.companyId, 1_000_000_000)
    l.llm.enqueue(env.ai.output(COMPOSED))
    const again = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expect(again.status, again.text).toBe(202)
    expect((await waitRun(o, again.body.run.id)).status).toBe('completed')
  })

  it('AC-T79-04 validação, permissão e isolamento do run', async () => {
    const l = lab(env, { runMode: 'capture' })
    const o = await newOwner(env, l)
    expectApiError(await o.c.post('/api/ai-agents/runs', { pitch: 'curto' }), 'VALIDATION_ERROR', 422)
    expectApiError(await o.c.post('/api/ai-agents/runs', { pitch: PITCH, site_url: 'ftp://exemplo.test/' }), 'VALIDATION_ERROR', 422)
    expectApiError(await o.c.post('/api/ai-agents/runs', {}), 'VALIDATION_ERROR', 422)
    const viewer = await newMember(env, l, o.companyId, ['flows.view'])
    expectApiError(await viewer.c.post('/api/ai-agents/runs', { pitch: PITCH }), 'FORBIDDEN', 403)

    const res = await o.c.post('/api/ai-agents/runs', { pitch: PITCH })
    expect(res.status, res.text).toBe(202)
    const got = await viewer.c.get(`/api/ai-agents/runs/${res.body.run.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.body.run).toMatchObject({ id: res.body.run.id, status: 'queued', stage: null, stages_done: [], warnings: [], agent_id: null })
    const stranger = await newOwner(env, l)
    expectApiError(await stranger.c.get(`/api/ai-agents/runs/${res.body.run.id}`), 'NOT_FOUND', 404)
  })
})

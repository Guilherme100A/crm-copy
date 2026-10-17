// AC-T82-01..03 pela rota `POST /api/flows/:id/simulate` (app.request, Postgres real): rascunho em dry-run com a
// transcrição e o caminho, continuação stateless pelo handle escolhido (resume/vars/steps_so_far) e o loop_guard de 50
// passos no caminho inteiro. Nada é gravado (flow_runs/flow_run_steps), nada vai ao gateway e nenhuma rede é chamada.
import http from 'node:http'
import https from 'node:https'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectApiError } from '../helpers/http'
import { def, draft, edge, msg, newMember, newOwner, node, putDraft, simulate, texts, type Env, type User, startEnv } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})
afterEach(() => vi.restoreAllMocks())

const count = async (table: string, companyId: string) =>
  Number((await env.q(`SELECT count(*)::int AS n FROM crm.${table} WHERE company_id = $1`, [companyId]))[0].n)

/** start → hello → etiquetas (não simulado) → menu (o1 Vendas → sales; o2 sem aresta; other; timeout). */
const menuFlow = (start: Any) =>
  def(
    [
      start,
      msg('hello', 'Olá, {nome}!'),
      node('tags', 'tags', [{ type: 'add_tags', config: { tags: ['lead'] } }]),
      node('menu', 'interactive_menu', [
        { type: 'send_interactive_menu', config: { message: 'Com quem quer falar?', options: [{ id: 'o1', title: 'Vendas' }, { id: 'o2', title: 'Suporte' }] } },
        { type: 'save_user_data', config: { field_name: 'setor' } },
      ]),
      msg('sales', 'Vendas aqui ({setor})'),
      msg('late', 'Você demorou'),
      msg('other', 'Não entendi'),
    ],
    [
      edge(start.id, 'source', 'hello'),
      edge('hello', 'source', 'tags'),
      edge('tags', 'source', 'menu'),
      edge('menu', 'option:o1', 'sales'),
      edge('menu', 'timeout', 'late'),
      edge('menu', 'other', 'other'),
    ],
    start.id,
  )

describe('AC-T82-01 dry-run do rascunho', () => {
  it('AC-T82-01 devolve a transcrição das mensagens, o caminho percorrido e a espera atual', async () => {
    const { flowId, startId } = await draft(owner, menuFlow)
    const res = await simulate(owner, flowId, { vars: { nome: 'Ana' } })
    expect(res.status, res.text).toBe(200)
    const sim = res.body.simulation
    expect(sim.status).toBe('waiting')
    expect(sim.steps.map((s: Any) => [s.seq, s.node_key, s.status])).toEqual([
      [1, startId, 'done'],
      [2, 'hello', 'done'],
      [3, 'tags', 'done'],
      [4, 'menu', 'done'],
    ])
    expect(sim.steps_total).toBe(4)
    // transcrição: texto renderizado (variável aplicada) e o menu com as opções; cada mensagem com o nó de origem
    expect(sim.messages.map((m: Any) => [m.node_key, m.to])).toEqual([
      ['hello', 'contact'],
      ['menu', 'contact'],
    ])
    expect(texts(sim)[0]).toBe('Olá, Ana!')
    expect(String(texts(sim)[1])).toContain('Com quem quer falar?')
    // nó de CRM não é executado de verdade: aviso "não simulado" e segue
    expect(sim.notices).toEqual([{ code: 'not_simulated', seq: 3, node_key: 'tags', node_type: 'tags' }])
    expect(sim.wait).toMatchObject({ node_key: 'menu', node_type: 'interactive_menu', kind: 'menu' })
    expect(sim.wait.choices).toEqual([
      { handle: 'option:o1', label: 'Vendas', connected: true },
      { handle: 'option:o2', label: 'Suporte', connected: false },
      { handle: 'other', connected: true },
      { handle: 'timeout', connected: true },
    ])
  })

  it('AC-T82-01 executa o RASCUNHO, não a versão publicada', async () => {
    const { flowId } = await draft(owner, (start) => def([start, msg('m', 'versão publicada')], [edge(start.id, 'source', 'm')], start.id))
    const act = await owner.c.post(`/api/flows/${flowId}/activate`)
    expect(act.status, act.text).toBeLessThan(300)
    await putDraft(owner, flowId, (start) => def([start, msg('m', 'rascunho novo')], [edge(start.id, 'source', 'm')], start.id))
    const res = await simulate(owner, flowId)
    expect(res.status, res.text).toBe(200)
    expect(texts(res.body.simulation)).toEqual(['rascunho novo'])
    expect(res.body.simulation).toMatchObject({ status: 'finished', end: { reason: 'no_next', node_key: 'm' } })
  })

  it('AC-T82-01 não grava runs/passos nem chama o gateway; nenhuma requisição externa (integração e IA)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const httpSpy = vi.spyOn(http, 'request')
    const httpGetSpy = vi.spyOn(http, 'get')
    const httpsSpy = vi.spyOn(https, 'request')
    const sentBefore = env.gateway.sent.length
    const hitsBefore = env.hits()
    const { flowId, startId } = await draft(owner, (start) =>
      def(
        [
          start,
          msg('hi', 'oi'),
          node('notify', 'notification', [{ type: 'send_notification', config: { phone: '11999990000', message: 'Novo lead' } }]),
          node('http', 'integration', [{ type: 'make_http_request', config: { request_method: 'POST', request_url: env.hookUrl, request_body: '{"a":1}' } }]),
          node('ai', 'ai', [{ type: 'ai_call', config: { user_message: 'oi', output_conditions: [{ output_key: 'compra', prompt: 'Quer comprar' }] } }]),
          node('dist', 'distributor', [{ type: 'distribute_contacts', config: { outputs: [{ id: 'a', name: 'Equipe A' }, { id: 'b', name: 'Equipe B' }] } }]),
          msg('end', 'fim'),
        ],
        [
          edge(start.id, 'source', 'hi'),
          edge('hi', 'source', 'notify'),
          edge('notify', 'source', 'http'),
          edge('http', 'success', 'ai'),
          edge('ai', 'output:compra', 'dist'),
          edge('dist', 'output:a', 'end'),
        ],
        start.id,
      ),
    )
    const first = (await simulate(owner, flowId)).body.simulation
    expect(first.steps.map((s: Any) => s.node_key)).toEqual([startId, 'hi', 'notify', 'http'])
    expect(first.messages.map((m: Any) => [m.node_key, m.to, m.text])).toEqual([
      ['hi', 'contact', 'oi'],
      ['notify', 'internal', 'Novo lead'],
    ])
    expect(first.wait).toMatchObject({ node_key: 'http', kind: 'integration_choice' })
    let sim = first
    for (const [nodeKey, h] of [['http', 'success'], ['ai', 'output:compra'], ['dist', 'output:a']]) {
      const r = await simulate(owner, flowId, { resume: { node_key: nodeKey, handle: h }, vars: sim.vars, steps_so_far: sim.steps_total })
      expect(r.status, r.text).toBe(200)
      sim = r.body.simulation
    }
    expect(texts(sim)).toEqual(['fim'])
    expect(sim.status).toBe('finished')

    // nada saiu do processo: nem o servidor "de terceiros", nem fetch/http/https, nem o gateway
    expect(env.hits() - hitsBefore).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpGetSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(env.gateway.sent.length - sentBefore).toBe(0)
    // nada gravado
    expect(await count('flow_runs', owner.companyId)).toBe(0)
    expect(await count('flow_run_steps', owner.companyId)).toBe(0)
    expect(await count('flow_distributor_counters', owner.companyId)).toBe(0)
  })

  it('AC-T82-01 fluxo sem próximo passo → finished/no_next (sem 500)', async () => {
    const { flowId, startId } = await draft(owner, (start) => def([start], [], start.id))
    const res = await simulate(owner, flowId)
    expect(res.status, res.text).toBe(200)
    expect(res.body.simulation).toMatchObject({ status: 'finished', end: { reason: 'no_next', node_key: startId } })
  })

  it('AC-T82-01 permissão: flows.view basta; sem flows.view → 403; fluxo de outra empresa → 404; corpo inválido → 422', async () => {
    const { flowId } = await draft(owner, menuFlow)
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    const ok = await simulate(viewer, flowId)
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.simulation.status).toBe('waiting')

    const noPerm = await newMember(env, owner.companyId, ['chats.view'])
    expect((await simulate(noPerm, flowId)).status).toBe(403)

    const stranger = await newOwner(env)
    expectApiError(await simulate(stranger, flowId), 'NOT_FOUND', 404)
    expectApiError(await simulate(owner, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND', 404)

    expectApiError(await simulate(owner, flowId, { steps_so_far: -1 }), 'VALIDATION_ERROR', 422)
    expectApiError(await simulate(owner, flowId, { resume: { handle: 'other' } }), 'VALIDATION_ERROR', 422)
    const unknown = await simulate(owner, flowId, { resume: { node_key: 'nao-existe', handle: 'source' } })
    expectApiError(unknown, 'VALIDATION_ERROR', 422)
    expect(unknown.body.error.details.fields[0].path).toBe('resume.node_key')
    const badHandle = await simulate(owner, flowId, { resume: { node_key: 'menu', handle: 'success' } })
    expectApiError(badHandle, 'VALIDATION_ERROR', 422)
    expect(badHandle.body.error.details.fields[0].path).toBe('resume.handle')
  })
})

describe('AC-T82-02 respostas simuladas escolhem o handle', () => {
  it('AC-T82-02 opção do menu: segue a aresta do handle, sem reexecutar o menu, e grava a resposta', async () => {
    const { flowId } = await draft(owner, menuFlow)
    const first = (await simulate(owner, flowId)).body.simulation
    const res = await simulate(owner, flowId, { resume: { node_key: 'menu', handle: 'option:o1' }, vars: first.vars, steps_so_far: first.steps_total })
    expect(res.status, res.text).toBe(200)
    const sim = res.body.simulation
    expect(sim.steps.map((s: Any) => [s.seq, s.node_key])).toEqual([[5, 'sales']])
    expect(texts(sim)).toEqual(['Vendas aqui (Vendas)'])
    expect(sim.vars.setor).toBe('Vendas')
    expect(sim.steps_total).toBe(5)
    expect(sim.status).toBe('finished')
  })

  it('AC-T82-02 timeout e "outra resposta" seguem os seus handles; opção sem aresta termina (no_next)', async () => {
    const { flowId } = await draft(owner, menuFlow)
    const first = (await simulate(owner, flowId)).body.simulation
    const go = async (h: string, text?: string) =>
      (await simulate(owner, flowId, { resume: { node_key: 'menu', handle: h, ...(text ? { text } : {}) }, vars: first.vars, steps_so_far: first.steps_total })).body.simulation
    expect(texts(await go('timeout'))).toEqual(['Você demorou'])
    expect(texts(await go('other', 'quero um humano'))).toEqual(['Não entendi'])
    expect(await go('option:o2')).toMatchObject({ status: 'finished', steps: [], end: { reason: 'no_next', node_key: 'menu', handle: 'option:o2' } })
  })

  it('AC-T82-02 condição e integração: sucesso e falha seguem caminhos diferentes', async () => {
    const { flowId } = await draft(owner, (start) =>
      def(
        [
          start,
          node('cond', 'condition', [{ type: 'evaluate_condition', config: { ruleType: 'all', conditions: [] } }]),
          node('http', 'integration', [{ type: 'make_http_request', config: { request_method: 'GET', request_url: env.hookUrl } }]),
          msg('ok', 'deu certo'),
          msg('no', 'falhou'),
        ],
        [
          edge(start.id, 'source', 'cond'),
          edge('cond', 'success', 'http'),
          edge('cond', 'failure', 'no'),
          edge('http', 'success', 'ok'),
          edge('http', 'failure', 'no'),
        ],
        start.id,
      ),
    )
    const hitsBefore = env.hits()
    const c = (await simulate(owner, flowId)).body.simulation
    expect(c.wait).toMatchObject({ node_key: 'cond', kind: 'condition_choice' })
    expect(c.wait.choices.map((x: Any) => x.handle)).toEqual(['success', 'failure'])
    const resume = (nodeKey: string, h: string, prev: Any) =>
      simulate(owner, flowId, { resume: { node_key: nodeKey, handle: h }, vars: prev.vars, steps_so_far: prev.steps_total }).then((r) => r.body.simulation)
    expect(texts(await resume('cond', 'failure', c))).toEqual(['falhou'])
    const h = await resume('cond', 'success', c)
    expect(h.wait).toMatchObject({ node_key: 'http', kind: 'integration_choice' })
    expect(texts(await resume('http', 'success', h))).toEqual(['deu certo'])
    expect(texts(await resume('http', 'failure', h))).toEqual(['falhou'])
    expect(env.hits() - hitsBefore).toBe(0)
  })

  it('AC-T82-02 aguardar resposta: o texto digitado vira {response}; "Simular timeout" segue o handle timeout', async () => {
    const { flowId } = await draft(owner, (start) =>
      def(
        [
          start,
          node('w', 'wait_response', [{ type: 'wait_for_response', config: { timeout_value: 5, timeout_unit: 'minutes' } }]),
          msg('echo', 'Você disse: {response}'),
          msg('late', 'Sem resposta'),
        ],
        [edge(start.id, 'source', 'w'), edge('w', 'source', 'echo'), edge('w', 'timeout', 'late')],
        start.id,
      ),
    )
    const first = (await simulate(owner, flowId)).body.simulation
    expect(first.wait).toMatchObject({ node_key: 'w', kind: 'wait_response' })
    expect(first.wait.choices.map((x: Any) => x.handle)).toEqual(['source', 'timeout'])
    const said = (await simulate(owner, flowId, { resume: { node_key: 'w', handle: 'source', text: 'quero comprar' }, vars: first.vars, steps_so_far: first.steps_total })).body.simulation
    expect(texts(said)).toEqual(['Você disse: quero comprar'])
    const late = (await simulate(owner, flowId, { resume: { node_key: 'w', handle: 'timeout' }, vars: first.vars, steps_so_far: first.steps_total })).body.simulation
    expect(texts(late)).toEqual(['Sem resposta'])
  })
})

describe('AC-T82-03 loop ou caminho acima de 50 passos', () => {
  it('AC-T82-03 loop sem espera é interrompido em 50 passos e marcado (interrupted: loop_guard + nó)', async () => {
    const { flowId } = await draft(owner, (start) =>
      def([start, msg('a', 'A'), msg('b', 'B')], [edge(start.id, 'source', 'a'), edge('a', 'source', 'b'), edge('b', 'source', 'a')], start.id),
    )
    const res = await simulate(owner, flowId)
    expect(res.status, res.text).toBe(200)
    const sim = res.body.simulation
    expect(sim.status).toBe('finished')
    expect(sim.interrupted).toBe('loop_guard')
    expect(sim.steps).toHaveLength(50)
    expect(sim.steps_total).toBe(50)
    expect(sim.end.reason).toBe('loop_guard')
    expect(['a', 'b']).toContain(sim.end.node_key)
    expect(await count('flow_runs', owner.companyId)).toBe(0)
  })

  it('AC-T82-03 caminho linear com mais de 50 passos (sem ciclo) também é interrompido', async () => {
    const n = 55
    const { flowId } = await draft(owner, (start) => {
      const nodes = Array.from({ length: n }, (_, i) => msg(`m${i}`, `passo ${i}`))
      const edges = [edge(start.id, 'source', 'm0'), ...nodes.slice(1).map((_, i) => edge(`m${i}`, 'source', `m${i + 1}`))]
      return def([start, ...nodes], edges, start.id)
    })
    const sim = (await simulate(owner, flowId)).body.simulation
    expect(sim).toMatchObject({ status: 'finished', interrupted: 'loop_guard', steps_total: 50, end: { reason: 'loop_guard' } })
    expect(sim.steps).toHaveLength(50)
    expect(sim.messages.length).toBeLessThan(n)
  })

  it('AC-T82-03 o limite vale para o caminho inteiro: steps_so_far acumula entre as continuações', async () => {
    const { flowId } = await draft(owner, (start) =>
      def(
        [start, node('w', 'wait_response', [{ type: 'wait_for_response', config: { wait_indefinitely: true } }]), msg('a', 'A'), msg('b', 'B')],
        [edge(start.id, 'source', 'w'), edge('w', 'source', 'a'), edge('a', 'source', 'b'), edge('b', 'source', 'a')],
        start.id,
      ),
    )
    const first = (await simulate(owner, flowId)).body.simulation
    expect(first.status).toBe('waiting')
    const r = (await simulate(owner, flowId, { resume: { node_key: 'w', handle: 'source', text: 'oi' }, vars: first.vars, steps_so_far: 47 })).body.simulation
    expect(r.steps.map((s: Any) => s.seq)).toEqual([48, 49, 50])
    expect(r).toMatchObject({ interrupted: 'loop_guard', steps_total: 50, end: { reason: 'loop_guard' } })
    const normal = (await simulate(owner, flowId, { resume: { node_key: 'w', handle: 'source', text: 'oi' }, vars: first.vars, steps_so_far: first.steps_total })).body.simulation
    expect(normal.steps_total).toBe(50)
    expect(normal.steps).toHaveLength(50 - first.steps_total)
    expect(normal.interrupted).toBe('loop_guard')
  })
})

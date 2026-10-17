// Simulador (T82) sem banco: transcrição/caminho, continuação por handle, loop_guard e zero chamadas de rede.
import http from 'node:http'
import https from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowDefinition } from '@crm/shared/flows'
import { passThroughHandle, simulate, SimulateError } from './simulator'

type Action = { type: string; config: Record<string, unknown> }
const node = (id: string, type: string, actions: Action[] = []) => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  actions: actions.map((a, i) => ({ id: `${id}-a${i}`, order: i, ...a })),
})
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const def = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], entry = 'start'): FlowDefinition => ({
  schema: 'crm.flow/v1',
  entry,
  nodes,
  edges,
  variables: [],
  refs: {},
})
const msg = (id: string, text: string) =>
  node(id, 'message', [{ type: 'send_message', config: { message_text: text } }])
const texts = (r: { messages: Array<{ kind: string; text?: string }> }) =>
  r.messages.map((m) => (m.kind === 'text' ? m.text : m.kind))

const menuFlow = () =>
  def(
    [
      node('start', 'start'),
      msg('hello', 'Olá! Escolha uma opção'),
      node('menu', 'interactive_menu', [
        {
          type: 'send_interactive_menu',
          config: {
            message: 'Menu',
            options: [
              { id: 'o1', title: 'Vendas' },
              { id: 'o2', title: 'Suporte' },
            ],
          },
        },
        { type: 'save_user_data', config: { field_name: 'setor' } },
      ]),
      msg('sales', 'Falando com vendas ({setor})'),
      msg('late', 'Você demorou'),
      msg('other', 'Não entendi'),
    ],
    [
      edge('start', 'source', 'hello'),
      edge('hello', 'source', 'menu'),
      edge('menu', 'option:o1', 'sales'),
      edge('menu', 'timeout', 'late'),
      edge('menu', 'other', 'other'),
    ],
  )

afterEach(() => vi.restoreAllMocks())

describe('simulador de fluxos (T82)', () => {
  it('AC-T82-01 executa o rascunho no dry-run e devolve a transcrição e o caminho até a espera', async () => {
    const r = await simulate(menuFlow())
    expect(r.status).toBe('waiting')
    expect(r.steps.map((s) => [s.seq, s.node_key, s.status, s.handle ?? null])).toEqual([
      [1, 'start', 'done', 'source'],
      [2, 'hello', 'done', 'source'],
      [3, 'menu', 'done', null],
    ])
    expect(texts(r)[0]).toBe('Olá! Escolha uma opção')
    expect(texts(r)[1]).toContain('Vendas')
    expect(r.messages.every((m) => m.to === 'contact')).toBe(true)
    expect(r.messages.map((m) => m.node_key)).toEqual(['hello', 'menu'])
    expect(r.wait).toEqual({
      node_key: 'menu',
      node_type: 'interactive_menu',
      kind: 'menu',
      choices: [
        { handle: 'option:o1', label: 'Vendas', connected: true },
        { handle: 'option:o2', label: 'Suporte', connected: false },
        { handle: 'other', connected: true },
        { handle: 'timeout', connected: true },
      ],
    })
    expect(r.steps_total).toBe(3)
  })

  it('AC-T82-02 a resposta escolhida (opção) segue a aresta do handle sem reexecutar o nó', async () => {
    const first = await simulate(menuFlow())
    const r = await simulate(menuFlow(), {
      resume: { node_key: 'menu', handle: 'option:o1' },
      vars: first.vars,
      steps_so_far: first.steps_total,
    })
    expect(r.status).toBe('finished')
    expect(r.steps.map((s) => [s.seq, s.node_key])).toEqual([[4, 'sales']])
    expect(texts(r)).toEqual(['Falando com vendas (Vendas)'])
    expect(r.messages.map((m) => m.seq)).toEqual([4])
    expect(r.vars.setor).toBe('Vendas')
    expect(r.end).toEqual({ reason: 'no_next', node_key: 'sales', handle: 'source' })
    expect(r.steps_total).toBe(4)
  })

  it('AC-T82-02 timeout e "outro" seguem os seus handles; handle sem aresta termina com no_next', async () => {
    expect(texts(await simulate(menuFlow(), { resume: { node_key: 'menu', handle: 'timeout' } }))).toEqual([
      'Você demorou',
    ])
    expect(
      texts(await simulate(menuFlow(), { resume: { node_key: 'menu', handle: 'other', text: 'quero falar' } })),
    ).toEqual(['Não entendi'])
    const none = await simulate(menuFlow(), { resume: { node_key: 'menu', handle: 'option:o2' } })
    expect(none).toMatchObject({
      status: 'finished',
      steps: [],
      end: { reason: 'no_next', node_key: 'menu', handle: 'option:o2' },
    })
  })

  it('AC-T82-02 aguarda resposta guarda o texto digitado em {response}', async () => {
    const flow = def(
      [
        node('start', 'start'),
        node('w', 'wait_response', [{ type: 'wait_for_response', config: { wait_indefinitely: true } }]),
        msg('echo', 'Você disse: {response}'),
      ],
      [edge('start', 'source', 'w'), edge('w', 'source', 'echo')],
    )
    const first = await simulate(flow)
    expect(first.wait).toMatchObject({
      node_key: 'w',
      kind: 'wait_response',
      choices: [{ handle: 'source', connected: true }],
    })
    const r = await simulate(flow, {
      resume: { node_key: 'w', handle: 'source', text: 'oi bot' },
      vars: first.vars,
      steps_so_far: first.steps_total,
    })
    expect(texts(r)).toEqual(['Você disse: oi bot'])
  })

  it('AC-T82-02 condição, distribuidor, IA e integração viram escolha (sucesso/falha, saídas)', async () => {
    const flow = def(
      [
        node('start', 'start'),
        node('cond', 'condition', [{ type: 'evaluate_condition', config: { ruleType: 'all', conditions: [] } }]),
        node('dist', 'distributor', [
          {
            type: 'distribute_contacts',
            config: {
              outputs: [
                { id: 'a', name: 'Equipe A' },
                { id: 'b', name: 'Equipe B' },
              ],
            },
          },
        ]),
        node('ai', 'ai', [
          {
            type: 'ai_call',
            config: {
              output_conditions: [{ output_key: 'compra', prompt: 'Quer comprar' }],
              fallback_output_key: 'outros',
            },
          },
        ]),
        node('http', 'integration', [
          { type: 'make_http_request', config: { request_method: 'GET', request_url: 'http://127.0.0.1:9/never' } },
        ]),
        msg('ok', 'ok'),
        msg('fail', 'falhou'),
      ],
      [
        edge('start', 'source', 'cond'),
        edge('cond', 'success', 'dist'),
        edge('cond', 'failure', 'fail'),
        edge('dist', 'output:b', 'ai'),
        edge('ai', 'output:compra', 'http'),
        edge('http', 'success', 'ok'),
        edge('http', 'failure', 'fail'),
      ],
    )
    const c = await simulate(flow)
    expect(c.wait).toMatchObject({
      node_key: 'cond',
      kind: 'condition_choice',
      choices: [{ handle: 'success' }, { handle: 'failure' }],
    })
    expect(texts(await simulate(flow, { resume: { node_key: 'cond', handle: 'failure' } }))).toEqual(['falhou'])

    const d = await simulate(flow, { resume: { node_key: 'cond', handle: 'success' } })
    expect(d.wait).toMatchObject({
      node_key: 'dist',
      kind: 'distributor',
      choices: [
        { handle: 'output:a', label: 'Equipe A', connected: false },
        { handle: 'output:b', label: 'Equipe B', connected: true },
      ],
    })

    const a = await simulate(flow, { resume: { node_key: 'dist', handle: 'output:b' } })
    expect(a.wait).toMatchObject({ node_key: 'ai', kind: 'ai_choice' })
    expect(a.wait!.choices.map((x) => [x.handle, x.label ?? null])).toEqual([
      ['output:compra', 'Quer comprar'],
      ['output:outros', null],
      ['failure', null],
    ])

    const h = await simulate(flow, { resume: { node_key: 'ai', handle: 'output:compra' } })
    expect(h.wait).toMatchObject({
      node_key: 'http',
      kind: 'integration_choice',
      choices: [{ handle: 'success' }, { handle: 'failure' }],
    })
    expect(texts(await simulate(flow, { resume: { node_key: 'http', handle: 'success' } }))).toEqual(['ok'])
  })

  it('handle que o nó não tem ou nó inexistente → SimulateError (422 na rota)', async () => {
    await expect(simulate(menuFlow(), { resume: { node_key: 'menu', handle: 'success' } })).rejects.toMatchObject({
      code: 'invalid_handle',
    })
    await expect(simulate(menuFlow(), { resume: { node_key: 'nope', handle: 'source' } })).rejects.toBeInstanceOf(
      SimulateError,
    )
  })

  it('AC-T82-03 loop sem espera é interrompido em 50 passos e marcado no resultado', async () => {
    const flow = def(
      [node('start', 'start'), msg('a', 'A'), msg('b', 'B')],
      [edge('start', 'source', 'a'), edge('a', 'source', 'b'), edge('b', 'source', 'a')],
    )
    const r = await simulate(flow)
    expect(r.status).toBe('finished')
    expect(r.interrupted).toBe('loop_guard')
    expect(r.steps).toHaveLength(50)
    expect(r.steps_total).toBe(50)
    expect(r.end).toEqual({ reason: 'loop_guard', node_key: 'b' })
  })

  it('AC-T82-03 o limite vale para o caminho inteiro (steps_so_far acumulado entre continuações)', async () => {
    const flow = def(
      [
        node('start', 'start'),
        node('w', 'wait_response', [{ type: 'wait_for_response', config: { wait_indefinitely: true } }]),
        msg('a', 'A'),
        msg('b', 'B'),
      ],
      [edge('start', 'source', 'w'), edge('w', 'source', 'a'), edge('a', 'source', 'b'), edge('b', 'source', 'a')],
    )
    const r = await simulate(flow, { resume: { node_key: 'w', handle: 'source' }, steps_so_far: 47 })
    expect(r.steps.map((s) => s.seq)).toEqual([48, 49, 50])
    expect(r).toMatchObject({
      interrupted: 'loop_guard',
      steps_total: 50,
      end: { reason: 'loop_guard', node_key: 'b' },
    })
    const over = await simulate(flow, { resume: { node_key: 'w', handle: 'source' }, steps_so_far: 50 })
    expect(over).toMatchObject({ steps: [], interrupted: 'loop_guard', end: { reason: 'loop_guard', node_key: 'a' } })
  })

  it('sem START → no_start (sem erro); fim sem próximo passo → no_next', async () => {
    expect(await simulate(def([msg('a', 'A')], [], 'start'))).toMatchObject({
      status: 'finished',
      steps: [],
      end: { reason: 'no_start' },
    })
    expect(await simulate(def([node('start', 'start')], []))).toMatchObject({
      end: { reason: 'no_next', node_key: 'start', handle: 'source' },
    })
  })

  it('nós de CRM, pixel e pagamento seguem com aviso "não simulado"; conexão de fluxo avisa o destino', async () => {
    const flow = def(
      [
        node('start', 'start'),
        node('tags', 'tags', [{ type: 'add_tags', config: { tags: ['vip'] } }]),
        node('pix', 'pixel'),
        node('pay', 'payment'),
        node('jump', 'connection_flow', [{ type: 'execute_flow', config: { target_flow_id: 'f-2' } }]),
      ],
      [
        edge('start', 'source', 'tags'),
        edge('tags', 'source', 'pix'),
        edge('pix', 'success', 'pay'),
        edge('pay', 'output:charge_created', 'jump'),
      ],
    )
    const r = await simulate(flow)
    expect(r.notices).toEqual([
      { code: 'not_simulated', seq: 2, node_key: 'tags', node_type: 'tags' },
      { code: 'not_simulated', seq: 3, node_key: 'pix', node_type: 'pixel' },
      { code: 'not_simulated', seq: 4, node_key: 'pay', node_type: 'payment' },
      { code: 'jump_flow', seq: 5, node_key: 'jump', target_flow_id: 'f-2' },
    ])
    expect(r.steps.map((s) => [s.node_key, s.status, s.handle ?? null])).toEqual([
      ['start', 'done', 'source'],
      ['tags', 'done', 'source'],
      ['pix', 'done', 'success'],
      ['pay', 'done', 'output:charge_created'],
      ['jump', 'done', null],
    ])
    expect(r.end).toEqual({ reason: 'jump_flow', node_key: 'jump' })
  })

  it('passThroughHandle prefere a saída ligada e nunca segue failure', () => {
    const flow = def([node('p', 'payment')], [edge('p', 'output:payment_approved', 'x'), edge('p', 'failure', 'y')])
    expect(passThroughHandle(flow.nodes[0]!, flow)).toBe('output:payment_approved')
    expect(passThroughHandle(node('t', 'tags'), def([], []))).toBe('source')
  })

  it('notificação vai para outro número (internal); intervalo inteligente vira "pular espera"', async () => {
    const flow = def(
      [
        node('start', 'start'),
        node('n', 'notification', [
          { type: 'send_notification', config: { phone: '11999990000', message: 'Novo lead' } },
        ]),
        node('si', 'smart_interval', [
          { type: 'smart_interval', config: { schedule_type: 'time', interval_value: 2, interval_unit: 'hours' } },
        ]),
        msg('after', 'depois'),
      ],
      [edge('start', 'source', 'n'), edge('n', 'source', 'si'), edge('si', 'source', 'after')],
    )
    const r = await simulate(flow)
    expect(r.messages).toEqual([{ seq: 2, node_key: 'n', to: 'internal', kind: 'text', text: 'Novo lead' }])
    expect(r.wait).toMatchObject({
      node_key: 'si',
      kind: 'smart_interval',
      choices: [{ handle: 'source', connected: true }],
    })
    expect(texts(await simulate(flow, { resume: { node_key: 'si', handle: 'source' } }))).toEqual(['depois'])
  })

  it('nenhuma chamada de rede: integração, IA e envios não tocam HTTP/fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const flow = def(
      [
        node('start', 'start'),
        msg('hi', 'oi'),
        node('http', 'integration', [
          {
            type: 'make_http_request',
            config: { request_method: 'POST', request_url: 'https://example.com/hook', request_body: '{"a":1}' },
          },
        ]),
        node('ai', 'ai', [{ type: 'ai_call', config: { user_message: 'oi' } }]),
      ],
      [edge('start', 'source', 'hi'), edge('hi', 'source', 'http'), edge('http', 'success', 'ai')],
    )
    await simulate(flow)
    const r = await simulate(flow, { resume: { node_key: 'http', handle: 'success' } })
    expect(r.wait).toMatchObject({ node_key: 'ai', kind: 'ai_choice' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
  })
})

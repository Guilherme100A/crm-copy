import { describe, expect, it } from 'vitest'
import {
  ACTION_CONFIG_SCHEMAS,
  ACTION_EXAMPLES,
  canActivate,
  FlowDefinitionSchema,
  getActionSchema,
  isWaitingHandle,
  migrate,
  NODE_ACTIONS,
  NODE_TYPES,
  nodeHandles,
  normalizeLegacyHandle,
  parseHandle,
  SUPPORTED_ACTION_TYPES,
  UNSUPPORTED_ACTION_TYPES,
  UNSUPPORTED_NODE_TYPES,
  validate,
  type FlowDefinition,
  type FlowEdge,
  type FlowNode,
} from './index'

const node = (id: string, type: string, actions: Array<[string, Record<string, unknown>]> = [], extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  actions: actions.map(([t, config], i) => ({ id: `${id}_${i}`, type: t, order: i, config })),
  ...extra,
})
const msg = (id: string) => node(id, 'message', [['send_message', { message_text: `oi ${id}` }]])
const edge = (from: string, handle: string, to: string): FlowEdge => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const flow = (nodes: FlowNode[], edges: FlowEdge[]): FlowDefinition => ({ schema: 'crm.flow/v1', entry: 'start', nodes, edges, variables: [], refs: {} })
const menu = (id: string, options: Array<{ id?: string; title: string }>, type = 'interactive_menu', action = 'send_interactive_menu') =>
  node(id, type, [[action, { menuType: 'list', message: 'Escolha', buttonLabel: 'Ver', options }]])
const sample = () =>
  flow(
    [node('start', 'start'), msg('m1'), menu('menu', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]), msg('ma'), msg('mb'), msg('mt')],
    [edge('start', 'source', 'm1'), edge('m1', 'source', 'menu'), edge('menu', 'option:a', 'ma'), edge('menu', 'option:b', 'mb'), edge('menu', 'timeout', 'mt')],
  )
const codes = (def: unknown) => validate(def).map((e) => `${e.code}@${e.nodeId}`)

describe('FlowDefinition', () => {
  it('fluxo de exemplo é válido e faz round-trip JSON idêntico', () => {
    const def = sample()
    expect(validate(def)).toEqual([])
    expect(canActivate(def)).toBe(true)
    const back = FlowDefinitionSchema.parse(JSON.parse(JSON.stringify(def)))
    expect(back).toStrictEqual(def)
  })

  it('estrutura inválida vira invalid_definition com o nodeId quando dá', () => {
    const def = sample() as unknown as { nodes: Array<Record<string, unknown>> }
    def.nodes[1]!.position = 'x'
    expect(validate(def)).toEqual([expect.objectContaining({ code: 'invalid_definition', nodeId: 'm1' })])
    expect(validate(null)[0]?.code).toBe('invalid_definition')
  })
})

describe('validate', () => {
  it('nenhum nó após o start', () => {
    expect(codes(flow([node('start', 'start')], []))).toEqual(['no_node_after_start@start'])
  })

  it('início ausente, duplicado ou com entrada', () => {
    expect(codes({ ...flow([msg('m1')], []), entry: 'm1' })).toEqual(['missing_start@null', 'entry_not_start@m1'])
    const def = sample()
    def.nodes.push(node('s2', 'start'))
    def.edges.push(edge('ma', 'source', 'start'))
    expect(codes(def)).toEqual(expect.arrayContaining(['multiple_start@s2', 'start_has_incoming@start']))
  })

  it('duas arestas no mesmo (nó, handle), handle inexistente e nó inexistente', () => {
    const def = sample()
    def.edges.push({ ...edge('m1', 'source', 'ma'), id: 'dup' }, edge('m1', 'option:zz', 'ma'), edge('m1', 'source', 'ghost'))
    expect(codes(def)).toEqual(expect.arrayContaining(['duplicate_edge_handle@m1', 'invalid_handle@m1', 'edge_unknown_node@m1']))
  })

  it('nós inalcançáveis', () => {
    const def = sample()
    def.nodes.push(msg('o1'), msg('o2'))
    def.edges.push(edge('o1', 'source', 'o2'))
    expect(codes(def)).toEqual(['unreachable_node@o1', 'unreachable_node@o2'])
  })

  it('ciclo sem espera é erro; com espera (menu, aguarda, intervalo) é aceito', () => {
    const bad = sample()
    bad.nodes.push(msg('c1'), msg('c2'))
    bad.edges.push(edge('ma', 'source', 'c1'), edge('c1', 'source', 'c2'), edge('c2', 'source', 'c1'))
    expect(codes(bad)).toEqual(['cycle_without_wait@c1', 'cycle_without_wait@c2'])

    const ok = sample()
    ok.edges.push(edge('ma', 'source', 'menu'))
    expect(validate(ok)).toEqual([])

    const interval = flow(
      [node('start', 'start'), msg('m1'), node('i', 'smart_interval', [['smart_interval', ACTION_EXAMPLES.smart_interval]])],
      [edge('start', 'source', 'm1'), edge('m1', 'source', 'i'), edge('i', 'source', 'm1')],
    )
    expect(validate(interval)).toEqual([])
  })

  it('fallback do carrossel não conta como espera', () => {
    const def = flow(
      [node('start', 'start'), msg('m1'), node('car', 'carousel', [['send_carousel', ACTION_EXAMPLES.send_carousel]])],
      [edge('start', 'source', 'm1'), edge('m1', 'source', 'car'), edge('car', 'other', 'm1')],
    )
    expect(codes(def)).toEqual(['cycle_without_wait@m1', 'cycle_without_wait@car'])
    def.edges[2] = edge('car', 'option:btn_basico', 'm1')
    expect(validate(def)).toEqual([])
  })

  it('autolaço sem espera', () => {
    const def = sample()
    def.edges.push(edge('ma', 'source', 'ma'))
    expect(codes(def)).toEqual(['cycle_without_wait@ma'])
  })

  it('config inválida, ação fora do nó, ação ausente e ação não suportada', () => {
    const def = sample()
    def.nodes[1]!.actions[0]!.config = { message_text: '' }
    def.nodes.push(node('t', 'tags', [['send_message', { message_text: 'x' }]]), node('k', 'message', [['kieai_generate', {}]]))
    def.edges.push(edge('ma', 'source', 't'), edge('mb', 'source', 'k'))
    const errors = validate(def)
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_action_config', nodeId: 'm1', actionId: 'm1_0', path: ['message_text'] }),
        expect.objectContaining({ code: 'action_not_allowed', nodeId: 't' }),
        expect.objectContaining({ code: 'missing_action', nodeId: 't' }),
        expect.objectContaining({ code: 'unsupported_action', nodeId: 'k' }),
      ]),
    )
  })

  it('nó unsupported (e o tipo cru) bloqueia a ativação', () => {
    for (const extra of [node('x', 'unsupported', [], { original_type: 'make_call' }), node('x', 'make_call')]) {
      const def = sample()
      def.nodes.push(extra)
      def.edges.push(edge('ma', 'source', 'x'))
      expect(codes(def)).toEqual(['unsupported_node@x'])
      expect(canActivate(def)).toBe(false)
    }
  })

  it('não altera a entrada', () => {
    const def = sample()
    def.nodes.push(msg('solto'))
    const before = JSON.stringify(def)
    validate(def)
    expect(JSON.stringify(def)).toBe(before)
  })
})

describe('handles', () => {
  it('parseHandle aceita só kind[:id] normalizado', () => {
    expect(parseHandle('option:a')).toEqual({ kind: 'option', id: 'a' })
    expect(parseHandle('source')).toEqual({ kind: 'source' })
    for (const bad of ['option', 'source:x', 'option-0', 'output:', 'menu-other']) expect(parseHandle(bad)).toBeNull()
  })

  it('handles por tipo de nó', () => {
    expect(nodeHandles(node('c', 'condition', [['evaluate_condition', ACTION_EXAMPLES.evaluate_condition]]))).toEqual(['success', 'failure'])
    expect(nodeHandles(node('d', 'distributor', [['distribute_contacts', ACTION_EXAMPLES.distribute_contacts]]))).toEqual(['output:output_1', 'output:output_2'])
    expect(nodeHandles(node('a', 'ai', [['ai_call', ACTION_EXAMPLES.ai_call]]))).toEqual(['output:compra', 'output:fallback', 'failure'])
    expect(nodeHandles(node('a', 'ai', [['ai_call', {}]]))).toEqual(['success', 'failure'])
    expect(nodeHandles(node('p', 'payment', [['create_payment_charge', ACTION_EXAMPLES.create_payment_charge]]))).toEqual([
      'output:charge_created',
      'output:payment_approved',
      'failure',
    ])
    expect(nodeHandles(node('w', 'wait_response', [['wait_for_response', { wait_indefinitely: true }]]))).toEqual(['source'])
    expect(nodeHandles(node('f', 'connection_flow', [['execute_flow', ACTION_EXAMPLES.execute_flow]]))).toEqual([])
  })

  it('reordenar opções não muda os handles do menu', () => {
    const a = menu('m', [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }])
    const b = menu('m', [{ id: 'y', title: 'Y' }, { id: 'x', title: 'X' }])
    expect(nodeHandles(a).sort()).toEqual(nodeHandles(b).sort())
  })

  it('handles de espera', () => {
    expect(isWaitingHandle('wait_response', 'source')).toBe(true)
    expect(isWaitingHandle('carousel', 'other')).toBe(false)
    expect(isWaitingHandle('payment', 'output:payment_approved')).toBe(true)
    expect(isWaitingHandle('payment', 'output:charge_created')).toBe(false)
    expect(isWaitingHandle('message', 'source')).toBe(false)
  })

  it('normalizeLegacyHandle', () => {
    expect(normalizeLegacyHandle('option-1', ['a', 'b'])).toBe('option:b')
    expect(normalizeLegacyHandle('menu-other')).toBe('other')
    expect(normalizeLegacyHandle('client-response')).toBe('source')
    expect(normalizeLegacyHandle('carousel-reply-btn1')).toBe('option:btn1')
    expect(normalizeLegacyHandle('output-output_1')).toBe('output:output_1')
    expect(normalizeLegacyHandle('error')).toBe('failure')
    expect(normalizeLegacyHandle('payment_approved')).toBe('output:payment_approved')
  })
})

describe('migrate', () => {
  const legacy = () =>
    flow(
      [node('start', 'start'), msg('m1'), menu('old', [{ title: 'A' }, { id: 'option_1', title: 'B' }], 'menu', 'send_option_list'), msg('a'), msg('b'), msg('o')],
      [edge('start', 'source', 'm1'), edge('m1', 'source', 'old'), edge('old', 'option-0', 'a'), edge('old', 'option-1', 'b'), edge('old', 'menu-other', 'o')],
    )

  it('menu legado vira interactive_menu com ids estáveis sem colisão', () => {
    const input = legacy()
    const before = JSON.stringify(input)
    const out = migrate(input)
    expect(JSON.stringify(input)).toBe(before)
    const old = out.nodes.find((n) => n.id === 'old')!
    expect(old.type).toBe('interactive_menu')
    expect(old.actions[0]!.type).toBe('send_interactive_menu')
    expect((old.actions[0]!.config.options as Array<{ id: string }>).map((o) => o.id)).toEqual(['option_1_2', 'option_1'])
    expect(out.edges.map((e) => e.handle)).toEqual(['source', 'source', 'option:option_1_2', 'option:option_1', 'other'])
    expect(validate(out)).toEqual([])
    expect(migrate(out)).toStrictEqual(out)
  })

  it('tipos fora de escopo e desconhecidos viram unsupported', () => {
    const out = migrate(flow([node('start', 'start'), node('k', 'kieai_integration'), node('z', 'foo')], []))
    expect(out.nodes.slice(1).map((n) => [n.type, n.original_type])).toEqual([
      ['unsupported', 'kieai_integration'],
      ['unsupported', 'foo'],
    ])
  })

  it('completa campos ausentes de definições antigas', () => {
    const out = migrate({ entry: 'start', nodes: [node('start', 'start')], edges: [] })
    expect(out).toMatchObject({ schema: 'crm.flow/v1', variables: [], refs: {} })
  })
})

describe('catálogo de ações', () => {
  it('todo action type suportado tem schema e exemplo válido, e cabe em algum nó', () => {
    expect(SUPPORTED_ACTION_TYPES).toHaveLength(31)
    const hosted = new Set(Object.values(NODE_ACTIONS).flat())
    for (const t of SUPPORTED_ACTION_TYPES) {
      expect(getActionSchema(t)).toBe(ACTION_CONFIG_SCHEMAS[t])
      const r = getActionSchema(t)!.safeParse(ACTION_EXAMPLES[t])
      expect(r.success, `${t}: ${JSON.stringify(r.error?.issues)}`).toBe(true)
      expect(hosted.has(t), t).toBe(true)
    }
  })

  it('fora de escopo não tem schema nem tipo de nó', () => {
    for (const t of UNSUPPORTED_ACTION_TYPES) expect(getActionSchema(t)).toBeUndefined()
    for (const t of UNSUPPORTED_NODE_TYPES) expect(NODE_TYPES as readonly string[]).not.toContain(t)
  })

  it('regras de domínio dos configs', () => {
    const bad: Array<[string, unknown]> = [
      ['delay_between_messages', { delay_min_seconds: 10, delay_max_seconds: 5 }],
      ['delay_between_messages', {}],
      ['wait_for_response', { timeout_value: 745, timeout_unit: 'hours' }],
      ['send_interactive_menu', { menuType: 'list', message: 'x', options: [{ id: 'a', title: 'A' }] }],
      ['send_interactive_menu', { menuType: 'button', message: 'x', options: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }],
      ['send_pix_button', { pix_key: 'nao-e-uuid', pix_type: 'EVP' }],
      ['send_pixel_event', { pixel_config_id: 'p', event_type: 'Compra' }],
      ['smart_interval', { schedule_type: 'weekly', weekly_schedule: { monday: { enabled: true, start_time: '18:00', end_time: '09:00' } } }],
      ['ai_call', { output_conditions: [{ prompt: 'x', output_key: 'k' }] }],
      ['create_payment_charge', { gateway: 'xpag', payment_integration_id: 'p', method: 'SPEI' }],
      ['send_carousel', { text: 'x', carousel: [{ text: 'sem imagem' }] }],
    ]
    for (const [t, config] of bad) expect(getActionSchema(t)!.safeParse(config).success, `${t} ${JSON.stringify(config)}`).toBe(false)
    expect(getActionSchema('create_payment_charge')!.safeParse({ gateway: 'xpag', payment_integration_id: 'p', method: 'SPEI', open_amount: true }).success).toBe(true)
    expect(getActionSchema('send_pix_button')!.safeParse({ pix_key: '{g_pix}', pix_type: 'EVP' }).success).toBe(true)
  })
})

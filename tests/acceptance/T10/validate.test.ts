// AC-T10-01 (erros do validate com nodeId) e AC-T10-02 (fluxo de exemplo válido + round-trip JSON).
import { beforeAll, describe, expect, it } from 'vitest'
import { clone, edge, flow, fmt, loadFlows, menuConfig, msg, node, sampleFlow, type FlowError } from './support'

let F: any
beforeAll(async () => {
  F = await loadFlows()
})

const errorsOf = (def: unknown): FlowError[] => {
  const out = F.validate(def)
  expect(Array.isArray(out), 'validate deve devolver um array').toBe(true)
  return out as FlowError[]
}

const hasError = (errors: FlowError[], code: string, nodeId?: string) =>
  errors.some((e) => e.code === code && (nodeId === undefined || e.nodeId === nodeId))

describe('AC-T10-02 fluxo de exemplo válido', () => {
  it('AC-T10-02 start → mensagem → menu → 2 opções + timeout passa sem erros', () => {
    const errors = errorsOf(sampleFlow())
    expect(errors, fmt(errors)).toEqual([])
    expect(F.canActivate(sampleFlow())).toBe(true)
  })

  it('AC-T10-02 FlowDefinitionSchema aceita o fluxo e o round-trip JSON é idêntico', () => {
    const def = sampleFlow()
    const parsed = F.FlowDefinitionSchema.parse(def)
    expect(parsed).toStrictEqual(def)
    const text = JSON.stringify(parsed)
    const back = F.FlowDefinitionSchema.parse(JSON.parse(text))
    expect(back).toStrictEqual(def)
    expect(JSON.parse(JSON.stringify(back))).toStrictEqual(JSON.parse(text))
    expect(errorsOf(JSON.parse(text))).toEqual([])
  })

  it('AC-T10-02 o fluxo de exemplo declara schema crm.flow/v1 e o schema recusa outra versão', () => {
    expect(F.FlowDefinitionSchema.safeParse(sampleFlow()).success).toBe(true)
    const wrong = { ...sampleFlow(), schema: 'crm.flow/v0' }
    expect(F.FlowDefinitionSchema.safeParse(wrong).success).toBe(false)
  })
})

describe('AC-T10-01 validate acusa erros com o nodeId', () => {
  it('AC-T10-01 nenhum nó após o start → no_node_after_start no nó start', () => {
    const errors = errorsOf(flow([node('start', 'start')], []))
    expect(hasError(errors, 'no_node_after_start', 'start'), fmt(errors)).toBe(true)
    expect(F.canActivate(flow([node('start', 'start')], []))).toBe(false)
  })

  it('AC-T10-01 dois edges no mesmo (nó, handle) → duplicate_edge_handle no nó de origem', () => {
    const def = sampleFlow()
    def.edges.push(edge('m1', 'source', 'ma', 'e_dup'))
    const errors = errorsOf(def)
    expect(hasError(errors, 'duplicate_edge_handle', 'm1'), fmt(errors)).toBe(true)
  })

  it('AC-T10-01 dois edges no mesmo handle de opção do menu → duplicate_edge_handle no menu', () => {
    const def = sampleFlow()
    def.edges.push(edge('menu', 'option:op_a', 'mb', 'e_dup_opt'))
    const errors = errorsOf(def)
    expect(hasError(errors, 'duplicate_edge_handle', 'menu'), fmt(errors)).toBe(true)
  })

  it('AC-T10-01 nó inalcançável → unreachable_node no nó solto', () => {
    const def = sampleFlow()
    def.nodes.push(msg('orphan'))
    const errors = errorsOf(def)
    expect(hasError(errors, 'unreachable_node', 'orphan'), fmt(errors)).toBe(true)
    expect(hasError(errors, 'unreachable_node', 'm1')).toBe(false)
  })

  it('AC-T10-01 nó só alcançável a partir de outro nó solto também é inalcançável', () => {
    const def = sampleFlow()
    def.nodes.push(msg('orphan1'), msg('orphan2'))
    def.edges.push(edge('orphan1', 'source', 'orphan2'))
    const errors = errorsOf(def)
    expect(hasError(errors, 'unreachable_node', 'orphan1'), fmt(errors)).toBe(true)
    expect(hasError(errors, 'unreachable_node', 'orphan2'), fmt(errors)).toBe(true)
  })

  it('AC-T10-01 ciclo sem nó de espera → cycle_without_wait em nó do ciclo', () => {
    // ma → c1 → c2 → c1 (só mensagens: laço infinito)
    const def = sampleFlow()
    def.nodes.push(msg('c1'), msg('c2'))
    def.edges.push(edge('ma', 'source', 'c1'), edge('c1', 'source', 'c2'), edge('c2', 'source', 'c1'))
    const errors = errorsOf(def)
    const cyc = errors.filter((e) => e.code === 'cycle_without_wait')
    expect(cyc.length, fmt(errors)).toBeGreaterThan(0)
    for (const e of cyc) expect(['c1', 'c2'], fmt(errors)).toContain(e.nodeId)
    expect(F.canActivate(def)).toBe(false)
  })

  it('AC-T10-01 ciclo que passa por espera (menu → mensagem → menu) é aceito', () => {
    const def = sampleFlow()
    def.edges.push(edge('ma', 'source', 'menu'))
    const errors = errorsOf(def)
    expect(hasError(errors, 'cycle_without_wait'), fmt(errors)).toBe(false)
    expect(errors, fmt(errors)).toEqual([])
  })

  it('AC-T10-01 ciclo que passa por Aguarda Resposta é aceito', () => {
    const def = flow(
      [
        node('start', 'start'),
        msg('m1'),
        node('w', 'wait_response', [['wait_for_response', { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'days' }]]),
        msg('m2'),
      ],
      [edge('start', 'source', 'm1'), edge('m1', 'source', 'w'), edge('w', 'source', 'm2'), edge('m2', 'source', 'w'), edge('w', 'timeout', 'm1')],
    )
    const errors = errorsOf(def)
    expect(errors, fmt(errors)).toEqual([])
  })

  it('AC-T10-01 config inválida da ação → invalid_action_config no nó da ação', () => {
    const def = sampleFlow()
    const m1 = def.nodes.find((n) => n.id === 'm1')!
    m1.actions[0]!.config = { message_text: 123 }
    const errors = errorsOf(def)
    expect(hasError(errors, 'invalid_action_config', 'm1'), fmt(errors)).toBe(true)
    const err = errors.find((e) => e.code === 'invalid_action_config')!
    expect(err.actionId).toBe('m1_a1')
  })

  it('AC-T10-01 config de menu sem opções → invalid_action_config no menu', () => {
    const def = sampleFlow()
    const menu = def.nodes.find((n) => n.id === 'menu')!
    menu.actions[0]!.config = { ...menuConfig([]) }
    // sem opções os handles option:* deixam de existir; o erro de config precisa aparecer no nó do menu
    const errors = errorsOf(def)
    expect(hasError(errors, 'invalid_action_config', 'menu'), fmt(errors)).toBe(true)
  })

  it('AC-T10-01 cada erro carrega code, message e nodeId (string ou null)', () => {
    const def = sampleFlow()
    def.nodes.push(msg('orphan'))
    def.nodes.find((n) => n.id === 'm1')!.actions[0]!.config = {}
    const errors = errorsOf(def)
    expect(errors.length).toBeGreaterThanOrEqual(2)
    for (const e of errors) {
      expect(typeof e.code).toBe('string')
      expect(typeof e.message).toBe('string')
      expect(e.nodeId === null || typeof e.nodeId === 'string').toBe(true)
    }
  })

  it('AC-T10-01 validate não altera o fluxo recebido', () => {
    const def = sampleFlow()
    def.nodes.push(msg('orphan'))
    const before = clone(def)
    errorsOf(def)
    expect(def).toStrictEqual(before)
  })
})

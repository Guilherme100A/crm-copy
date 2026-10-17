// Edições puras do assistente de fluxo (T93): aplicação em memória e comparação de erros novos (AC-T93-02).
import { describe, expect, it } from 'vitest'
import { FLOW_SCHEMA_VERSION, validate, type FlowDefinition } from '@crm/shared/flows'
import { applyFlowEdit, chunkCopilotText, FlowEditError, newValidationErrors } from './index'

const base = (): FlowDefinition => ({
  schema: FLOW_SCHEMA_VERSION,
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    {
      id: 'msg',
      type: 'message',
      name: 'Oi',
      position: { x: 300, y: 0 },
      actions: [{ id: 'a1', type: 'send_message', order: 0, config: { message_text: 'Olá' } }],
    },
  ],
  edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'msg' }],
  variables: [],
  refs: {},
})

describe('applyFlowEdit', () => {
  it('cria nó com ações e ligado à saída do pai, sem mudar a definição original', () => {
    const def = base()
    const r = applyFlowEdit(def, {
      op: 'create_node',
      type: 'message',
      name: 'Tchau',
      actions: [{ type: 'send_message', config: { message_text: 'Até' } }],
      connect_from: { node_id: 'msg', handle: 'source' },
    })
    expect(def.nodes).toHaveLength(2)
    const id = r.summary.node_id as string
    const node = r.definition.nodes.find((n) => n.id === id)!
    expect(node.position).toEqual({ x: 660, y: 0 })
    expect(r.definition.edges.find((e) => e.to === id)).toMatchObject({ from: 'msg', handle: 'source' })
    expect(validate(r.definition)).toEqual([])
  })

  it('recusa tipo de bloco inexistente, Início e nó de origem inexistente', () => {
    expect(() => applyFlowEdit(base(), { op: 'create_node', type: 'banana' })).toThrow(FlowEditError)
    expect(() => applyFlowEdit(base(), { op: 'create_node', type: 'start' })).toThrow(FlowEditError)
    expect(() =>
      applyFlowEdit(base(), { op: 'create_node', type: 'message', connect_from: { node_id: 'x', handle: 'source' } }),
    ).toThrow(/connect_from.node_id/)
  })

  it('edita a ação mesclando (ou substituindo) a config', () => {
    const merged = applyFlowEdit(base(), {
      op: 'update_action',
      node_id: 'msg',
      action_id: 'a1',
      config: { typing_delay_seconds: 2 },
    })
    expect(merged.definition.nodes[1]!.actions[0]!.config).toEqual({ message_text: 'Olá', typing_delay_seconds: 2 })
    const replaced = applyFlowEdit(base(), {
      op: 'update_action',
      node_id: 'msg',
      action_id: 'a1',
      config: { message_text: 'Novo' },
      replace: true,
    })
    expect(replaced.definition.nodes[1]!.actions[0]!.config).toEqual({ message_text: 'Novo' })
    expect(() => applyFlowEdit(base(), { op: 'update_action', node_id: 'msg', action_id: 'zz', config: {} })).toThrow(
      /action_id/,
    )
  })

  it('liga, troca o destino de uma saída já ligada e desliga', () => {
    let def = applyFlowEdit(base(), {
      op: 'create_node',
      type: 'message',
      actions: [{ type: 'send_message', config: { message_text: 'x' } }],
    }).definition
    const other = def.nodes[2]!.id
    const r = applyFlowEdit(def, { op: 'connect', from: 'start', handle: 'source', to: other })
    expect(r.summary.replaced_edge_id).toBe('e1')
    expect(r.definition.edges.filter((e) => e.from === 'start')).toHaveLength(1)
    def = applyFlowEdit(r.definition, { op: 'disconnect', from: 'start', handle: 'source' }).definition
    expect(def.edges).toHaveLength(0)
    expect(() => applyFlowEdit(base(), { op: 'connect', from: 'msg', handle: 'source', to: 'start' })).toThrow(/Início/)
    expect(() => applyFlowEdit(base(), { op: 'connect', from: 'msg', handle: 'not a handle', to: 'msg' })).toThrow(
      /handle/,
    )
  })

  it('remove nó e as conexões dele; o Início não pode ser removido', () => {
    const r = applyFlowEdit(base(), { op: 'delete_node', node_id: 'msg' })
    expect(r.definition.nodes.map((n) => n.id)).toEqual(['start'])
    expect(r.summary.removed_edge_ids).toEqual(['e1'])
    expect(() => applyFlowEdit(base(), { op: 'delete_node', node_id: 'start' })).toThrow(/Início/)
  })
})

describe('newValidationErrors', () => {
  it('AC-T93-02: só os erros criados pela edição contam (os antigos e os de rascunho em construção não)', () => {
    const broken = base()
    broken.nodes[1]!.actions[0]!.config = {}
    const before = validate(broken)
    expect(before.map((e) => e.code)).toEqual(['invalid_action_config'])

    // nó solto e sem ação: rascunho em construção, tolerado
    const loose = applyFlowEdit(broken, { op: 'create_node', type: 'message' }).definition
    expect(newValidationErrors(before, validate(loose))).toEqual([])

    // saída que o nó não tem: erro novo
    const bad = applyFlowEdit(broken, { op: 'connect', from: 'msg', handle: 'success', to: 'msg' }).definition
    expect(newValidationErrors(before, validate(bad)).map((e) => e.code)).toContain('invalid_handle')

    // config inválida numa ação nova: erro novo
    const badCfg = applyFlowEdit(base(), {
      op: 'create_node',
      type: 'message',
      actions: [{ type: 'send_message', config: { message_text: '' } }],
      connect_from: { node_id: 'msg', handle: 'source' },
    }).definition
    expect(newValidationErrors(validate(base()), validate(badCfg)).map((e) => e.code)).toEqual([
      'invalid_action_config',
    ])
  })
})

describe('chunkCopilotText', () => {
  it('quebra em pedaços que remontam o texto', () => {
    const text = 'palavra '.repeat(200).trim()
    const parts = chunkCopilotText(text)
    expect(parts.length).toBeLessThanOrEqual(21)
    expect(parts.join('')).toBe(text)
    expect(chunkCopilotText('')).toEqual([])
    expect(chunkCopilotText('curto')).toEqual(['curto'])
  })
})

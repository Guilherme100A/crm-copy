import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowDefinition } from '@crm/shared/flows'
import { HttpError } from '@/lib/http'
import { PALETTE_TYPES, searchBlocks } from '../palette/catalog'
import { getNodeEditor, registerNodeEditor } from '../node-editors/registry'
import { activationIssues } from './api'
import { Autosaver, type AutosaveStatus } from './autosave'
import { handleLabel } from './flow-node'
import {
  connect,
  copySelection,
  errorsByNode,
  isValidDefinition,
  metaOf,
  newId,
  outputHandles,
  parseClipboard,
  paste,
  removeNodes,
  toDefinition,
  toGraph,
  withErrors,
} from './model'
import { dispatchGraphUpdated, isForeign, onGraphUpdated } from './realtime'

afterEach(() => vi.useRealTimers())

const def = (): FlowDefinition => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    { id: 'm1', type: 'message', name: 'Oi', position: { x: 300, y: 10 }, actions: [{ id: 'a1', type: 'send_message', order: 0, config: { message_text: 'Olá' } }] },
    { id: 'c1', type: 'condition', name: 'Tem e-mail?', description: 'checa', position: { x: 600, y: 0 }, actions: [] },
  ],
  edges: [
    { id: 'e1', from: 'start', handle: 'source', to: 'm1' },
    { id: 'e2', from: 'm1', handle: 'source', to: 'c1' },
  ],
  variables: [],
  refs: {},
})

describe('modelo do canvas', () => {
  it('definição → grafo → definição é a identidade (sem estado de UI) e arredonda posições', () => {
    const g = toGraph(def())
    expect(g.nodes.find((n) => n.id === 'start')?.deletable).toBe(false)
    expect(g.edges[0]).toEqual({ id: 'e1', source: 'start', sourceHandle: 'source', target: 'm1' })
    const back = toDefinition({ nodes: g.nodes.map((n) => ({ ...n, selected: true, measured: { width: 1, height: 1 } })), edges: g.edges }, metaOf(def()))
    expect(back).toEqual(def())
    expect(isValidDefinition(back)).toBe(true)
    const moved = toDefinition({ nodes: [{ ...g.nodes[0]!, position: { x: 10.6, y: -3.2 } }, ...g.nodes.slice(1)], edges: g.edges }, metaOf(def()))
    expect(moved.nodes[0]!.position).toEqual({ x: 11, y: -3 })
  })

  it('ids do cliente aceitos pela API', () => {
    expect(newId('n')).toMatch(/^n_[a-z0-9]{10}$/)
    expect(newId('e')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('handles dinâmicos por tipo', () => {
    const g = toGraph(def())
    expect(outputHandles(g.nodes[1]!)).toEqual(['source'])
    expect(outputHandles(g.nodes[2]!)).toEqual(['success', 'failure'])
    const t = (k: string) => k
    expect(handleLabel('option:sim', t)).toBe('sim')
    expect(handleLabel('timeout', t)).toBe('handles.timeout')
  })

  it('ligar uma saída já ligada substitui a aresta anterior (AC-T45-02); recusa ligar ao Início ou a si mesmo', () => {
    const g = toGraph(def())
    const next = connect(g.edges, { source: 'm1', sourceHandle: 'source', target: 'start' }, 'start')
    expect(next).toBeNull()
    const replaced = connect(g.edges, { source: 'start', sourceHandle: 'source', target: 'c1' }, 'start', () => 'e9')!
    expect(replaced.map((e) => e.id)).toEqual(['e2', 'e9'])
    expect(replaced.find((e) => e.id === 'e9')).toMatchObject({ source: 'start', target: 'c1' })
    expect(connect(g.edges, { source: 'c1', sourceHandle: 'success', target: 'c1' }, 'start')).toBeNull()
    expect(connect(g.edges, { source: 'c1', sourceHandle: 'success', target: 'm1' }, 'start', () => 'e3')).toHaveLength(3)
  })

  it('excluir remove os nós e as arestas ligadas, nunca a entrada', () => {
    const g = removeNodes(toGraph(def()), new Set(['m1', 'start']), 'start')
    expect(g.nodes.map((n) => n.id)).toEqual(['start', 'c1'])
    expect(g.edges).toEqual([])
  })

  it('copiar/colar duplica com ids novos, +50/+50, arestas internas e seleção nos colados (AC-T45-03)', () => {
    const g = toGraph(def())
    expect(copySelection(g, new Set(['start']), 'start', 'f1')).toBeNull()
    const clip = copySelection(g, new Set(['start', 'm1', 'c1']), 'start', 'f1')!
    expect(clip.nodes.map((n) => n.id)).toEqual(['m1', 'c1'])
    expect(clip.edges).toEqual([{ from: 'm1', handle: 'source', to: 'c1' }])
    let i = 0
    const r = paste({ nodes: g.nodes.map((n) => ({ ...n, selected: n.id === 'm1' })), edges: g.edges }, clip, 50, (p) => `${p}_x${++i}`)
    expect(r.pasted).toHaveLength(2)
    const pasted = r.graph.nodes.filter((n) => r.pasted.includes(n.id))
    expect(pasted.map((n) => n.position)).toEqual([
      { x: 350, y: 60 },
      { x: 650, y: 50 },
    ])
    expect(pasted.every((n) => n.selected)).toBe(true)
    expect(r.graph.nodes.find((n) => n.id === 'm1')?.selected).toBe(false)
    expect(pasted[0]!.data.actions[0]!.id).not.toBe('a1')
    const newEdge = r.graph.edges.at(-1)!
    expect(newEdge.source).toBe(r.pasted[0])
    expect(newEdge.target).toBe(r.pasted[1])
    expect(parseClipboard(JSON.stringify(clip))).toEqual(clip)
    expect(parseClipboard('lixo')).toBeNull()
  })

  it('erros da ativação viram badge por nó (AC-T45-04)', () => {
    const errors = errorsByNode([
      { nodeId: 'm1', code: 'x', message: 'a' },
      { nodeId: 'm1', code: 'y', message: 'b' },
      { nodeId: null, code: 'z', message: 'fluxo' },
    ])
    expect(errors).toEqual({ m1: ['a', 'b'] })
    const nodes = withErrors(toGraph(def()).nodes, errors)
    expect(nodes.find((n) => n.id === 'm1')?.data.errors).toEqual(['a', 'b'])
    expect(withErrors(nodes, {}).every((n) => !n.data.errors)).toBe(true)
  })
})

describe('autosave', () => {
  it('debounce, um salvamento por vez, "Salvo às" e flush', async () => {
    vi.useFakeTimers()
    const states: AutosaveStatus[] = []
    let resolve!: () => void
    const save = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    const now = new Date(2026, 0, 1, 14, 5)
    const s = new Autosaver(save, (st) => states.push(st), 800, () => now)
    s.schedule()
    s.schedule()
    await vi.advanceTimersByTimeAsync(799)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(states.at(-1)?.state).toBe('saving')
    s.schedule() // mudança durante o envio
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.some((x) => x.state === 'saved' && x.savedAt === now)).toBe(true)
    const flushing = s.flush()
    await vi.advanceTimersByTimeAsync(0)
    resolve()
    await flushing
    expect(save).toHaveBeenCalledTimes(2)
    expect(s.pending).toBe(false)
  })

  it('falha marca erro e flush lança', async () => {
    const states: AutosaveStatus[] = []
    const s = new Autosaver(() => Promise.reject(new Error('x')), (st) => states.push(st), 10)
    s.schedule()
    await expect(s.flush()).rejects.toThrow()
    expect(states.at(-1)?.state).toBe('error')
  })
})

describe('paleta, registro, ativação e realtime', () => {
  it('busca por rótulo sem acento ou pelo tipo; Início fora da paleta', () => {
    const label = (t: string) => ({ condition: 'Condição', message: 'Mensagem' })[t] ?? t
    expect(PALETTE_TYPES).not.toContain('start')
    expect(searchBlocks(PALETTE_TYPES, 'condicao', label)).toEqual(['condition'])
    expect(searchBlocks(PALETTE_TYPES, 'wait', label)).toEqual(['wait_response'])
    expect(searchBlocks(PALETTE_TYPES, '', label)).toHaveLength(PALETTE_TYPES.length)
  })

  it('registro de editores de nó com fallback', () => {
    const Editor = () => null
    // `message` já vem registrado pelo glob dos grupos (T56); o teste usa um tipo livre.
    expect(getNodeEditor('x_test')).toBeNull()
    const off = registerNodeEditor('x_test', Editor)
    expect(getNodeEditor('x_test')).toBe(Editor)
    off()
    expect(getNodeEditor('x_test')).toBeNull()
  })

  it('422 da ativação traz os erros por nó', () => {
    const err = new HttpError(422, 'VALIDATION_ERROR', 'x', { errors: [{ nodeId: 'm1', code: 'missing_action', message: 'falta' }, { nodeId: null, code: 'missing_start', message: 'sem início' }] })
    expect(activationIssues(err)).toEqual([
      { nodeId: 'm1', code: 'missing_action', message: 'falta' },
      { nodeId: null, code: 'missing_start', message: 'sem início' },
    ])
    expect(activationIssues(new HttpError(500, 'INTERNAL', 'x'))).toBeNull()
  })

  it('flow.graph_updated chega só a quem ouve o fluxo; o próprio ator é ignorado', () => {
    const seen: string[] = []
    const off = onGraphUpdated('f1', (ev) => isForeign(ev, 'me') && seen.push(ev.mutation))
    dispatchGraphUpdated({ flow_id: 'f1', actor_id: 'outro', mutation: 'add_node' })
    dispatchGraphUpdated({ flow_id: 'f1', actor_id: 'me', mutation: 'replace_definition' })
    dispatchGraphUpdated({ flow_id: 'f2', actor_id: 'outro', mutation: 'x' })
    dispatchGraphUpdated({ flow_id: 'f1', actor_id: null, mutation: 'api' })
    off()
    dispatchGraphUpdated({ flow_id: 'f1', actor_id: 'outro', mutation: 'depois' })
    expect(seen).toEqual(['add_node', 'api'])
  })
})

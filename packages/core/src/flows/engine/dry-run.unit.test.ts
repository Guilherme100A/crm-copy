import { describe, expect, it } from 'vitest'
import type { FlowDefinition } from '@crm/shared'
import { idempotencyKey, stepKey, type NodeHandler } from './context'
import { dryRun } from './dry-run'
import { NODE_GROUPS } from '../nodes/index'
import { createNodeRegistry } from './registry'
import { LOOP_GUARD_ERROR } from './runner'

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const def = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]): FlowDefinition => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes,
  edges,
  variables: [],
  refs: {},
})

const say: NodeHandler = {
  async execute(ctx) {
    await ctx.wa.send({ sessionId: 's1', phone: '+5511999990000', content: { kind: 'text', text: ctx.render(`oi {first_name} ${ctx.node.id}`) } as never, actor: 'crm:test' }, { actionId: 'send' })
    return { next: 'source' }
  },
}

describe('dry-run (mesmo laço do motor, sem banco nem gateway real)', () => {
  it('percorre start → A → B, envia pelo gateway fake e termina completed', async () => {
    const registry = createNodeRegistry().register('message', say)
    const r = await dryRun({
      definition: def([node('start', 'start'), node('a', 'message'), node('b', 'message')], [edge('start', 'source', 'a'), edge('a', 'source', 'b')]),
      registry,
      contact: { full_name: 'Ana Souza' },
    })
    expect(r.status).toBe('completed')
    expect(r.steps.map((s) => [s.node_key, s.status, s.handle])).toEqual([
      ['start', 'done', 'source'],
      ['a', 'done', 'source'],
      ['b', 'done', 'source'],
    ])
    expect(r.sent.map((m) => (m.content as { text: string }).text)).toEqual(['oi Ana a', 'oi Ana b'])
  })

  it('ciclo sem espera para em 50 nós com loop_guard', async () => {
    const registry = createNodeRegistry().register('message', { execute: () => ({ next: 'source' }) })
    const r = await dryRun({ definition: def([node('start', 'start'), node('a', 'message'), node('b', 'message')], [edge('start', 'source', 'a'), edge('a', 'source', 'b'), edge('b', 'source', 'a')]), registry })
    expect(r.status).toBe('failed')
    expect(r.error).toBe(LOOP_GUARD_ERROR)
    expect(r.steps).toHaveLength(50)
  })

  it('erro segue failure se existir; sem failure o run falha com a mensagem', async () => {
    const boom: NodeHandler = { execute: () => Promise.reject(new Error('http 500')) }
    const registry = createNodeRegistry().register('integration', boom).register('message', { execute: () => ({ end: true }) })
    const withFailure = await dryRun({
      definition: def([node('start', 'start'), node('i', 'integration'), node('f', 'message')], [edge('start', 'source', 'i'), edge('i', 'failure', 'f')]),
      registry,
    })
    expect(withFailure.status).toBe('completed')
    expect(withFailure.steps.map((s) => [s.node_key, s.status, s.handle ?? null, s.error])).toEqual([
      ['start', 'done', 'source', null],
      ['i', 'failed', 'failure', 'http 500'],
      ['f', 'done', null, null],
    ])
    const without = await dryRun({ definition: def([node('start', 'start'), node('i', 'integration')], [edge('start', 'source', 'i')]), registry })
    expect([without.status, without.error]).toEqual(['failed', 'http 500'])
  })

  it('stubs dos grupos lançam node_not_implemented; tipo sem handler idem', async () => {
    const r = await dryRun({ definition: def([node('start', 'start'), node('t', 'pixel')], [edge('start', 'source', 't')]) })
    expect([r.status, r.error]).toEqual(['failed', 'node_not_implemented:pixel'])
    const reg = createNodeRegistry()
    for (const g of Object.values(NODE_GROUPS)) for (const t of g.types) expect(reg.has(t), t).toBe(true)
    const unknown = await dryRun({ definition: def([node('start', 'start'), node('x', 'nao_existe')], [edge('start', 'source', 'x')]) })
    expect(unknown.error).toBe('node_not_implemented:nao_existe')
  })

  it('wait para o run em waiting com o estado da espera; jump vai para outro nó; vars persistem', async () => {
    const registry = createNodeRegistry()
      .register('message', { execute: (ctx) => (ctx.setVar('visto', ctx.node.id), { jump: { nodeKey: 'w' } }) })
      .register('wait_response', { execute: () => ({ wait: { kind: 'reply', handles: ['source', 'timeout'] } }) })
    const r = await dryRun({ definition: def([node('start', 'start'), node('m', 'message'), node('w', 'wait_response')], [edge('start', 'source', 'm')]), registry })
    expect(r.status).toBe('waiting')
    expect(r.wait).toEqual({ kind: 'reply', handles: ['source', 'timeout'] })
    expect(r.vars).toEqual({ visto: 'm' })
    expect(r.steps.map((s) => s.node_key)).toEqual(['start', 'm', 'w'])
  })

  it('resultado inválido do handler conta como erro do nó', async () => {
    const registry = createNodeRegistry().register('message', { execute: () => ({ foo: 1 }) as never })
    const r = await dryRun({ definition: def([node('start', 'start'), node('m', 'message')], [edge('start', 'source', 'm')]), registry })
    expect(r.status).toBe('failed')
    expect(r.error).toContain('resultado inválido')
  })
})

describe('chaves de idempotência', () => {
  it('estáveis por (run, seq, ação) e distintas da chave do nó', () => {
    expect(idempotencyKey('r', 1, 'a')).toBe(idempotencyKey('r', 1, 'a'))
    expect(idempotencyKey('r', 1, 'a')).not.toBe(idempotencyKey('r', 2, 'a'))
    expect(idempotencyKey('r', 1, 'a')).toMatch(/^[0-9a-f]{64}$/)
    expect(stepKey('r', 1)).not.toBe(idempotencyKey('r', 1, 'a'))
  })
})

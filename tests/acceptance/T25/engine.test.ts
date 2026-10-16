// AC-T25-01..06: runner do motor de fluxos (handlers de teste, loop_guard, concorrência, idempotência, failure, dry-run).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SESSION_ID,
  counts,
  definition,
  edge,
  loadWorker,
  newCompany,
  newContact,
  newGateway,
  node,
  nodeSteps,
  passThrough,
  publishedFlow,
  runRow,
  sleep,
  startEnv,
  type Env,
} from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

/** Fluxo publicado + contato + engine com registry próprio. */
async function setup(def: any, register: (registry: any) => void, opts: { wa?: any; hooks?: any } = {}) {
  const companyId = await newCompany(env)
  const contact = await newContact(env, companyId)
  const flowId = await publishedFlow(env, companyId, def)
  const registry = env.core.createNodeRegistry()
  register(registry)
  const wa = opts.wa ?? newGateway()
  const engine = new env.core.FlowEngine({ db: env.db, wa, registry, hooks: opts.hooks })
  const { runId, expectedSeq } = await engine.startRun({ companyId }, { flowId, contactId: contact.id })
  expect(typeof runId).toBe('string')
  expect(expectedSeq).toBe(0)
  return { companyId, contact, flowId, registry, wa, engine, runId }
}

const linear = () => definition([node('A'), node('B')], [edge('start', 'source', 'A'), edge('A', 'source', 'B')])

describe('AC-T25-01 percurso simples', () => {
  it('AC-T25-01 start → A → B → fim: um flow_run_steps por nó e run completed', async () => {
    const visited: string[] = []
    const s = await setup(linear(), (r) => r.register('message', passThrough(visited)))
    const res = await s.engine.step(s.runId, 0)
    expect(res.executed, JSON.stringify(res)).toBe(true)
    expect(res.status).toBe('completed')
    expect(visited).toEqual(['A', 'B'])
    expect((await runRow(env, s.runId)).status).toBe('completed')
    const steps = await nodeSteps(env, s.runId)
    expect(steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'B'])
    expect(new Set(steps.map((x: any) => x.seq)).size).toBe(3)
    for (const st of steps) expect(st.status).toBe('done')
  })

  it('AC-T25-01 o job flow-step (processor do worker) executa o mesmo percurso', async () => {
    const { createFlowStepProcessor } = await loadWorker()
    const visited: string[] = []
    const s = await setup(linear(), (r) => r.register('message', passThrough(visited)))
    const processor = createFlowStepProcessor({ engine: s.engine })
    await processor({ data: { runId: s.runId, expectedSeq: 0 } })
    expect(visited).toEqual(['A', 'B'])
    expect((await runRow(env, s.runId)).status).toBe('completed')
    expect((await nodeSteps(env, s.runId)).map((x: any) => x.node_key)).toEqual(['start', 'A', 'B'])
  })

  it('AC-T25-01 handler que devolve { end } termina o run completed sem seguir arestas', async () => {
    const visited: string[] = []
    const s = await setup(linear(), (r) =>
      r.register('message', {
        async execute(ctx: any) {
          visited.push(ctx.node.id)
          return { end: true }
        },
      }),
    )
    await s.engine.step(s.runId, 0)
    expect(visited).toEqual(['A'])
    expect((await runRow(env, s.runId)).status).toBe('completed')
    expect((await nodeSteps(env, s.runId)).map((x: any) => x.node_key)).toEqual(['start', 'A'])
  })
})

describe('AC-T25-02 loop_guard', () => {
  it('AC-T25-02 ciclo sem espera termina failed com loop_guard após 50 passos', async () => {
    const visited: string[] = []
    const def = definition([node('A'), node('B')], [edge('start', 'source', 'A'), edge('A', 'source', 'B'), edge('B', 'source', 'A')])
    const s = await setup(def, (r) => r.register('message', passThrough(visited)))
    const res = await s.engine.step(s.runId, 0)
    expect(res.status).toBe('failed')
    const run = await runRow(env, s.runId)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('loop_guard')
    const steps = await nodeSteps(env, s.runId)
    expect(steps.length, `passos gravados: ${steps.length}`).toBeGreaterThanOrEqual(50)
    expect(steps.length).toBeLessThanOrEqual(51)
    expect(visited.length).toBeGreaterThanOrEqual(49)
    expect(visited.length).toBeLessThanOrEqual(50)
  })

  it('AC-T25-02 percurso longo sem ciclo, abaixo de 50 passos, não dispara o loop_guard', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `N${i}`)
    const edges = [edge('start', 'source', 'N0'), ...ids.slice(1).map((id, i) => edge(ids[i]!, 'source', id))]
    const s = await setup(definition(ids.map((id) => node(id)), edges), (r) => r.register('message', passThrough([])))
    await s.engine.step(s.runId, 0)
    const run = await runRow(env, s.runId)
    expect(run.status, run.error).toBe('completed')
  })
})

describe('AC-T25-03 concorrência', () => {
  it('AC-T25-03 dois workers com o mesmo { runId, expectedSeq } executam o passo uma vez', async () => {
    const { createFlowStepProcessor } = await loadWorker()
    let calls = 0
    const s = await setup(linear(), (r) =>
      r.register('message', {
        async execute(ctx: any) {
          if (ctx.node.id === 'A') calls++
          await sleep(300)
          return { next: 'source' }
        },
      }),
    )
    const w1 = createFlowStepProcessor({ engine: s.engine })
    const engine2 = new env.core.FlowEngine({ db: env.db, wa: s.wa, registry: s.registry })
    const w2 = createFlowStepProcessor({ engine: engine2 })
    const results = await Promise.allSettled([w1({ data: { runId: s.runId, expectedSeq: 0 } }), w2({ data: { runId: s.runId, expectedSeq: 0 } })])
    for (const r of results) expect(r.status, String((r as any).reason)).toBe('fulfilled')
    expect(calls).toBe(1)
    const steps = await nodeSteps(env, s.runId)
    expect(steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'B'])
    expect((await runRow(env, s.runId)).status).toBe('completed')
  })

  it('AC-T25-03 o segundo step com seq antigo é no-op (stale)', async () => {
    const visited: string[] = []
    const s = await setup(linear(), (r) => r.register('message', passThrough(visited)))
    const [a, b] = await Promise.all([s.engine.step(s.runId, 0), s.engine.step(s.runId, 0)])
    const noop = [a, b].filter((x: any) => x.executed === false)
    expect(noop, JSON.stringify([a, b])).toHaveLength(1)
    expect(['stale', 'not_running']).toContain(noop[0].reason)
    expect(visited).toEqual(['A', 'B'])
    const again = await s.engine.step(s.runId, 0)
    expect(again.executed).toBe(false)
  })
})

describe('AC-T25-04 idempotência de envio', () => {
  const sender = (counter: { calls: number }, actionId = 'a1') => ({
    async execute(ctx: any) {
      if (ctx.node.id === 'A') {
        counter.calls++
        await ctx.wa.send(
          { sessionId: SESSION_ID, phone: ctx.contact?.phone_e164 ?? ctx.contact?.phoneE164 ?? '+5599900000001', content: { text: 'oi do fluxo' }, actor: 'crm:flow', contactId: ctx.contactId },
          { actionId },
        )
      }
      return { next: 'source' }
    },
  })

  it('AC-T25-04 reprocessar o mesmo job após crash não repete o wa.send (mesma idempotency_key)', async () => {
    const counter = { calls: 0 }
    let crashed = false
    const hooks = {
      afterNode: (info: any) => {
        const key = info?.node?.id ?? info?.nodeKey ?? info?.node_key ?? info?.node
        if (!crashed && key === 'A') {
          crashed = true
          throw new Error('crash simulado')
        }
      },
    }
    const s = await setup(linear(), (r) => r.register('message', sender(counter)), { hooks })
    await expect(s.engine.step(s.runId, 0)).rejects.toThrow()
    expect(crashed).toBe(true)
    expect(s.wa.sent).toHaveLength(1)
    const mid = await runRow(env, s.runId)
    expect(mid.status).toBe('running')
    expect(mid.seq).toBe(0)

    const res = await s.engine.step(s.runId, 0)
    expect(res.executed, JSON.stringify(res)).toBe(true)
    expect(counter.calls, 'o nó deveria ter sido reexecutado').toBe(2)
    expect(s.wa.sent, 'wa.send repetido no retry').toHaveLength(1)
    expect((await runRow(env, s.runId)).status).toBe('completed')
    const actionRows = await env.q(`SELECT idempotency_key FROM crm.flow_run_steps WHERE run_id = $1 AND action_key = 'a1'`, [s.runId])
    expect(actionRows).toHaveLength(1)
  })

  it('AC-T25-04 retry via processor do worker também não reenvia', async () => {
    const { createFlowStepProcessor } = await loadWorker()
    const counter = { calls: 0 }
    let crashed = false
    const hooks = {
      afterNode: (info: any) => {
        const key = info?.node?.id ?? info?.nodeKey ?? info?.node_key ?? info?.node
        if (!crashed && key === 'A') {
          crashed = true
          throw new Error('crash simulado')
        }
      },
    }
    const s = await setup(linear(), (r) => r.register('message', sender(counter)), { hooks })
    const processor = createFlowStepProcessor({ engine: s.engine })
    await expect(processor({ data: { runId: s.runId, expectedSeq: 0 } })).rejects.toThrow()
    await processor({ data: { runId: s.runId, expectedSeq: 0 } })
    expect(s.wa.sent).toHaveLength(1)
    expect((await runRow(env, s.runId)).status).toBe('completed')
  })

  it('AC-T25-04 runs diferentes geram idempotency_key diferentes (cada um envia)', async () => {
    const counter = { calls: 0 }
    const wa = newGateway()
    const s1 = await setup(linear(), (r) => r.register('message', sender(counter)), { wa })
    const s2 = await setup(linear(), (r) => r.register('message', sender(counter)), { wa })
    await s1.engine.step(s1.runId, 0)
    await s2.engine.step(s2.runId, 0)
    expect(wa.sent).toHaveLength(2)
    const keys = await env.q(`SELECT idempotency_key FROM crm.flow_run_steps WHERE run_id = ANY($1) AND action_key = 'a1'`, [[s1.runId, s2.runId]])
    expect(new Set(keys.map((k: any) => k.idempotency_key)).size).toBe(2)
  })
})

describe('AC-T25-05 erro em ação', () => {
  const boom = (visited: string[]) => ({
    async execute(ctx: any) {
      visited.push(ctx.node.id)
      throw new Error('falha-da-acao-T25')
    },
  })

  it('AC-T25-05 ação que lança segue o handle failure quando ele existe', async () => {
    const visited: string[] = []
    const def = definition(
      [node('A', 'integration'), node('OK'), node('ERR')],
      [edge('start', 'source', 'A'), edge('A', 'success', 'OK'), edge('A', 'failure', 'ERR')],
    )
    const s = await setup(def, (r) => {
      r.register('integration', boom(visited))
      r.register('message', passThrough(visited))
    })
    await s.engine.step(s.runId, 0)
    expect(visited).toEqual(['A', 'ERR'])
    const run = await runRow(env, s.runId)
    expect(run.status, run.error).toBe('completed')
    const steps = await nodeSteps(env, s.runId)
    expect(steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'ERR'])
    const a = steps.find((x: any) => x.node_key === 'A')
    expect(a.status).toBe('failed')
    expect(String(a.error)).toContain('falha-da-acao-T25')
  })

  it('AC-T25-05 sem handle failure o run fica failed com o erro gravado', async () => {
    const visited: string[] = []
    const def = definition([node('A', 'integration'), node('OK')], [edge('start', 'source', 'A'), edge('A', 'success', 'OK')])
    const s = await setup(def, (r) => {
      r.register('integration', boom(visited))
      r.register('message', passThrough(visited))
    })
    const res = await s.engine.step(s.runId, 0)
    expect(res.status).toBe('failed')
    expect(visited).toEqual(['A'])
    const run = await runRow(env, s.runId)
    expect(run.status).toBe('failed')
    expect(String(run.error)).toContain('falha-da-acao-T25')
  })

  it('AC-T25-05 nó sem handler implementado (stub) também segue failure ou falha o run', async () => {
    const def = definition([node('T', 'tags')], [edge('start', 'source', 'T')])
    const s = await setup(def, () => {})
    await s.engine.step(s.runId, 0)
    const run = await runRow(env, s.runId)
    expect(run.status).toBe('failed')
    expect(String(run.error)).toContain('node_not_implemented')
  })
})

describe('AC-T25-06 dry-run', () => {
  const sendingRegistry = () => {
    const registry = env.core.createNodeRegistry()
    registry.register('message', {
      async execute(ctx: any) {
        await ctx.wa.send({ sessionId: SESSION_ID, phone: '+5599900000001', content: { text: `dry ${ctx.node.id}` }, actor: 'crm:flow' }, { actionId: `${ctx.node.id}-send` })
        return { next: 'source' }
      },
    })
    return registry
  }

  it('AC-T25-06 dryRun executa o mesmo grafo sem gravar no banco e sem gateway real', async () => {
    const before = await counts(env)
    const res = await env.core.dryRun({ definition: linear(), registry: sendingRegistry() })
    expect(res.status, JSON.stringify(res)).toBe('completed')
    expect(res.steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'B'])
    expect(res.sent.map((m: any) => m.content?.text)).toEqual(['dry A', 'dry B'])
    expect(await counts(env)).toEqual(before)
  })

  it('AC-T25-06 dryRun reproduz loop_guard e failure como o runner real', async () => {
    const reg = env.core.createNodeRegistry()
    reg.register('message', { execute: async () => ({ next: 'source' }) })
    const loop = await env.core.dryRun({
      definition: definition([node('A'), node('B')], [edge('start', 'source', 'A'), edge('A', 'source', 'B'), edge('B', 'source', 'A')]),
      registry: reg,
    })
    expect(loop.status).toBe('failed')
    expect(String(loop.error)).toContain('loop_guard')

    reg.register('integration', {
      execute: async () => {
        throw new Error('erro-dry')
      },
    })
    const fail = await env.core.dryRun({
      definition: definition([node('A', 'integration'), node('ERR')], [edge('start', 'source', 'A'), edge('A', 'failure', 'ERR')]),
      registry: reg,
    })
    expect(fail.status).toBe('completed')
    expect(fail.steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'ERR'])
  })

  it('AC-T25-06 engine.dryRun de um fluxo salvo não grava nada nem toca o gateway do engine', async () => {
    const companyId = await newCompany(env)
    const flowId = await publishedFlow(env, companyId, linear())
    const spy = newGateway()
    const engine = new env.core.FlowEngine({ db: env.db, wa: spy, registry: sendingRegistry() })
    const before = await counts(env)
    const res = await engine.dryRun({ companyId }, { flowId, registry: sendingRegistry() })
    expect(res.status, JSON.stringify(res)).toBe('completed')
    expect(res.steps.map((x: any) => x.node_key)).toEqual(['start', 'A', 'B'])
    expect(res.sent).toHaveLength(2)
    expect(spy.sent, 'o gateway do engine foi usado no dry-run').toHaveLength(0)
    expect(await counts(env)).toEqual(before)
  })
})

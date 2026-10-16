// AC-T19-01 e AC-T19-02: restrições no banco (SQL direto nas tabelas crm.*), mais a mesma regra pelo repositório.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lit, sql, sqlOk, sqlState } from '../helpers/pg'
import { caught, ctxOf, flowStore, migratedCrmDb, newCompany, sampleDefinition, type CrmDb } from './support'

let pg: CrmDb
let store: any
let companyA: string
let companyB: string

beforeAll(async () => {
  pg = await migratedCrmDb()
  ;({ store } = await flowStore(pg.db))
  companyA = newCompany(pg.tmp.url)
  companyB = newCompany(pg.tmp.url)
})

afterAll(async () => {
  await pg?.close()
})

const node = (companyId: string, flowId: string, key: string) =>
  sqlOk(
    pg.tmp.url,
    `INSERT INTO crm.flow_nodes (company_id, flow_id, key, type, name, position_x, position_y)
     VALUES (${lit(companyId)}, ${lit(flowId)}, ${lit(key)}, 'message', ${lit(key)}, 0, 0) RETURNING id;`,
  )[0]![0]!

const edge = (companyId: string, flowId: string, from: string, handle: string, to: string, key = randomUUID()) =>
  sql(
    pg.tmp.url,
    `INSERT INTO crm.flow_edges (company_id, flow_id, key, from_node_id, to_node_id, handle)
     VALUES (${lit(companyId)}, ${lit(flowId)}, ${lit(key)}, ${lit(from)}, ${lit(to)}, ${lit(handle)});`,
  )

describe('T19 — flow_edges (AC-T19-01)', () => {
  it('AC-T19-01 dois edges com o mesmo (nó de origem, handle) → violação de unicidade', async () => {
    const flow = await store.createFlow(ctxOf(companyA), { name: 'Arestas' })
    const n1 = node(companyA, flow.id, 'n1')
    const n2 = node(companyA, flow.id, 'n2')
    const n3 = node(companyA, flow.id, 'n3')
    const first = edge(companyA, flow.id, n1, 'source', n2)
    expect(first.code, first.stderr).toBe(0)
    const dup = edge(companyA, flow.id, n1, 'source', n3)
    expect(dup.code, 'segundo edge (n1, source) aceito').not.toBe(0)
    expect(sqlState(dup), dup.stderr).toBe('23505')
  })

  it('AC-T19-01 handles diferentes do mesmo nó e o mesmo handle em nós diferentes são aceitos', async () => {
    const flow = await store.createFlow(ctxOf(companyA), { name: 'Arestas 2' })
    const n1 = node(companyA, flow.id, 'n1')
    const n2 = node(companyA, flow.id, 'n2')
    const n3 = node(companyA, flow.id, 'n3')
    for (const r of [
      edge(companyA, flow.id, n1, 'option:option_1', n2),
      edge(companyA, flow.id, n1, 'option:option_2', n3),
      edge(companyA, flow.id, n1, 'timeout', n3),
      edge(companyA, flow.id, n2, 'source', n3),
      edge(companyA, flow.id, n3, 'source', n2),
    ])
      expect(r.code, r.stderr).toBe(0)
  })

  it('AC-T19-01 fromDefinition com dois edges no mesmo (origem, handle) é rejeitado e não altera o rascunho', async () => {
    const ctx = ctxOf(companyA)
    const flow = await store.createFlow(ctx, { name: 'Def duplicada' })
    const ok = await sampleDefinition()
    await store.fromDefinition(ctx, flow.id, ok)
    const bad = await sampleDefinition()
    bad.edges.push({ id: 'e-dup', from: 'start', handle: 'source', to: 'menu1' })
    const err = await caught(store.fromDefinition(ctx, flow.id, bad))
    expect(err, 'definição com edge duplicado aceita').toBeDefined()
    const after = await store.toDefinition(ctx, flow.id)
    expect(after.edges).toHaveLength(ok.edges.length)
  })
})

describe('T19 — flow_runs ativos por contato (AC-T19-02)', () => {
  const run = (companyId: string, flowId: string, contactId: string, status: string) =>
    sql(
      pg.tmp.url,
      `INSERT INTO crm.flow_runs (company_id, flow_id, contact_id, status)
       VALUES (${lit(companyId)}, ${lit(flowId)}, ${lit(contactId)}, ${lit(status)}) RETURNING id;`,
    )

  it('AC-T19-02 segundo run running|waiting do mesmo contato na mesma empresa é rejeitado pelo banco', async () => {
    const flow = await store.createFlow(ctxOf(companyA), { name: 'Runs' })
    const flow2 = await store.createFlow(ctxOf(companyA), { name: 'Runs 2' })
    const contact = randomUUID()
    const first = run(companyA, flow.id, contact, 'running')
    expect(first.code, first.stderr).toBe(0)
    for (const [f, status] of [
      [flow.id, 'running'],
      [flow.id, 'waiting'],
      [flow2.id, 'running'],
      [flow2.id, 'waiting'],
    ] as const) {
      const r = run(companyA, f, contact, status)
      expect(r.code, `segundo run ${status} aceito`).not.toBe(0)
      expect(sqlState(r), r.stderr).toBe('23505')
    }
  })

  it('AC-T19-02 o mesmo contato em empresas diferentes pode ter um run ativo em cada', async () => {
    const fa = await store.createFlow(ctxOf(companyA), { name: 'A' })
    const fb = await store.createFlow(ctxOf(companyB), { name: 'B' })
    const contact = randomUUID()
    expect(run(companyA, fa.id, contact, 'waiting').code).toBe(0)
    const other = run(companyB, fb.id, contact, 'running')
    expect(other.code, other.stderr).toBe(0)
  })

  it('AC-T19-02 o índice é parcial: runs encerrados não bloqueiam um novo run ativo', async () => {
    const flow = await store.createFlow(ctxOf(companyA), { name: 'Encerrados' })
    const contact = randomUUID()
    for (const s of ['completed', 'failed', 'cancelled', 'completed']) expect(run(companyA, flow.id, contact, s).code).toBe(0)
    const active = run(companyA, flow.id, contact, 'running')
    expect(active.code, active.stderr).toBe(0)
    // ao encerrar o ativo, outro pode começar
    sqlOk(pg.tmp.url, `UPDATE crm.flow_runs SET status = 'completed' WHERE id = ${lit(active.rows[0]![0]!)};`)
    expect(run(companyA, flow.id, contact, 'waiting').code).toBe(0)
  })

  it('AC-T19-02 contatos diferentes na mesma empresa têm runs ativos independentes', async () => {
    const flow = await store.createFlow(ctxOf(companyA), { name: 'Vários contatos' })
    for (let i = 0; i < 3; i++) expect(run(companyA, flow.id, randomUUID(), 'running').code).toBe(0)
  })
})

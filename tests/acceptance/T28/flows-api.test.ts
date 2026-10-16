// AC-T28-01..06: ativação, upsert de conexão + evento, pastas, impacto de exclusão, permissões e duplicação.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { envelopeOf } from '../helpers/sse'
import {
  bundle,
  createFlow,
  def,
  edge,
  msgNode,
  newContact,
  newMember,
  newOwner,
  openEvents,
  putDefinition,
  startEnv,
  validDef,
  type Env,
  type User,
} from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const versions = async (flowId: string) => Number((await env.q(`SELECT count(*)::int AS n FROM crm.flow_versions WHERE flow_id = $1`, [flowId]))[0].n)

describe('AC-T28-01 ativação', () => {
  it('AC-T28-01 activate com definição inválida → 422 com a lista de erros por nó; nada é publicado', async () => {
    const flow = await createFlow(owner)
    const d = validDef()
    d.nodes.push(msgNode('orfao', 3))
    d.nodes.find((n: any) => n.id === 'm2')!.actions[0]!.config = { message_text: '' }
    await putDefinition(owner, flow.id, d)
    const res = await owner.c.post(`/api/flows/${flow.id}/activate`)
    expectApiError(res, 'VALIDATION_ERROR', 422)
    const errors: any[] = res.body.error.details?.errors
    expect(Array.isArray(errors), res.text).toBe(true)
    expect(errors.some((e) => e.nodeId === 'orfao' && e.code === 'unreachable_node'), JSON.stringify(errors)).toBe(true)
    expect(errors.some((e) => e.nodeId === 'm2' && e.code === 'invalid_action_config'), JSON.stringify(errors)).toBe(true)
    expect(await versions(flow.id)).toBe(0)
    const after = await owner.c.get(`/api/flows/${flow.id}`)
    expect(after.body.flow.status).toBe('draft')
  })

  it('AC-T28-01 fluxo recém-criado (só o Início) também é recusado com erro no nó start', async () => {
    const flow = await createFlow(owner)
    const res = await owner.c.post(`/api/flows/${flow.id}/activate`)
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(res.body.error.details.errors.some((e: any) => e.nodeId === 'start' && e.code === 'no_node_after_start'), res.text).toBe(true)
  })

  it('AC-T28-01 activate com definição válida → status active e nova flow_versions (sequencial)', async () => {
    const flow = await createFlow(owner)
    await putDefinition(owner, flow.id, validDef())
    const res = await owner.c.post(`/api/flows/${flow.id}/activate`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.flow.status).toBe('active')
    expect(res.body.version.version).toBe(1)
    expect(await versions(flow.id)).toBe(1)

    // editar e ativar de novo publica a versão 2
    const d2 = validDef()
    d2.nodes.find((n: any) => n.id === 'm2')!.actions[0]!.config = { message_text: 'texto novo' }
    await putDefinition(owner, flow.id, d2)
    const res2 = await owner.c.post(`/api/flows/${flow.id}/activate`)
    expect(res2.status, res2.text).toBe(200)
    expect(res2.body.version.version).toBe(2)
    expect(await versions(flow.id)).toBe(2)
    // a versão 1 continua com o texto antigo
    const [v1] = await env.q(`SELECT definition::text AS d FROM crm.flow_versions WHERE flow_id = $1 AND version = 1`, [flow.id])
    expect(v1.d).toContain('Mensagem m2')
    expect(v1.d).not.toContain('texto novo')
  })

  it('AC-T28-01 POST validate devolve os mesmos erros sem mudar nada', async () => {
    const flow = await createFlow(owner)
    const d = validDef()
    d.nodes.push(msgNode('solto', 4))
    await putDefinition(owner, flow.id, d)
    const res = await owner.c.post(`/api/flows/${flow.id}/validate`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors.some((e: any) => e.nodeId === 'solto')).toBe(true)
    expect(await versions(flow.id)).toBe(0)
  })
})

describe('AC-T28-02 upsert de conexão', () => {
  it('AC-T28-02 conectar um handle já ligado substitui a aresta anterior e publica flow.graph_updated', async () => {
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    const flow = await createFlow(owner)
    await putDefinition(owner, flow.id, def([msgNode('A', 1), msgNode('B', 2), msgNode('C', 3)], [edge('start', 'source', 'A'), edge('A', 'source', 'B', 'e-ab')]))
    const stream = await openEvents(env, viewer, owner.companyId)
    try {
      const res = await owner.c.post(`/api/flows/${flow.id}/connections`, { from: 'A', handle: 'source', to: 'C' })
      expect(res.status, res.text).toBe(200)
      expect(res.body.replaced_edge_id).toBe('e-ab')
      expect(res.body.edge).toMatchObject({ from: 'A', handle: 'source', to: 'C' })

      const { definition } = await bundle(owner, flow.id)
      const fromA = definition.edges.filter((e: any) => e.from === 'A' && e.handle === 'source')
      expect(fromA).toHaveLength(1)
      expect(fromA[0].to).toBe('C')
      expect(definition.edges.some((e: any) => e.id === 'e-ab')).toBe(false)
      const [cnt] = await env.q(`SELECT count(*)::int AS n FROM crm.flow_edges WHERE flow_id = $1`, [flow.id])
      expect(cnt.n).toBe(2)

      const ev = await stream.waitFor((m) => m.event === 'flow.graph_updated' && envelopeOf(m).data?.flow_id === flow.id, 10_000)
      const data = envelopeOf(ev).data
      expect(data.actor_id).toBe(owner.userId)
      expect(data.mutation).toBe('add_connection')
    } finally {
      await stream.close()
    }
  })

  it('AC-T28-02 conectar um handle livre cria aresta sem substituir (replaced_edge_id null)', async () => {
    const flow = await createFlow(owner)
    await putDefinition(owner, flow.id, def([msgNode('A', 1), msgNode('B', 2)], [edge('start', 'source', 'A')]))
    const res = await owner.c.post(`/api/flows/${flow.id}/connections`, { from: 'A', handle: 'source', to: 'B' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.replaced_edge_id).toBeNull()
    const { definition } = await bundle(owner, flow.id)
    expect(definition.edges).toHaveLength(2)
  })

  it('AC-T28-02 outras mutações do grafo também publicam flow.graph_updated com actor_id', async () => {
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    const flow = await createFlow(owner)
    const stream = await openEvents(env, viewer, owner.companyId)
    try {
      const add = await owner.c.post(`/api/flows/${flow.id}/nodes`, { id: 'N1', type: 'message', name: 'Novo', position: { x: 10, y: 10 }, actions: [{ type: 'send_message', config: { message_text: 'oi' } }] })
      expect(add.status, add.text).toBe(201)
      const pos = await owner.c.post(`/api/flows/${flow.id}/nodes/positions`, { positions: [{ id: 'N1', x: 99, y: 77 }] })
      expect(pos.status, pos.text).toBe(200)
      await stream.waitFor((m) => m.event === 'flow.graph_updated' && envelopeOf(m).data?.mutation === 'add_node', 10_000)
      await stream.waitFor((m) => m.event === 'flow.graph_updated' && envelopeOf(m).data?.mutation === 'reposition_nodes', 10_000)
      for (const m of stream.events('flow.graph_updated')) expect(envelopeOf(m).data.actor_id).toBe(owner.userId)
      const { definition } = await bundle(owner, flow.id)
      expect(definition.nodes.find((n: any) => n.id === 'N1').position).toEqual({ x: 99, y: 77 })
    } finally {
      await stream.close()
    }
  })
})

describe('AC-T28-03 pastas', () => {
  const folder = async (name: string, parent_id: string | null = null) => {
    const res = await owner.c.post('/api/flow-folders', { name, parent_id })
    expect(res.status, res.text).toBe(201)
    return res.body.folder
  }

  it('AC-T28-03 mover pasta para dentro de uma descendente (ou dela mesma) → 409', async () => {
    const p = await folder('Pai')
    const c = await folder('Filha', p.id)
    const g = await folder('Neta', c.id)
    expectApiError(await owner.c.post(`/api/flow-folders/${p.id}/move`, { parent_id: g.id }), 'CONFLICT', 409)
    expectApiError(await owner.c.post(`/api/flow-folders/${p.id}/move`, { parent_id: c.id }), 'CONFLICT', 409)
    expectApiError(await owner.c.post(`/api/flow-folders/${p.id}/move`, { parent_id: p.id }), 'CONFLICT', 409)
    const list = await owner.c.get('/api/flow-folders')
    expect(list.body.items.find((x: any) => x.id === p.id).parent_id).toBeNull()
    expect(list.body.items.find((x: any) => x.id === c.id).parent_id).toBe(p.id)
    // movimento legítimo continua permitido
    const ok = await owner.c.post(`/api/flow-folders/${g.id}/move`, { parent_id: null })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.folder.parent_id).toBeNull()
  })

  it('AC-T28-03 excluir pasta move os fluxos e as subpastas para a raiz', async () => {
    const p = await folder('Apagar')
    const sub = await folder('Sub', p.id)
    const f1 = await createFlow(owner, 'Na pasta', { folder_id: p.id })
    const f2 = await createFlow(owner, 'Na subpasta', { folder_id: sub.id })
    expect(f1.folder_id).toBe(p.id)
    const del = await owner.c.delete(`/api/flow-folders/${p.id}`)
    expect(del.status, del.text).toBe(200)
    const r1 = await owner.c.get(`/api/flows/${f1.id}`)
    expect(r1.status, r1.text).toBe(200)
    expect(r1.body.flow.folder_id).toBeNull()
    expect((await owner.c.get(`/api/flows/${f2.id}`)).body.flow.folder_id).toBe(sub.id)
    const folders = await owner.c.get('/api/flow-folders')
    const s = folders.body.items.find((x: any) => x.id === sub.id)
    expect(s.parent_id).toBeNull()
    expect(folders.body.items.some((x: any) => x.id === p.id)).toBe(false)
    const root = await owner.c.get('/api/flows?folder_id=root')
    expect(root.body.items.map((x: any) => x.id)).toContain(f1.id)
  })
})

describe('AC-T28-04 impacto de exclusão', () => {
  it('AC-T28-04 deletion-impact conta runs ativos, configs de conexão e referências em outros fluxos', async () => {
    const target = await createFlow(owner, 'Alvo')
    await putDefinition(owner, target.id, validDef())
    // runs: 2 ativos (running, waiting) e 1 encerrado
    for (const status of ['running', 'waiting', 'completed']) {
      const contactId = await newContact(env, owner.companyId)
      await env.q(`INSERT INTO crm.flow_runs (company_id, flow_id, contact_id, status) VALUES ($1, $2, $3, $4)`, [owner.companyId, target.id, contactId, status])
    }
    env.refs.set(target.id, [{ kind: 'connection_flow_config', id: 'cfg-1', name: 'Conexão Vendas' }])
    const ref = await createFlow(owner, 'Referencia o alvo')
    await putDefinition(
      owner,
      ref.id,
      def(
        [msgNode('m1', 1), { id: 'jump', type: 'connection_flow', name: 'Ir para alvo', position: { x: 400, y: 0 }, actions: [{ id: 'jump-a1', type: 'execute_flow', order: 0, config: { target_flow_id: target.id, target_flow_name: 'Alvo' } }] }],
        [edge('start', 'source', 'm1'), edge('m1', 'source', 'jump')],
      ),
    )
    const res = await owner.c.get(`/api/flows/${target.id}/deletion-impact`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.active_runs).toBe(2)
    expect(res.body.total_runs).toBe(3)
    expect(res.body.connection_flow_configs.map((r: any) => r.id)).toEqual(['cfg-1'])
    const refBy = res.body.referenced_by_flows.find((x: any) => x.id === ref.id)
    expect(refBy, res.text).toBeTruthy()
    expect(refBy.node_ids).toContain('jump')
  })

  it('AC-T28-04 excluir fluxo referenciado por configuração de conexão → 409 com as referências', async () => {
    const target = await createFlow(owner, 'Bloqueado')
    env.refs.set(target.id, [{ kind: 'connection_flow_config', id: 'cfg-9', name: 'Conexão 9' }])
    const del = await owner.c.delete(`/api/flows/${target.id}`)
    expectApiError(del, 'CONFLICT', 409)
    expect(del.body.error.details.references).toEqual([expect.objectContaining({ kind: 'connection_flow_config', id: 'cfg-9' })])
    expect((await owner.c.get(`/api/flows/${target.id}`)).status).toBe(200)

    env.refs.delete(target.id)
    const ok = await owner.c.delete(`/api/flows/${target.id}`)
    expect(ok.status, ok.text).toBe(200)
    expectApiError(await owner.c.get(`/api/flows/${target.id}`), 'NOT_FOUND', 404)
  })

  it('AC-T28-04 fluxo de outra empresa → 404 no deletion-impact', async () => {
    const other = await newOwner(env)
    const f = await createFlow(other)
    expectApiError(await owner.c.get(`/api/flows/${f.id}/deletion-impact`), 'NOT_FOUND', 404)
  })
})

describe('AC-T28-05 só flows.view', () => {
  it('AC-T28-05 lê lista e editor-bundle, e recebe 403 em qualquer mutação', async () => {
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    const flow = await createFlow(owner, 'Somente leitura')
    await putDefinition(owner, flow.id, validDef())
    const folder = (await owner.c.post('/api/flow-folders', { name: 'Pasta RO' })).body.folder

    expect((await viewer.c.get('/api/flows')).status).toBe(200)
    const b = await viewer.c.get(`/api/flows/${flow.id}/editor-bundle`)
    expect(b.status, b.text).toBe(200)
    expect(b.body.definition.nodes.map((n: any) => n.id)).toEqual(expect.arrayContaining(['start', 'm1', 'm2']))
    expect((await viewer.c.post(`/api/flows/${flow.id}/validate`)).status).toBe(200)

    const before = await bundle(owner, flow.id)
    const mutations: Array<[string, () => Promise<any>]> = [
      ['POST /flows', () => viewer.c.post('/api/flows', { name: 'x' })],
      ['PATCH /flows/:id', () => viewer.c.patch(`/api/flows/${flow.id}`, { name: 'hack' })],
      ['PUT definition', () => viewer.c.put(`/api/flows/${flow.id}/definition`, validDef())],
      ['POST nodes', () => viewer.c.post(`/api/flows/${flow.id}/nodes`, { type: 'message', position: { x: 0, y: 0 } })],
      ['PATCH node', () => viewer.c.patch(`/api/flows/${flow.id}/nodes/m1`, { name: 'x' })],
      ['DELETE node', () => viewer.c.delete(`/api/flows/${flow.id}/nodes/m2`)],
      ['POST action', () => viewer.c.post(`/api/flows/${flow.id}/nodes/m1/actions`, { type: 'send_message', config: { message_text: 'x' } })],
      ['POST connections', () => viewer.c.post(`/api/flows/${flow.id}/connections`, { from: 'm1', handle: 'source', to: 'start' })],
      ['positions', () => viewer.c.post(`/api/flows/${flow.id}/nodes/positions`, { positions: [{ id: 'm1', x: 1, y: 1 }] })],
      ['activate', () => viewer.c.post(`/api/flows/${flow.id}/activate`)],
      ['pause', () => viewer.c.post(`/api/flows/${flow.id}/pause`)],
      ['archive', () => viewer.c.post(`/api/flows/${flow.id}/archive`)],
      ['duplicate', () => viewer.c.post(`/api/flows/${flow.id}/duplicate`)],
      ['move', () => viewer.c.post(`/api/flows/${flow.id}/move`, { folder_id: folder.id })],
      ['reorder', () => viewer.c.post(`/api/flows/${flow.id}/reorder`, { position: 0 })],
      ['DELETE flow', () => viewer.c.delete(`/api/flows/${flow.id}`)],
      ['POST folder', () => viewer.c.post('/api/flow-folders', { name: 'x' })],
      ['PATCH folder', () => viewer.c.patch(`/api/flow-folders/${folder.id}`, { name: 'x' })],
      ['move folder', () => viewer.c.post(`/api/flow-folders/${folder.id}/move`, { parent_id: null })],
      ['DELETE folder', () => viewer.c.delete(`/api/flow-folders/${folder.id}`)],
    ]
    for (const [name, call] of mutations) {
      const res = await call()
      expect(res.status, `${name}: ${res.text}`).toBe(403)
      expect(res.body?.error?.code, name).toBe('FORBIDDEN')
    }
    const after = await bundle(owner, flow.id)
    expect(after.definition).toEqual(before.definition)
    expect(after.flow.status).toBe('draft')
    expect(await versions(flow.id)).toBe(0)
  })

  it('AC-T28-05 sem flows.view nem a leitura é permitida (403)', async () => {
    const none = await newMember(env, owner.companyId, ['contacts.view'])
    const flow = await createFlow(owner)
    expect((await none.c.get('/api/flows')).status).toBe(403)
    expect((await none.c.get(`/api/flows/${flow.id}/editor-bundle`)).status).toBe(403)
  })
})

describe('AC-T28-06 duplicar', () => {
  it('AC-T28-06 duplicate copia nós, ações e arestas com novos ids e status draft', async () => {
    const flow = await createFlow(owner, 'Original')
    await putDefinition(owner, flow.id, validDef())
    expect((await owner.c.post(`/api/flows/${flow.id}/activate`)).status).toBe(200)
    const src = await bundle(owner, flow.id)

    const dup = await owner.c.post(`/api/flows/${flow.id}/duplicate`)
    expect(dup.status, dup.text).toBe(201)
    const copy = dup.body.flow
    expect(copy.id).not.toBe(flow.id)
    expect(copy.status).toBe('draft')
    expect(copy.name).toContain('Original')
    const dst = await bundle(owner, copy.id)

    const sd = src.definition
    const dd = dst.definition
    expect(dd.nodes).toHaveLength(sd.nodes.length)
    expect(dd.edges).toHaveLength(sd.edges.length)
    // ids novos para nós, ações e arestas
    const srcIds = new Set([...sd.nodes.map((n: any) => n.id), ...sd.nodes.flatMap((n: any) => n.actions.map((a: any) => a.id)), ...sd.edges.map((e: any) => e.id)])
    for (const n of dd.nodes) {
      expect(srcIds.has(n.id), `nó reaproveitou id ${n.id}`).toBe(false)
      for (const a of n.actions) expect(srcIds.has(a.id), `ação reaproveitou id ${a.id}`).toBe(false)
    }
    for (const e of dd.edges) expect(srcIds.has(e.id), `aresta reaproveitou id ${e.id}`).toBe(false)

    // mesma estrutura (mapeando por nome do nó)
    const byName = (d: any) => new Map(d.nodes.map((n: any) => [n.name, n]))
    const sByName = byName(sd)
    const dByName = byName(dd)
    const idToName = (d: any) => new Map(d.nodes.map((n: any) => [n.id, n.name]))
    for (const [name, sn] of sByName as Map<string, any>) {
      const dn: any = dByName.get(name)
      expect(dn, `nó ${name} ausente na cópia`).toBeTruthy()
      expect(dn.type).toBe(sn.type)
      expect(dn.position).toEqual(sn.position)
      expect(dn.actions.map((a: any) => [a.type, a.order, a.config])).toEqual(sn.actions.map((a: any) => [a.type, a.order, a.config]))
    }
    const shape = (d: any) => {
      const names = idToName(d)
      return d.edges.map((e: any) => `${names.get(e.from)}|${e.handle}|${names.get(e.to)}`).sort()
    }
    expect(shape(dd)).toEqual(shape(sd))
    expect(idToName(dd).get(dd.entry)).toBe('Início')

    // original intacto e ainda ativo; a cópia é independente
    expect((await bundle(owner, flow.id)).definition).toEqual(sd)
    expect((await owner.c.get(`/api/flows/${flow.id}`)).body.flow.status).toBe('active')
    const [v] = await env.q(`SELECT count(*)::int AS n FROM crm.flow_versions WHERE flow_id = $1`, [copy.id])
    expect(v.n).toBe(0)
  })

  it('AC-T28-06 editar a cópia não altera o original', async () => {
    const flow = await createFlow(owner, 'Base')
    await putDefinition(owner, flow.id, validDef())
    const copy = (await owner.c.post(`/api/flows/${flow.id}/duplicate`)).body.flow
    const before = (await bundle(owner, flow.id)).definition
    const dd = (await bundle(owner, copy.id)).definition
    const m2 = dd.nodes.find((n: any) => n.name === 'Nó m2')
    const res = await owner.c.delete(`/api/flows/${copy.id}/nodes/${m2.id}`)
    expect(res.status, res.text).toBe(200)
    expect((await bundle(owner, flow.id)).definition).toEqual(before)
  })
})

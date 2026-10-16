// AC-T43-02 (share-code entre empresas), AC-T43-03 (export → import JSON) e AC-T43-05 (colar nós).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import {
  bundle,
  def,
  edge,
  fetchMedia,
  flowLinkNode,
  flowWith,
  graphShape,
  mediaNode,
  msgDef,
  msgNode,
  newMember,
  newOwner,
  putDefinition,
  startEnv,
  tagsNode,
  uploadMedia,
  waitNode,
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

const labelsOf = async (companyId: string) =>
  (await env.q(`SELECT name FROM crm.labels WHERE company_id = $1 ORDER BY lower(name)`, [companyId])).map((r: any) => r.name as string)
const actionOf = (d: any, type: string) => d.nodes.flatMap((n: any) => n.actions ?? []).find((a: any) => a.type === type)
const mediaIdOf = (ref: string) => ref.split('/').filter(Boolean).pop()!

describe('AC-T43-02 compartilhar e importar por código', () => {
  it('AC-T43-02 share-code é estável e importar em outra empresa recria o fluxo com etiquetas, mídia copiada e aviso de fluxo ausente', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 64 }, (_, i) => i)])
    const mediaId = await uploadMedia(env, owner, bytes)
    const missingTarget = (await flowWith(owner, msgDef())).id // fluxo da origem que NÃO vai junto
    const source = await flowWith(
      owner,
      def(
        [tagsNode('tg', 200, 0, ['VIP', 'Novo Lead']), mediaNode('md', 400, 0, `/api/media/${mediaId}`), flowLinkNode('lk', 600, 0, missingTarget)],
        [edge('start', 'source', 'tg'), edge('tg', 'source', 'md'), edge('md', 'source', 'lk')],
      ),
      false,
      'Fluxo compartilhado',
    )

    const sc = await owner.c.get(`/api/flows/${source.id}/share-code`)
    expect(sc.status, sc.text).toBe(200)
    expect(typeof sc.body.code).toBe('string')
    expect(sc.body.code.length).toBeGreaterThanOrEqual(6)
    expect((await owner.c.get(`/api/flows/${source.id}/share-code`)).body.code).toBe(sc.body.code)

    const dest = await newOwner(env)
    await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, 'vip', 'red')`, [dest.companyId])
    const imp = await dest.c.post('/api/flows/import', { codes: [sc.body.code] })
    expect(imp.status, imp.text).toBe(201)
    expect(imp.body.errors).toEqual([])
    expect(imp.body.items).toHaveLength(1)
    const item = imp.body.items[0]
    expect(item.code).toBe(sc.body.code)
    expect(item.flow.id).not.toBe(source.id)
    expect(item.flow.name).toContain('Fluxo compartilhado')
    expect(item.flow.status).toBe('draft')
    const [row] = await env.q(`SELECT company_id FROM crm.flows WHERE id = $1`, [item.flow.id])
    expect(row.company_id).toBe(dest.companyId)

    // etiquetas: criadas por nome (case-insensitive: 'vip' existente não duplica)
    expect(await labelsOf(dest.companyId)).toEqual(['Novo Lead', 'vip'])
    const { definition } = await bundle(dest, item.flow.id)
    expect(actionOf(definition, 'add_tags').config.tags).toEqual(['VIP', 'Novo Lead'])

    // mídia copiada: referência nova que abre na empresa destino com os mesmos bytes; a original não vale lá
    const ref: string = actionOf(definition, 'send_multi_media').config.media_url
    expect(ref).toBeTruthy()
    const newId = mediaIdOf(ref)
    expect(newId).not.toBe(mediaId)
    const got = await fetchMedia(env, dest, newId)
    expect(got.status).toBe(200)
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true)
    expect((await fetchMedia(env, dest, mediaId)).status).toBe(404)

    // referência a fluxo que não existe na empresa destino vira aviso
    expect(item.warnings).toContainEqual(expect.objectContaining({ code: 'flow_reference_missing', target_flow_id: missingTarget }))
    expect(actionOf(definition, 'execute_flow').config.target_flow_id).not.toBe(missingTarget)

    // origem intacta; cópia independente
    const orig = await bundle(owner, source.id)
    expect(actionOf(orig.definition, 'execute_flow').config.target_flow_id).toBe(missingTarget)
    expect(actionOf(orig.definition, 'send_multi_media').config.media_url).toBe(`/api/media/${mediaId}`)
  })

  it('AC-T43-02 vários códigos: referência entre fluxos importados juntos aponta para a cópia; código inválido vira erro', async () => {
    const target = await flowWith(owner, msgDef(), false, 'Alvo')
    const caller = await flowWith(owner, def([flowLinkNode('lk', 200, 0, target.id)], [edge('start', 'source', 'lk')]), false, 'Chamador')
    const cTarget = (await owner.c.get(`/api/flows/${target.id}/share-code`)).body.code
    const cCaller = (await owner.c.get(`/api/flows/${caller.id}/share-code`)).body.code
    expect(cTarget).not.toBe(cCaller)

    const dest = await newOwner(env)
    const imp = await dest.c.post('/api/flows/import', { codes: [cCaller, cTarget, 'codigo-que-nao-existe'] })
    expect(imp.status, imp.text).toBe(201)
    expect(imp.body.items).toHaveLength(2)
    expect(imp.body.errors).toEqual([expect.objectContaining({ code: 'codigo-que-nao-existe', reason: 'invalid_code' })])
    const byCode = new Map(imp.body.items.map((i: any) => [i.code, i]))
    const newTarget: any = byCode.get(cTarget)
    const newCaller: any = byCode.get(cCaller)
    expect(newCaller.warnings.filter((w: any) => w.code === 'flow_reference_missing')).toEqual([])
    const { definition } = await bundle(dest, newCaller.flow.id)
    expect(actionOf(definition, 'execute_flow').config.target_flow_id).toBe(newTarget.flow.id)
  })

  it('AC-T43-02 permissões: share-code de outra empresa → 404; importar sem flows.edit → 403', async () => {
    const flow = await flowWith(owner, msgDef(), false)
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/flows/${flow.id}/share-code`), 'NOT_FOUND', 404)
    const code = (await owner.c.get(`/api/flows/${flow.id}/share-code`)).body.code
    const viewer = await newMember(env, other.companyId, ['flows.view'])
    expectApiError(await viewer.c.post('/api/flows/import', { codes: [code] }), 'FORBIDDEN', 403)
  })
})

describe('AC-T43-03 exportar e importar JSON', () => {
  const richDef = () =>
    def(
      [
        msgNode('m1', 220, 40, 'Olá {first_name}'),
        waitNode('w', 440, 60),
        msgNode('ok', 660, -20, 'Respondeu'),
        msgNode('to', 660, 140, 'Sem resposta'),
        tagsNode('tg', 880, 140, ['Frio']),
      ],
      [edge('start', 'source', 'm1'), edge('m1', 'source', 'w'), edge('w', 'source', 'ok'), edge('w', 'timeout', 'to'), edge('to', 'source', 'tg')],
    )

  it('AC-T43-03 export → import-json reproduz o grafo (exceto ids) num fluxo novo, sem erros de validação', async () => {
    const flow = await flowWith(owner, richDef(), true, 'Exportável')
    const exp = await owner.c.get(`/api/flows/${flow.id}/export`)
    expect(exp.status, exp.text).toBe(200)
    expect(exp.body.format).toBe('crm.flow.export/v1')
    expect(exp.body.flow.name).toBe('Exportável')
    expect(exp.body.labels).toContain('Frio')
    expect(exp.body.definition.schema).toBe('crm.flow/v1')

    const dest = await newOwner(env)
    const imp = await dest.c.post('/api/flows/import-json', exp.body)
    expect(imp.status, imp.text).toBe(201)
    expect(imp.body.validation_errors).toEqual([])
    expect(imp.body.flow.id).not.toBe(flow.id)
    const [row] = await env.q(`SELECT company_id FROM crm.flows WHERE id = $1`, [imp.body.flow.id])
    expect(row.company_id).toBe(dest.companyId)

    const original = (await bundle(owner, flow.id)).definition
    const copy = (await bundle(dest, imp.body.flow.id)).definition
    expect(graphShape(copy)).toEqual(graphShape(original))
    expect(copy.nodes).toHaveLength(original.nodes.length)
    expect(copy.edges).toHaveLength(original.edges.length)
    expect(await labelsOf(dest.companyId)).toContain('Frio')

    // a cópia valida igual ao original
    const v = await dest.c.post(`/api/flows/${imp.body.flow.id}/validate`)
    expect(v.body).toMatchObject({ valid: true, errors: [] })
    // importar de novo na mesma empresa cria outro fluxo independente
    const again = await owner.c.post('/api/flows/import-json', exp.body)
    expect(again.status, again.text).toBe(201)
    expect(again.body.flow.id).not.toBe(flow.id)
    expect(graphShape((await bundle(owner, again.body.flow.id)).definition)).toEqual(graphShape(original))
  })

  it('AC-T43-03 import valida com validate: grafo com erro semântico entra como rascunho com validation_errors; estrutura inválida → 422', async () => {
    const flow = await flowWith(owner, msgDef(), false)
    const d = msgDef()
    d.nodes.push(msgNode('solto', 900, 300))
    await putDefinition(owner, flow.id, d)
    const exp = (await owner.c.get(`/api/flows/${flow.id}/export`)).body

    const imp = await owner.c.post('/api/flows/import-json', exp)
    expect(imp.status, imp.text).toBe(201)
    expect(imp.body.flow.status).toBe('draft')
    expect(imp.body.validation_errors.some((e: any) => e.code === 'unreachable_node'), JSON.stringify(imp.body.validation_errors)).toBe(true)

    expectApiError(await owner.c.post('/api/flows/import-json', { ...exp, definition: { schema: 'crm.flow/v1', nodes: 'x' } }), 'VALIDATION_ERROR', 422)
    expectApiError(await owner.c.post('/api/flows/import-json', { format: 'outro', flow: { name: 'x' } }), 'VALIDATION_ERROR', 422)
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    expectApiError(await viewer.c.post('/api/flows/import-json', exp), 'FORBIDDEN', 403)
  })
})

describe('AC-T43-05 colar nós', () => {
  // start → A → B → C → X
  const sourceDef = () =>
    def(
      [msgNode('A', 100, 100), msgNode('B', 300, 100), msgNode('C', 500, 100), msgNode('X', 300, 300)],
      [edge('start', 'source', 'A'), edge('A', 'source', 'B'), edge('B', 'source', 'C'), edge('C', 'source', 'X')],
    )

  it('AC-T43-05 colar clona os nós pedidos e só as arestas internas, com deslocamento +50/+50', async () => {
    const src = await flowWith(owner, sourceDef(), false, 'Origem')
    const dst = await flowWith(owner, msgDef(), false, 'Destino')
    const before = (await bundle(owner, dst.id)).definition

    const res = await owner.c.post(`/api/flows/${dst.id}/paste-nodes`, { source_flow_id: src.id, nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'start' }] })
    expect(res.status, res.text).toBe(201)
    expect(res.body.nodes).toHaveLength(3)
    const byName = new Map(res.body.nodes.map((n: any) => [n.name, n]))
    for (const [name, x, y] of [['Nó A', 100, 100], ['Nó B', 300, 100], ['Nó C', 500, 100]] as const) {
      const n: any = byName.get(name)
      expect(n, name).toBeTruthy()
      expect(['A', 'B', 'C']).not.toContain(n.id)
      expect(n.position).toEqual({ x: x + 50, y: y + 50 })
    }
    const pasted = new Set(res.body.nodes.map((n: any) => n.id))
    expect(res.body.edges).toHaveLength(2)
    for (const e of res.body.edges) {
      expect(pasted.has(e.from)).toBe(true)
      expect(pasted.has(e.to)).toBe(true)
    }

    const after = (await bundle(owner, dst.id)).definition
    expect(after.nodes).toHaveLength(before.nodes.length + 3)
    expect(after.edges).toHaveLength(before.edges.length + 2)
    expect(after.nodes.filter((n: any) => n.type === 'start')).toHaveLength(1)
    const names = new Map(after.nodes.map((n: any) => [n.id, n.name]))
    const added = after.edges.filter((e: any) => pasted.has(e.from)).map((e: any) => `${names.get(e.from)}>${names.get(e.to)}`).sort()
    expect(added).toEqual(['Nó A>Nó B', 'Nó B>Nó C'])
    // ações clonadas com a mesma config
    const a: any = byName.get('Nó A')
    const aAfter = after.nodes.find((n: any) => n.id === a.id)
    expect(aAfter.actions.map((x: any) => [x.type, x.config])).toEqual([['send_message', { message_text: 'Mensagem A' }]])
    // origem intacta
    expect((await bundle(owner, src.id)).definition.nodes).toHaveLength(5)
  })

  it('AC-T43-05 posição enviada prevalece; origem de outra empresa → 404; sem flows.edit → 403', async () => {
    const src = await flowWith(owner, sourceDef(), false)
    const dst = await flowWith(owner, msgDef(), false)
    const res = await owner.c.post(`/api/flows/${dst.id}/paste-nodes`, { source_flow_id: src.id, nodes: [{ id: 'X', position: { x: 777, y: 888 } }] })
    expect(res.status, res.text).toBe(201)
    expect(res.body.nodes).toHaveLength(1)
    expect(res.body.nodes[0].position).toEqual({ x: 777, y: 888 })
    expect(res.body.edges).toEqual([])

    const other = await newOwner(env)
    const foreign = await flowWith(other, sourceDef(), false)
    expectApiError(await owner.c.post(`/api/flows/${dst.id}/paste-nodes`, { source_flow_id: foreign.id, nodes: [{ id: 'A' }] }), 'NOT_FOUND', 404)
    expectApiError(await owner.c.post(`/api/flows/${dst.id}/paste-nodes`, { source_flow_id: uuid(), nodes: [{ id: 'A' }] }), 'NOT_FOUND', 404)
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    expectApiError(await viewer.c.post(`/api/flows/${dst.id}/paste-nodes`, { source_flow_id: src.id, nodes: [{ id: 'A' }] }), 'FORBIDDEN', 403)
  })
})

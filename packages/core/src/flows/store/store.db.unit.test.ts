// Postgres real (SPEC 3.10): banco descartável migrado.
import { randomBytes, randomUUID } from 'node:crypto'
import { companies, createDb, flowEdges, flowNodes, flowRuns, flowVersions, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FLOW_SCHEMA_VERSION, type FlowDefinition } from '@crm/shared/flows'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowStoreError } from './errors'
import { FlowStore, START_NODE_KEY, type FlowCtx } from './store'

let temp: TempDatabase
let db: Database
let store: FlowStore
let a: FlowCtx
let b: FlowCtx

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  store = new FlowStore(db)
  a = { companyId: await company('A') }
  b = { companyId: await company('B') }
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function company(name: string): Promise<string> {
  const [row] = await db
    .insert(companies)
    .values({ name, slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}` })
    .returning({ id: companies.id })
  return row!.id
}

const sample = (): FlowDefinition => ({
  schema: FLOW_SCHEMA_VERSION,
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 1200, y: 800 }, actions: [] },
    {
      id: 'msg',
      type: 'message',
      name: 'Boas-vindas',
      description: 'primeira mensagem',
      position: { x: 1500, y: 800 },
      actions: [
        { id: 'a2', type: 'delay_between_messages', order: 1, config: { seconds: 2 } },
        { id: 'a1', type: 'send_message', order: 0, config: { text: 'Olá {first_name}!' } },
      ],
    },
    {
      id: 'menu',
      type: 'interactive_menu',
      name: 'Menu',
      position: { x: 1800, y: 800.5 },
      actions: [{ id: 'm1', type: 'send_interactive_menu', order: 0, config: { text: 'Escolha', options: [{ id: 'o1', title: 'Comprar' }] } }],
    },
    { id: 'ext', type: 'unsupported', name: 'Ligar', position: { x: 0, y: 0 }, actions: [], original_type: 'make_call' },
  ],
  edges: [
    { id: 'e2', from: 'msg', handle: 'source', to: 'menu' },
    { id: 'e1', from: 'start', handle: 'source', to: 'msg' },
    { id: 'e3', from: 'menu', handle: 'option:o1', to: 'msg' },
  ],
  variables: [{ name: 'cupom', default: 'BEMVINDO' }],
  refs: { tags: [{ id: 't1', name: 'Lead' }] },
})

describe('FlowStore', () => {
  it('createFlow nasce com o nó Início e status active', async () => {
    const flow = await store.createFlow(a, { name: 'Vendas' })
    expect(flow).toMatchObject({ name: 'Vendas', status: 'active', companyId: a.companyId, entryKey: START_NODE_KEY })
    const def = await store.toDefinition(a, flow.id)
    expect(def.nodes).toEqual([{ id: 'start', type: 'start', name: 'Início', position: { x: 1200, y: 800 }, actions: [] }])
    expect((await store.createFlow(a)).name).toBe('Novo Fluxo')
  })

  it('round-trip: fromDefinition → toDefinition reproduz nós, ações, arestas, ordem, variáveis e refs', async () => {
    const flow = await store.createFlow(a)
    const def = sample()
    const saved = await store.fromDefinition(a, flow.id, def)
    expect(saved).toEqual(def)
    expect(await store.toDefinition(a, flow.id)).toEqual(def)
    expect(JSON.stringify(await store.toDefinition(a, flow.id))).toBe(JSON.stringify(def))
    // Reescrever substitui o rascunho inteiro (sem sobras do anterior).
    const smaller: FlowDefinition = { ...def, nodes: def.nodes.slice(0, 2), edges: [def.edges[1]!] }
    expect(await store.fromDefinition(a, flow.id, smaller)).toEqual(smaller)
    const nodes = await db.select().from(flowNodes).where(eq(flowNodes.flowId, flow.id))
    expect(nodes).toHaveLength(2)
  })

  it('fromDefinition recusa estrutura inválida e referências quebradas', async () => {
    const flow = await store.createFlow(a)
    await expect(store.fromDefinition(a, flow.id, { schema: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const bad = sample()
    bad.edges.push({ id: 'e9', from: 'msg', handle: 'timeout', to: 'nao-existe' })
    await expect(store.fromDefinition(a, flow.id, bad)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const dupHandle = sample()
    dupHandle.edges.push({ id: 'e9', from: 'start', handle: 'source', to: 'menu' })
    await expect(store.fromDefinition(a, flow.id, dupHandle)).rejects.toMatchObject({ code: 'CONFLICT', details: { constraint: 'flow_edges_from_handle_uq' } })
    // A falha não deixou o rascunho pela metade.
    expect((await store.toDefinition(a, flow.id)).nodes.map((n) => n.id)).toEqual(['start'])
  })

  it('AC-01: dois edges com o mesmo (nó de origem, handle) violam a unicidade no banco', async () => {
    const flow = await store.createFlow(a)
    await store.fromDefinition(a, flow.id, sample())
    const [msg] = await db.select().from(flowNodes).where(eq(flowNodes.key, 'msg'))
    const [menu] = await db.select().from(flowNodes).where(eq(flowNodes.key, 'menu'))
    const insert = (key: string, to: string) =>
      db.insert(flowEdges).values({ companyId: a.companyId, flowId: flow.id, key, fromNodeId: msg!.id, handle: 'timeout', toNodeId: to })
    await insert('x1', menu!.id)
    await expect(insert('x2', msg!.id)).rejects.toMatchObject({ cause: { code: '23505', constraint: 'flow_edges_from_handle_uq' } })
  })

  it('AC-02: um run running|waiting por contato e empresa', async () => {
    const fa = await store.createFlow(a)
    const fb = await store.createFlow(b)
    const contactId = randomUUID()
    const run = (ctx: FlowCtx, flowId: string, status: 'running' | 'waiting' | 'completed' = 'running') =>
      db.insert(flowRuns).values({ companyId: ctx.companyId, flowId, contactId, status }).returning()
    const [first] = await run(a, fa.id)
    await expect(run(a, fa.id, 'waiting')).rejects.toMatchObject({ cause: { code: '23505', constraint: 'flow_runs_active_contact_uq' } })
    await expect(run(b, fb.id, 'waiting')).resolves.toHaveLength(1)
    // Runs finalizados não ocupam o contato.
    await run(a, fa.id, 'completed')
    await db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.id, first!.id))
    await expect(run(a, fa.id, 'waiting')).resolves.toHaveLength(1)
  })

  it('AC-04: publish grava versões sequenciais imutáveis; editar o rascunho não altera a publicada', async () => {
    const flow = await store.createFlow(a, { name: 'Pub' })
    await store.fromDefinition(a, flow.id, sample())
    const v1 = await store.publish({ ...a, userId: null }, flow.id)
    expect(v1).toMatchObject({ flowId: flow.id, version: 1, definition: sample() })
    const edited = sample()
    edited.nodes[1]!.name = 'Editado'
    await store.fromDefinition(a, flow.id, edited)
    const v2 = await store.publish(a, flow.id)
    expect(v2.version).toBe(2)
    expect((await store.getVersion(a, flow.id, 1)).definition).toEqual(sample())
    expect((await store.getVersion(a, flow.id)).version).toBe(2)
    expect((await store.listVersions(a, flow.id)).map((v) => v.version)).toEqual([1, 2])
    expect((await store.getFlow(a, flow.id)).publishedVersion).toBe(2)
    // O banco recusa UPDATE em versão publicada (trigger).
    await expect(db.update(flowVersions).set({ definition: {} }).where(eq(flowVersions.id, v1.id))).rejects.toBeDefined()
    expect((await store.getVersion(a, flow.id, 1)).definition).toEqual(sample())
    await expect(store.getVersion(a, flow.id, 9)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('publicações concorrentes do mesmo fluxo recebem números distintos', async () => {
    const flow = await store.createFlow(a)
    const versions = await Promise.all([1, 2, 3, 4].map(() => store.publish(a, flow.id)))
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3, 4])
  })

  it('AC-05: pasta não pode ter como pai a si mesma nem uma descendente (CONFLICT)', async () => {
    const root = await store.createFolder(a, { name: 'Raiz' })
    const child = await store.createFolder(a, { name: 'Filha', parentFolderId: root.id, color: 'green' })
    const grand = await store.createFolder(a, { name: 'Neta', parentFolderId: child.id })
    await expect(store.moveFolder(a, root.id, grand.id)).rejects.toMatchObject({ name: 'FlowStoreError', code: 'CONFLICT' })
    await expect(store.moveFolder(a, root.id, child.id)).rejects.toBeInstanceOf(FlowStoreError)
    await expect(store.updateFolder(a, child.id, { parentFolderId: child.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    // Movimentos válidos.
    expect((await store.moveFolder(a, grand.id, root.id)).parentFolderId).toBe(root.id)
    expect((await store.moveFolder(a, child.id, null)).parentFolderId).toBeNull()
    expect((await store.moveFolder(a, root.id, child.id)).parentFolderId).toBe(child.id)
    await expect(store.createFolder(a, { name: 'x', color: 'pink' as never })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('isolamento: recurso de outra empresa → NOT_FOUND', async () => {
    const flow = await store.createFlow(a)
    const folder = await store.createFolder(a, { name: 'Privada' })
    await expect(store.getFlow(b, flow.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.toDefinition(b, flow.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.fromDefinition(b, flow.id, sample())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.publish(b, flow.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.getFolder(b, folder.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.createFolder(b, { name: 'x', parentFolderId: folder.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.createFlow(b, { folderId: folder.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.getFlow(a, 'nao-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.listFlows(b)).map((f) => f.id)).not.toContain(flow.id)
  })

  it('listas, atualização e exclusão', async () => {
    const folder = await store.createFolder(a, { name: 'Campanhas' })
    const f1 = await store.createFlow(a, { name: 'F1', folderId: folder.id, position: 1 })
    const f0 = await store.createFlow(a, { name: 'F0', folderId: folder.id, position: 0 })
    expect((await store.listFlows(a, { folderId: folder.id })).map((f) => f.name)).toEqual(['F0', 'F1'])
    expect((await store.updateFlow(a, f1.id, { status: 'paused', name: ' F1b ' })).name).toBe('F1b')
    expect((await store.listFlows(a, { folderId: folder.id, status: 'paused' })).map((f) => f.id)).toEqual([f1.id])
    await store.deleteFolder(a, folder.id)
    expect((await store.getFlow(a, f0.id)).folderId).toBeNull()
    await store.deleteFlow(a, f0.id)
    await expect(store.getFlow(a, f0.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

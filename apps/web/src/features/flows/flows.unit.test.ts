import { afterEach, describe, expect, it } from 'vitest'
import { configureHttp, HttpError } from '@/lib/http'
import { applyReorder, flowsApi, referencedConfigs, type FlowDto, type FolderDto } from './api'
import {
  breadcrumb,
  buildTree,
  canMoveFolder,
  childFolders,
  descendantIds,
  folderCounts,
  folderIdOf,
  flowsIn,
  paginate,
  parseCodes,
  reorderPlan,
  statusActions,
  uniqueName,
  updatedLabel,
  visibleItems,
} from './model'
import { flowsSearchSchema } from './view'

afterEach(() => configureHttp({ companyId: null }))

const flow = (id: string, extra: Partial<FlowDto> = {}): FlowDto => ({
  id,
  name: id.toUpperCase(),
  description: null,
  status: 'draft',
  folder_id: null,
  position: 0,
  published_version: null,
  nodes_count: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const folder = (id: string, parent: string | null = null, position = 0): FolderDto => ({
  id,
  name: `Pasta ${id}`,
  color: 'blue',
  parent_id: parent,
  position,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

// a ─┬─ b ── c
//    └─ d
// e
const FOLDERS = [folder('c', 'b'), folder('e', null, 1), folder('b', 'a', 1), folder('a', null, 0), folder('d', 'a', 0)]

describe('árvore de pastas', () => {
  it('monta a árvore por posição e pai (pai inexistente vai para a raiz)', () => {
    const tree = buildTree([...FOLDERS, folder('orfa', 'sumiu', 9)])
    expect(tree.map((n) => n.folder.id)).toEqual(['a', 'e', 'orfa'])
    expect(tree[0]!.children.map((n) => [n.folder.id, n.depth])).toEqual([
      ['d', 1],
      ['b', 1],
    ])
    expect(tree[0]!.children[1]!.children.map((n) => n.folder.id)).toEqual(['c'])
    expect(childFolders(FOLDERS, null).map((f) => f.id)).toEqual(['a', 'e'])
    expect(childFolders(FOLDERS, 'a').map((f) => f.id)).toEqual(['d', 'b'])
  })

  it('bloqueia mover pasta para si mesma ou descendente (AC-T44-02)', () => {
    expect([...descendantIds(FOLDERS, 'a')].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(canMoveFolder(FOLDERS, 'a', 'c')).toBe(false)
    expect(canMoveFolder(FOLDERS, 'a', 'a')).toBe(false)
    expect(canMoveFolder(FOLDERS, 'b', 'd')).toBe(true)
    expect(canMoveFolder(FOLDERS, 'c', 'e')).toBe(true)
    expect(canMoveFolder(FOLDERS, 'a', null)).toBe(true)
  })

  it('breadcrumb da raiz até a pasta e contadores', () => {
    expect(breadcrumb(FOLDERS, 'c').map((f) => f.id)).toEqual(['a', 'b', 'c'])
    expect(breadcrumb(FOLDERS, null)).toEqual([])
    expect(breadcrumb(FOLDERS, 'x')).toEqual([])
    const flows = [flow('f1', { folder_id: 'a' }), flow('f2', { folder_id: 'a' }), flow('f3', { folder_id: 'b' })]
    expect(folderCounts(flows, FOLDERS, 'a')).toEqual({ flows: 2, folders: 2 })
    expect(folderIdOf(undefined)).toBeNull()
    expect(folderIdOf('root')).toBeNull()
    expect(folderIdOf('a')).toBe('a')
  })
})

describe('lista visível', () => {
  const flows = [
    flow('r2', { position: 2, status: 'active', name: 'Boas-vindas' }),
    flow('r1', { position: 1, status: 'paused', name: 'Cobrança' }),
    flow('a1', { folder_id: 'a', status: 'active', name: 'Ação' }),
  ]

  it('sem busca mostra a pasta atual na ordem; status filtra; `folders` esconde fluxos (AC-T44-01)', () => {
    expect(visibleItems(flows, FOLDERS, { folder: null })).toEqual({
      flows: [flows[1], flows[0]],
      folders: [FOLDERS[3], FOLDERS[1]],
    })
    expect(visibleItems(flows, FOLDERS, { folder: 'a' }).flows.map((f) => f.id)).toEqual(['a1'])
    const active = visibleItems(flows, FOLDERS, { folder: null, status: 'active' })
    expect(active).toEqual({ flows: [flows[0]], folders: [] })
    expect(visibleItems(flows, FOLDERS, { folder: null, status: 'folders' })).toEqual({
      flows: [],
      folders: [FOLDERS[3], FOLDERS[1]],
    })
  })

  it('a busca procura em todas as pastas, sem acento nem caixa', () => {
    expect(visibleItems(flows, FOLDERS, { folder: null, search: 'acao' }).flows.map((f) => f.id)).toEqual(['a1'])
    expect(visibleItems(flows, FOLDERS, { folder: 'a', search: 'COBR' }).flows.map((f) => f.id)).toEqual(['r1'])
    expect(visibleItems(flows, FOLDERS, { folder: null, search: 'pasta c' }).folders.map((f) => f.id)).toEqual(['c'])
  })

  it('paginação no cliente com "de–até de total"', () => {
    const rows = Array.from({ length: 45 }, (_, i) => i)
    expect(paginate(rows, 1)).toMatchObject({ page: 1, pages: 3, from: 1, to: 20, total: 45 })
    expect(paginate(rows, 3)).toMatchObject({ page: 3, from: 41, to: 45, rows: [40, 41, 42, 43, 44] })
    expect(paginate(rows, 9).page).toBe(3)
    expect(paginate([], 1)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, total: 0 })
  })
})

describe('reordenar', () => {
  const list = [
    flow('a', { position: 0 }),
    flow('b', { position: 1 }),
    flow('c', { position: 2 }),
    flow('d', { position: 3 }),
  ]

  it('posições 0..n-1 só dos fluxos que mudaram', () => {
    expect(reorderPlan(list, 'd', 'b')).toEqual([
      { id: 'd', position: 1 },
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
    ])
    expect(reorderPlan(list, 'a', null)).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'd', position: 2 },
      { id: 'a', position: 3 },
    ])
    expect(reorderPlan(list, 'b', 'c')).toEqual([])
    expect(reorderPlan(list, 'b', 'b')).toEqual([])
    expect(reorderPlan(list, 'x', 'a')).toEqual([])
  })

  it('renumera posições repetidas (o servidor não renumera)', () => {
    const tied = [flow('a'), flow('b'), flow('c')]
    // c já está em 0: só a e b precisam de posição nova.
    expect(reorderPlan(tied, 'c', 'a')).toEqual([
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ])
    expect(
      flowsIn([flow('z', { position: 1 }), flow('y', { position: 0 }), flow('x', { folder_id: 'p' })], null).map(
        (f) => f.id,
      ),
    ).toEqual(['y', 'z'])
  })
})

describe('textos e regras', () => {
  it('códigos de importação por vírgula, ponto e vírgula, espaço ou linha, sem repetir', () => {
    expect(parseCodes('abc23, XYZ45\nabc23;  QQQ99 \n\n')).toEqual(['ABC23', 'XYZ45', 'QQQ99'])
    expect(parseCodes('  ')).toEqual([])
  })

  it('nome único na pasta', () => {
    expect(uniqueName('Novo Fluxo', ['Outro'])).toBe('Novo Fluxo')
    expect(uniqueName('Novo Fluxo', ['novo fluxo', 'Novo Fluxo 1'])).toBe('Novo Fluxo 2')
  })

  it('"Hoje"/"Ontem" com hora, senão a data', () => {
    const now = new Date(2026, 9, 16, 15, 0)
    expect(updatedLabel(new Date(2026, 9, 16, 9, 5).toISOString(), now, 'pt-BR')).toEqual({
      kind: 'today',
      text: '09:05',
    })
    expect(updatedLabel(new Date(2026, 9, 15, 23, 59).toISOString(), now, 'pt-BR').kind).toBe('yesterday')
    expect(updatedLabel(new Date(2026, 9, 1, 8, 0).toISOString(), now, 'pt-BR')).toEqual({
      kind: 'date',
      text: '01/10/2026',
    })
  })

  it('ações de status por status', () => {
    expect(statusActions('active')).toEqual(['pause', 'archive'])
    expect(statusActions('draft')).toEqual(['activate', 'archive'])
    expect(statusActions('archived')).toEqual(['unarchive'])
  })

  it('search params: folder uuid|root, flow_status e view; inválidos somem', () => {
    const id = '0b9a4a1e-3c1f-4c7e-9a43-1f2d3c4b5a69'
    expect(flowsSearchSchema.parse({ folder: id, flow_status: 'paused', view: 'table', q: 'x' })).toEqual({
      folder: id,
      flow_status: 'paused',
      view: 'table',
      q: 'x',
    })
    expect(flowsSearchSchema.parse({ folder: 'root' })).toEqual({ folder: 'root' })
    expect(flowsSearchSchema.parse({ folder: '12', flow_status: 'nope', view: 'grid' })).toEqual({})
  })
})

describe('api', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('excluir com force manda ?force=1; reorder sequencial; import manda os códigos', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    configureHttp({
      fetch: async (url, init) => {
        calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.includes('/import')) return json({ items: [], errors: [{ code: 'X', reason: 'invalid_code' }] }, 201)
        return json({ deleted: true })
      },
    })
    await flowsApi.remove('f1', true)
    await flowsApi.remove('f2', false)
    await applyReorder([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ])
    const res = await flowsApi.importCodes(['X'])
    expect(res.errors).toEqual([{ code: 'X', reason: 'invalid_code' }])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'DELETE /api/flows/f1?force=1',
      'DELETE /api/flows/f2',
      'POST /api/flows/a/reorder',
      'POST /api/flows/b/reorder',
      'POST /api/flows/import',
    ])
    expect(calls[2]!.body).toEqual({ position: 0 })
    expect(calls[4]!.body).toEqual({ codes: ['X'] })
  })

  it('referencedConfigs lê o 409 flow_referenced', () => {
    const refs = [{ kind: 'connection_flow_config' as const, id: 'c1', name: 'Loja' }]
    expect(
      referencedConfigs(new HttpError(409, 'CONFLICT', 'x', { error_code: 'flow_referenced', references: refs })),
    ).toEqual(refs)
    expect(referencedConfigs(new HttpError(409, 'LIMIT_REACHED', 'x', { limit: 1 }))).toBeNull()
    expect(referencedConfigs(new Error('x'))).toBeNull()
  })
})

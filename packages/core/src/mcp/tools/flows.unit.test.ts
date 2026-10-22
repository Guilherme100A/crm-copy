// Ferramentas MCP de fluxos: catálogo local, visibilidade por acesso/permissão e o mapeamento para as rotas da API.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { blockCatalog, flowsTools } from './flows'
import { registerApiTools, type HttpMethod, type McpApiRequest } from './shared'

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>

function harness(opts: { access?: 'read' | 'write'; perms?: PermissionKey[]; reply?: (method: HttpMethod, path: string) => { status: number; body: unknown } } = {}) {
  const calls: { method: HttpMethod; path: string; req: McpApiRequest | undefined }[] = []
  const handlers = new Map<string, Handler>()
  const annotations = new Map<string, Record<string, unknown>>()
  const server = {
    registerTool: (name: string, cfg: { annotations: Record<string, unknown> }, cb: Handler) => {
      handlers.set(name, cb)
      annotations.set(name, cfg.annotations)
    },
  } as unknown as McpServer
  const names = registerApiTools(
    server,
    {
      access: opts.access ?? 'write',
      perms: new Set(opts.perms ?? ['flows.view', 'flows.edit', 'flows.delete', 'flows.run']),
      api: {
        request: async (method, path, req) => {
          calls.push({ method, path, req })
          return opts.reply?.(method, path) ?? { status: 200, body: { ok: true } }
        },
      },
    },
    flowsTools,
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await handlers.get(name)!(args)
    return { isError: r.isError === true, data: JSON.parse(r.content[0]!.text) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return { names, calls, call, annotations }
}

const FID = '00000000-0000-4000-8000-000000000001'

describe('catálogo de blocos', () => {
  it('lista todos os tipos com ações e handles; por tipo traz exemplo e JSON Schema', () => {
    const all = blockCatalog()!
    expect(all.node_types!.map((t) => t.type)).toContain('payment')
    expect(all.node_types!.find((t) => t.type === 'payment')!.handles).toEqual(expect.arrayContaining(['output:charge_created', 'output:payment_approved']))
    const pixel = blockCatalog('pixel')!
    expect(pixel.actions![0]).toMatchObject({ type: 'send_pixel_event', example_config: expect.any(Object), config_schema: expect.objectContaining({ type: 'object' }) })
    expect(blockCatalog('nao_existe')).toBeNull()
  })
})

describe('visibilidade', () => {
  it('credencial só leitura não vê ferramentas que gravam', () => {
    const { names } = harness({ access: 'read' })
    expect(names).toEqual(expect.arrayContaining(['get_flow', 'validate_flow', 'simulate_flow', 'get_flow_funnel', 'list_flow_runs']))
    expect(names).not.toContain('create_flow')
    expect(names).not.toContain('activate_flow')
  })

  it('sem flows.edit/flows.run não aparecem edição nem disparo; delete marcado como destrutivo', () => {
    const view = harness({ perms: ['flows.view'] }).names
    expect(view).not.toContain('save_flow_definition')
    expect(view).not.toContain('trigger_flow')
    const full = harness()
    expect(full.annotations.get('delete_flow')).toMatchObject({ destructiveHint: true })
    expect(full.annotations.get('get_flow')).toMatchObject({ readOnlyHint: true })
  })
})

describe('mapeamento para a API', () => {
  it('get_flow lê o editor-bundle e anota os handles de cada nó', async () => {
    const h = harness({
      reply: () => ({
        status: 200,
        body: {
          flow: { id: FID, name: 'F' },
          definition: { schema: 'crm.flow/v1', entry: 'start', nodes: [{ id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] }], edges: [], variables: [], refs: {} },
        },
      }),
    })
    const r = await h.call('get_flow', { id: FID })
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: `/api/flows/${FID}/editor-bundle` })
    expect(r.data.definition.nodes[0].handles).toEqual(['source'])
  })

  it('save_flow_definition faz PUT com schema e defaults; marca escrita', async () => {
    const h = harness()
    await h.call('save_flow_definition', { id: FID, definition: { entry: 'start', nodes: [], edges: [] } })
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: `/api/flows/${FID}/definition`, req: { write: true, body: { schema: 'crm.flow/v1', entry: 'start', variables: [], refs: {} } } })
  })

  it('update_flow com folder_id edita e depois move; validate/simulate não marcam escrita', async () => {
    const h = harness()
    await h.call('update_flow', { id: FID, name: 'Novo', folder_id: null })
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH /api/flows/${FID}`, `POST /api/flows/${FID}/move`])
    expect(h.calls[1]!.req!.body).toEqual({ folder_id: null })
    await h.call('simulate_flow', { id: FID, resume: { node_key: 'm', handle: 'option:a' } })
    expect(h.calls[2]).toMatchObject({ method: 'POST', path: `/api/flows/${FID}/simulate`, req: { write: false, body: { resume: { node_key: 'm', handle: 'option:a' } } } })
  })

  it('delete_flow com force, funil com período e erro da API vira isError', async () => {
    const h = harness({ reply: (m) => (m === 'DELETE' ? { status: 409, body: { error: { code: 'CONFLICT' } } } : { status: 200, body: { funnel: {} } }) })
    const del = await h.call('delete_flow', { id: FID, force: true })
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', req: { query: { force: 1 } } })
    expect(del).toMatchObject({ isError: true, data: { status: 409, error: { code: 'CONFLICT' } } })
    await h.call('get_flow_funnel', { id: FID, from: '2026-10-01T00:00:00Z' })
    expect(h.calls[1]).toMatchObject({ method: 'GET', path: `/api/flows/${FID}/funnel`, req: { query: { from: '2026-10-01T00:00:00Z' } } })
  })

  it('connect_nodes e add_flow_node mandam o id como `id`', async () => {
    const h = harness()
    await h.call('add_flow_node', { id: FID, node_id: 'm1', type: 'message', position: { x: 1, y: 2 } })
    await h.call('connect_nodes', { id: FID, from: 'start', handle: 'source', to: 'm1' })
    expect(h.calls[0]!.req!.body).toEqual({ id: 'm1', type: 'message', position: { x: 1, y: 2 } })
    expect(h.calls[1]).toMatchObject({ path: `/api/flows/${FID}/connections`, req: { body: { from: 'start', handle: 'source', to: 'm1' } } })
  })
})

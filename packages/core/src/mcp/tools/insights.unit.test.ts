// Ferramentas MCP de métricas/funil: rota, query e envelope de cada chamada; escrita só com `access = 'write'`;
// cada ferramenta aparece só com a sua permissão; erro da API vira `isError` (cliente MCP real em memória).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { insightsTools } from './insights'
import { registerApiTools, type McpApi, type McpApiRequest, type McpApiResponse } from './shared'

const ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ALL: PermissionKey[] = ['dashboard.sales', 'dashboard.support', 'sales.edit', 'kanban.view', 'kanban.edit', 'facebook.campaigns']
type Call = { method: string; path: string; req: McpApiRequest | undefined }

async function connect(opts: { access?: 'read' | 'write'; perms?: PermissionKey[]; reply?: (c: Call) => McpApiResponse } = {}) {
  const calls: Call[] = []
  const api: McpApi = {
    request: async (method, path, req) => {
      const c = { method, path, req }
      calls.push(c)
      return opts.reply?.(c) ?? { status: 200, body: { ok: true } }
    },
  }
  const server = new McpServer({ name: 't', version: '1' })
  registerApiTools(server, { api, access: opts.access ?? 'write', perms: new Set(opts.perms ?? ALL) }, insightsTools)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'c', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
    const raw = r.content[0]!.text
    let data: unknown = raw
    try {
      data = JSON.parse(raw)
    } catch {
      /* texto puro (erro de validação do SDK) */
    }
    return { isError: r.isError === true, data }
  }
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort()
  return { calls, call, names }
}

describe('insightsTools', () => {
  it('dashboard de vendas e de atendimento: datas, listas em CSV e force_refresh', async () => {
    const { calls, call } = await connect()
    await call('get_sales_metrics', { start_date: '2026-10-01', end_date: '2026-10-20', connection_ids: [ID, ID2], product_ids: [ID], force_refresh: true })
    await call('get_sales_metrics')
    await call('get_attendance_metrics', { start_date: '2026-10-01', end_date: '2026-10-07', connection_ids: [ID] })
    expect(calls).toEqual([
      { method: 'GET', path: '/api/dashboard', req: { query: { start_date: '2026-10-01', end_date: '2026-10-20', connection_ids: `${ID},${ID2}`, product_ids: ID, force_refresh: 1 }, write: false } },
      { method: 'GET', path: '/api/dashboard', req: { query: {}, write: false } },
      { method: 'GET', path: '/api/dashboard/attendance', req: { query: { start_date: '2026-10-01', end_date: '2026-10-07', connection_ids: ID }, write: false } },
    ])
  })

  it('data fora de YYYY-MM-DD é recusada antes de chamar a API', async () => {
    const { calls, call } = await connect()
    const r = await call('get_sales_metrics', { start_date: '01/10/2026' })
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('vendas: lista com filtros, ver, registrar (envelope sale) e excluir', async () => {
    const { calls, call } = await connect()
    await call('list_sales', { status: ['approved', 'refunded'], source: 'flow', page: 2, limit: 50 })
    await call('get_sale', { id: ID })
    await call('record_sale', { amount_cents: 4990, external_id: 'ped-1', product_id: ID })
    await call('delete_sale', { id: ID })
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/sales'],
      ['GET', `/api/sales/${ID}`],
      ['POST', '/api/sales'],
      ['DELETE', `/api/sales/${ID}`],
    ])
    expect(calls[0]!.req).toEqual({ query: { status: 'approved,refunded', source: 'flow', page: 2, limit: 50 }, write: false })
    expect(calls[2]!.req).toEqual({ body: { sale: { amount_cents: 4990, external_id: 'ped-1', product_id: ID } }, write: true })
    expect(calls[3]!.req).toMatchObject({ write: true })
  })

  it('kanban: quadros, funil (stats), cards e mover card', async () => {
    const { calls, call } = await connect()
    await call('list_kanban_boards')
    await call('get_kanban_funnel', { board_id: ID, label_ids: [ID2] })
    await call('list_kanban_cards', { board_id: ID, column_id: ID2, limit: 120 })
    await call('move_kanban_card', { board_id: ID, card_id: ID2, column_id: ID })
    expect(calls).toEqual([
      { method: 'GET', path: '/api/crms', req: { write: false } },
      { method: 'GET', path: `/api/crms/${ID}/stats`, req: { query: { label_ids: ID2 }, write: false } },
      { method: 'GET', path: `/api/crms/${ID}/cards`, req: { query: { column_id: ID2, limit: 120 }, write: false } },
      { method: 'PATCH', path: `/api/crms/${ID}/cards/${ID2}/move`, req: { body: { column_id: ID }, write: true } },
    ])
  })

  it('anúncios: sempre async=1 e repassa o estado "loading" para o cliente reler', async () => {
    const { calls, call } = await connect({ reply: () => ({ status: 202, body: { status: 'loading', campaign: [] } }) })
    const r = await call('get_ad_metrics', { date_preset: '7d', ad_account_ids: ['a1', 'a2'], status_filter: 'all' })
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/meta/structure-bundle', req: { query: { async: 1, date_preset: '7d', status_filter: 'all', ad_account_ids: 'a1,a2' }, write: false } })
    expect(r).toEqual({ isError: false, data: { status: 'loading', campaign: [] } })
  })

  it('credencial só leitura não lista as ferramentas que gravam', async () => {
    const { names } = await connect({ access: 'read' })
    expect(await names()).toEqual(['get_ad_metrics', 'get_attendance_metrics', 'get_kanban_funnel', 'get_sale', 'get_sales_metrics', 'list_kanban_boards', 'list_kanban_cards', 'list_sales'])
  })

  it('cada ferramenta só aparece com a sua permissão', async () => {
    expect(await (await connect({ perms: ['dashboard.support'] })).names()).toEqual(['get_attendance_metrics'])
    expect(await (await connect({ perms: ['kanban.view'] })).names()).toEqual(['get_kanban_funnel', 'list_kanban_boards', 'list_kanban_cards'])
    expect(await (await connect({ perms: ['facebook.campaigns'] })).names()).toEqual(['get_ad_metrics'])
    // Sem nenhuma ferramenta o servidor nem anuncia `tools` (o SDK responde "Method not found").
    await expect((await connect({ perms: [] })).names()).rejects.toThrow(/Method not found/)
  })

  it('erro da API vira isError com status e corpo', async () => {
    const { call } = await connect({ reply: () => ({ status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Intervalo de até 366 dias' } } }) })
    expect(await call('get_sales_metrics', { start_date: '2024-01-01', end_date: '2026-01-01' })).toEqual({
      isError: true,
      data: { status: 422, error: { code: 'VALIDATION_ERROR', message: 'Intervalo de até 366 dias' } },
    })
  })
})

// Ferramentas MCP de pagamentos: rotas e envelope `payment_integration`/`product`; escrita só com `access = 'write'`;
// permissões settings.integrations.* / settings.products.*; erro da API (ex.: 409 com fluxos) vira `isError`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { paymentsTools } from './payments'
import { registerApiTools, type McpApi, type McpApiRequest, type McpApiResponse } from './shared'

const ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ALL: PermissionKey[] = ['settings.integrations.view', 'settings.integrations.edit', 'settings.integrations.delete', 'settings.products.view', 'settings.products.edit']
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
  registerApiTools(server, { api, access: opts.access ?? 'write', perms: new Set(opts.perms ?? ALL) }, paymentsTools)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'c', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
    // Entrada fora do schema volta como texto ("MCP error -32602 …"), não JSON.
    const raw = r.content[0]!.text
    let data: unknown = raw
    try {
      data = JSON.parse(raw)
    } catch {
      /* texto puro */
    }
    return { isError: r.isError === true, data }
  }
  return { client, calls, call }
}

describe('paymentsTools', () => {
  it('integrações de pagamento (XPag): rotas, envelope e teste de conexão', async () => {
    const { calls, call } = await connect()
    await call('list_payment_integrations', { gateway: 'xpag' })
    await call('get_payment_integration', { id: ID })
    await call('create_payment_integration', { label: 'XPag loja', gateway: 'xpag', client_id: 'cid', client_secret: 'sec' })
    await call('update_payment_integration', { id: ID, label: 'XPag 2' })
    await call('test_payment_integration', { id: ID })
    await call('delete_payment_integration', { id: ID })
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/payment-integrations'],
      ['GET', `/api/payment-integrations/${ID}`],
      ['POST', '/api/payment-integrations'],
      ['PUT', `/api/payment-integrations/${ID}`],
      ['POST', `/api/payment-integrations/${ID}/test-connection`],
      ['DELETE', `/api/payment-integrations/${ID}`],
    ])
    expect(calls[0]!.req?.query).toEqual({ gateway: 'xpag' })
    expect(calls[2]!.req?.body).toEqual({ payment_integration: { label: 'XPag loja', gateway: 'xpag', client_id: 'cid', client_secret: 'sec' } })
    // Segredo omitido não vai (mantém o atual).
    expect(calls[3]!.req?.body).toEqual({ payment_integration: { label: 'XPag 2' } })
    expect(calls.slice(2).every((c) => c.req?.write === true)).toBe(true)
  })

  it('gateway fora da lista é recusado antes da API', async () => {
    const { calls, call } = await connect()
    expect((await call('create_payment_integration', { label: 'X', gateway: 'stripe', client_id: 'a', client_secret: 'b' })).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('produtos e fontes de venda', async () => {
    const { calls, call } = await connect()
    await call('list_products', { search: 'curso' })
    await call('get_product', { id: ID })
    await call('create_product', { name: 'Curso', price_min_cents: 4000, price_max_cents: 5000 })
    await call('list_sale_sources')
    await call('get_sale_source', { id: ID })
    await call('list_sale_source_events', { id: ID, status: 'failed', limit: 5 })
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/products'],
      ['GET', `/api/products/${ID}`],
      ['POST', '/api/products'],
      ['GET', '/api/sale-sources'],
      ['GET', `/api/sale-sources/${ID}`],
      ['GET', `/api/sale-sources/${ID}/events`],
    ])
    expect(calls[2]!.req?.body).toEqual({ product: { name: 'Curso', price_min_cents: 4000, price_max_cents: 5000 } })
    expect(calls[5]!.req?.query).toEqual({ status: 'failed', limit: 5 })
  })

  it('leitura sem escrita; permissões filtram por área', async () => {
    const names = async (o: Parameters<typeof connect>[0]) => (await (await connect(o)).client.listTools()).tools.map((t) => t.name).sort()
    expect(await names({ access: 'read' })).toEqual([
      'get_payment_integration',
      'get_product',
      'get_sale_source',
      'list_payment_integrations',
      'list_products',
      'list_sale_source_events',
      'list_sale_sources',
    ])
    expect(await names({ perms: ['settings.products.view'] })).toEqual(['get_product', 'list_products'])
    expect(await names({ perms: ['settings.integrations.view', 'settings.integrations.edit'] })).not.toContain('delete_payment_integration')
  })

  it('409 de chave em uso por fluxo ativo volta como isError com os fluxos', async () => {
    const body = { error: { code: 'CONFLICT', message: 'Chave em uso', details: { flows: [{ id: ID, name: 'Funil' }] } } }
    const { call } = await connect({ reply: () => ({ status: 409, body }) })
    expect(await call('delete_payment_integration', { id: ID })).toEqual({ isError: true, data: { status: 409, ...body } })
  })
})

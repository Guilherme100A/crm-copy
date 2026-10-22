// Ferramentas MCP de pixels/links: rota, método e envelope de cada chamada; escrita só com `access = 'write'`;
// permissão `facebook.pixel` para aparecer; erro da API vira `isError` (cliente MCP real em memória).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { pixelsTools } from './pixels'
import { registerApiTools, type McpApi, type McpApiRequest, type McpApiResponse } from './shared'

const ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
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
  registerApiTools(server, { api, access: opts.access ?? 'write', perms: new Set(opts.perms ?? ['facebook.pixel']) }, pixelsTools)
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

describe('pixelsTools', () => {
  it('chama as rotas certas com o envelope pixel_config', async () => {
    const { calls, call } = await connect()
    await call('list_pixels')
    await call('get_pixel', { id: ID })
    await call('create_pixel', { name: 'Pixel', pixel_id: '123456', access_token: 'EAAB', page_id: '9999' })
    await call('update_pixel', { id: ID, test_event_code: null, name: 'Novo' })
    await call('delete_pixel', { id: ID })
    await call('list_pixel_events', { id: ID, status: 'failed', event_name: 'Purchase', page: 2, limit: 10 })
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/meta/pixels'],
      ['GET', `/api/meta/pixels/${ID}`],
      ['POST', '/api/meta/pixels'],
      ['PUT', `/api/meta/pixels/${ID}`],
      ['DELETE', `/api/meta/pixels/${ID}`],
      ['GET', `/api/meta/pixels/${ID}/events`],
    ])
    expect(calls[2]!.req).toMatchObject({ body: { pixel_config: { name: 'Pixel', pixel_id: '123456', access_token: 'EAAB', page_id: '9999' } }, write: true })
    // null limpa o campo; campos omitidos não vão (access_token ausente mantém o atual).
    expect(calls[3]!.req?.body).toEqual({ pixel_config: { name: 'Novo', test_event_code: null } })
    expect(calls[5]!.req).toMatchObject({ query: { status: 'failed', event_name: 'Purchase', page: 2, limit: 10 }, write: false })
  })

  it('links rastreáveis: CRUD em /api/meta/tracked-links', async () => {
    const { calls, call } = await connect()
    await call('list_tracked_links')
    await call('create_tracked_link', { name: 'Anúncio A', phone: '+5511999999999', code_mode: 'discreet' })
    await call('update_tracked_link', { id: ID, active: false })
    await call('delete_tracked_link', { id: ID })
    expect(calls.map((c) => [c.method, c.path, c.req?.body])).toEqual([
      ['GET', '/api/meta/tracked-links', undefined],
      ['POST', '/api/meta/tracked-links', { name: 'Anúncio A', phone: '+5511999999999', code_mode: 'discreet' }],
      ['PUT', `/api/meta/tracked-links/${ID}`, { active: false }],
      ['DELETE', `/api/meta/tracked-links/${ID}`, undefined],
    ])
  })

  it('credencial só leitura não lista as ferramentas que gravam', async () => {
    const { client } = await connect({ access: 'read' })
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['get_pixel', 'list_pixel_events', 'list_pixels', 'list_tracked_links'])
    const { client: w } = await connect()
    const del = (await w.listTools()).tools.find((t) => t.name === 'delete_pixel')
    expect(del?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
  })

  it('sem facebook.pixel nenhuma ferramenta é registrada', () => {
    const api: McpApi = { request: async () => ({ status: 200, body: {} }) }
    const names = registerApiTools(new McpServer({ name: 't', version: '1' }), { api, access: 'write', perms: new Set(['flows.view']) }, pixelsTools)
    expect(names).toEqual([])
  })

  it('erro da API vira isError com o corpo da API; entrada inválida nem chama a API', async () => {
    const { calls, call } = await connect({ reply: () => ({ status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos' } } }) })
    const r = await call('create_pixel', { name: 'Pixel', pixel_id: '123', access_token: 'x' })
    expect(r).toEqual({ isError: true, data: { status: 422, error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos' } } })
    const bad = await call('create_pixel', { name: 'Pixel', pixel_id: 'abc', access_token: 'x' })
    expect(bad.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

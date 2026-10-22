// Ferramentas MCP de conversas: rota, query e corpo de cada chamada; mensagens enxutas (mídia sem blob); escrita só
// com `access = 'write'`; permissão por ferramenta; erro da API vira `isError` (cliente MCP real em memória).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { conversationsTools } from './conversations'
import { registerApiTools, type McpApi, type McpApiRequest, type McpApiResponse } from './shared'

const ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ALL: PermissionKey[] = ['chat.view', 'flows.view', 'settings.labels.view']
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
  registerApiTools(server, { api, access: opts.access ?? 'write', perms: new Set(opts.perms ?? ALL) }, conversationsTools)
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

describe('conversationsTools', () => {
  it('lista e contadores: filtros escalares e listas em CSV', async () => {
    const { calls, call } = await connect()
    await call('list_conversations', { status: 'waiting', response_status: 'unanswered', label_ids: [ID, ID2], connection_ids: [ID], cursor: 'abc', limit: 50 })
    await call('get_conversation_counts', { assigned_to: 'none', department_ids: [ID2] })
    expect(calls).toEqual([
      { method: 'GET', path: '/api/chats', req: { query: { status: 'waiting', response_status: 'unanswered', label_ids: `${ID},${ID2}`, connection_ids: ID, cursor: 'abc', limit: 50 }, write: false } },
      { method: 'GET', path: '/api/chats/counts', req: { query: { assigned_to: 'none', department_ids: ID2 }, write: false } },
    ])
  })

  it('leitura da conversa: chat, notas, linha do tempo, fluxos e etiquetas', async () => {
    const { calls, call } = await connect()
    await call('get_conversation', { id: ID })
    await call('get_conversation_notes', { id: ID })
    await call('get_conversation_timeline', { id: ID })
    await call('get_conversation_flow_runs', { id: ID, active_only: true })
    await call('list_labels')
    expect(calls).toEqual([
      { method: 'GET', path: `/api/chats/${ID}`, req: { write: false } },
      { method: 'GET', path: `/api/chats/${ID}/notes`, req: { write: false } },
      { method: 'GET', path: `/api/chats/${ID}/events`, req: { write: false } },
      { method: 'GET', path: `/api/chats/${ID}/flow-runs`, req: { query: { active: 1 }, write: false } },
      { method: 'GET', path: '/api/labels', req: { write: false } },
    ])
  })

  it('mensagens: before/limit e corpo enxuto (mídia só com metadados curtos)', async () => {
    const blob = 'A'.repeat(5000)
    const { calls, call } = await connect({
      reply: () => ({
        status: 200,
        body: {
          items: [
            {
              id: ID,
              chat_id: ID2,
              direction: 'inbound',
              sender_type: 'contact',
              sender_user_id: null,
              type: 'image',
              wa_type: 'imageMessage',
              body: 'olha',
              media: { mime_type: 'image/jpeg', size: 1234, thumbnail: blob, nested: { a: 1 } },
              quoted_wa_message_id: null,
              status: 'received',
              error: null,
              wa_message_id: 'X',
              pipeline_message_id: null,
              historical: false,
              deleted_at: null,
              wa_timestamp: '2026-10-20T10:00:00.000Z',
              created_at: '2026-10-20T10:00:01.000Z',
              reactions: [],
            },
          ],
          next_cursor: ID,
        },
      }),
    })
    const r = await call('get_conversation_messages', { id: ID2, before: ID, limit: 30 })
    expect(calls[0]).toEqual({ method: 'GET', path: `/api/chats/${ID2}/messages`, req: { query: { before: ID, limit: 30 }, write: false } })
    expect(r).toEqual({
      isError: false,
      data: {
        items: [
          {
            id: ID,
            direction: 'inbound',
            sender_type: 'contact',
            type: 'image',
            body: 'olha',
            media: { mime_type: 'image/jpeg', size: 1234 },
            status: 'received',
            wa_timestamp: '2026-10-20T10:00:00.000Z',
            created_at: '2026-10-20T10:00:01.000Z',
          },
        ],
        next_cursor: ID,
      },
    })
  })

  it('escrita: enviar texto, nota, alterar, resolver, atribuir/desatribuir e etiquetar', async () => {
    const { calls, call } = await connect()
    await call('send_message', { id: ID, text: 'Oi!', client_message_id: 'k1' })
    await call('add_conversation_note', { id: ID, body: 'ligar amanhã' })
    await call('update_conversation', { id: ID, department_id: null, crm_id: ID2, crm_column_id: ID })
    await call('set_conversation_status', { id: ID, action: 'resolve' })
    await call('assign_conversation', { id: ID, user_id: ID2 })
    await call('assign_conversation', { id: ID, user_id: null })
    await call('label_conversation', { id: ID, label_id: ID2, action: 'add' })
    await call('label_conversation', { id: ID, label_id: ID2, action: 'remove' })
    expect(calls).toEqual([
      { method: 'POST', path: `/api/chats/${ID}/messages`, req: { body: { type: 'text', text: 'Oi!', client_message_id: 'k1' }, write: true } },
      { method: 'POST', path: `/api/chats/${ID}/notes`, req: { body: { body: 'ligar amanhã' }, write: true } },
      { method: 'PATCH', path: `/api/chats/${ID}`, req: { body: { department_id: null, crm_id: ID2, crm_column_id: ID }, write: true } },
      { method: 'POST', path: `/api/chats/${ID}/resolve`, req: { write: true } },
      { method: 'POST', path: `/api/chats/${ID}/assign`, req: { body: { user_id: ID2 }, write: true } },
      { method: 'POST', path: `/api/chats/${ID}/unassign`, req: { write: true } },
      { method: 'POST', path: `/api/chats/${ID}/labels`, req: { body: { label_id: ID2 }, write: true } },
      { method: 'DELETE', path: `/api/chats/${ID}/labels/${ID2}`, req: { write: true } },
    ])
  })

  it('update_conversation sem campo nenhum não chama a API', async () => {
    const { calls, call } = await connect()
    expect((await call('update_conversation', { id: ID })).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('id fora do formato uuid é recusado (sem montar caminho com ele)', async () => {
    const { calls, call } = await connect()
    expect((await call('get_conversation', { id: '../admin' })).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('credencial só leitura não lista as que gravam; permissão filtra cada uma', async () => {
    expect(await (await connect({ access: 'read' })).names()).toEqual([
      'get_conversation',
      'get_conversation_counts',
      'get_conversation_flow_runs',
      'get_conversation_messages',
      'get_conversation_notes',
      'get_conversation_timeline',
      'list_conversations',
      'list_labels',
    ])
    expect(await (await connect({ access: 'read', perms: ['flows.view'] })).names()).toEqual(['get_conversation_flow_runs'])
  })

  it('erro da API vira isError (ex.: conexão desconectada no envio)', async () => {
    const { call } = await connect({ reply: () => ({ status: 409, body: { error: { code: 'SESSION_NOT_CONNECTED', message: 'Conexão desconectada' } } }) })
    expect(await call('send_message', { id: ID, text: 'oi' })).toEqual({
      isError: true,
      data: { status: 409, error: { code: 'SESSION_NOT_CONNECTED', message: 'Conexão desconectada' } },
    })
  })
})

// Servidor MCP (T94; 09 §3.4): Streamable HTTP SEM sessão (um McpServer + transporte por request), sempre filtrado
// pela empresa do token. Respostas em JSON (`enableJsonResponse`), sem SSE. As 5 ferramentas da T94 leem o banco
// direto. Com `ctx.api` (credencial com usuário dono), entram as ferramentas de `./tools` (pixels, pagamentos, fluxos,
// funil, vendas, conversas e métricas), que chamam a API como esse usuário; as que gravam só com `access = 'write'`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { and, asc, desc, eq, ilike, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { CHAT_STATUSES, chats, connections, contacts, FLOW_STATUSES, flows, type Database } from '@crm/db'
import { registerAllApiTools } from './tools/index'
import type { McpApiContext } from './tools/shared'

export const MCP_SERVER_INFO = { name: 'leonas-crm', version: '1.0.0' } as const
/** Ferramentas da T94 (todas `readOnlyHint`), sempre presentes. */
export const MCP_TOOL_NAMES = ['list_contacts', 'get_contact', 'list_connections', 'list_flows', 'list_chats'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const page = { limit: z.number().int().min(1).max(100).optional().describe('Máximo de itens (1–100, padrão 20)'), offset: z.number().int().min(0).optional().describe('Itens a pular') }
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] })

export interface McpContext {
  db: Database
  companyId: string
  /** Chamada à API como o usuário dono da credencial; ausente → só as ferramentas da T94. */
  api?: McpApiContext
}

/** McpServer com as ferramentas de leitura da empresa. */
export function createMcpServer(ctx: McpContext): McpServer {
  const { db, companyId } = ctx
  const instructions = !ctx.api
    ? 'Leitura dos dados da empresa no CRM (contatos, conexões, fluxos e chats). Nenhuma ferramenta altera dados.'
    : ctx.api.access === 'write'
      ? 'CRM da empresa: contatos, conversas, fluxos (criar, editar, validar, simular, ativar), funil, vendas, pixels da Meta, integrações de pagamento (XPag) e métricas. Ações rodam com as permissões do usuário dono da credencial. Antes de editar um fluxo, leia-o com get_flow e consulte get_flow_block_catalog; valide antes de ativar.'
      : 'Leitura do CRM da empresa: contatos, conversas, fluxos, funil, vendas, pixels, integrações de pagamento e métricas, com as permissões do usuário dono da credencial. Credencial só leitura: nada é alterado.'
  const server = new McpServer(MCP_SERVER_INFO, { instructions })

  server.registerTool(
    'list_contacts',
    { title: 'Listar contatos', description: 'Contatos da empresa, mais recentes primeiro; busca por nome, telefone ou e-mail.', inputSchema: { search: z.string().max(200).optional(), ...page }, annotations: READ_ONLY },
    async ({ search, limit, offset }) => {
      const where: SQL[] = [eq(contacts.companyId, companyId)]
      const q = search?.trim()
      if (q) where.push(or(ilike(contacts.name, like(q)), ilike(contacts.phoneE164, like(q)), ilike(contacts.email, like(q)))!)
      const rows = await db
        .select({ id: contacts.id, name: contacts.name, phone: contacts.phoneE164, email: contacts.email, created_at: contacts.createdAt })
        .from(contacts)
        .where(and(...where))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(limit ?? 20)
        .offset(offset ?? 0)
      return json({ contacts: rows.map((r) => ({ ...r, created_at: iso(r.created_at) })) })
    },
  )

  server.registerTool(
    'get_contact',
    { title: 'Ver contato', description: 'Um contato da empresa pelo id.', inputSchema: { id: z.string().describe('id do contato') }, annotations: READ_ONLY },
    async ({ id }) => {
      const [c] = UUID_RE.test(id) ? await db.select().from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.id, id))).limit(1) : []
      if (!c) return { ...json({ error: 'not_found' }), isError: true }
      return json({
        contact: {
          id: c.id,
          name: c.name,
          phone: c.phoneE164,
          email: c.email,
          state: c.state,
          city: c.city,
          custom_fields: c.customFields,
          opt_out: c.optOut,
          origin: c.origin,
          created_at: iso(c.createdAt),
          updated_at: iso(c.updatedAt),
        },
      })
    },
  )

  server.registerTool(
    'list_connections',
    { title: 'Listar conexões', description: 'Conexões de WhatsApp da empresa e o estado de cada uma.', annotations: READ_ONLY },
    async () => {
      const rows = await db
        .select({ id: connections.id, name: connections.name, phone_number: connections.phoneNumber, state: connections.connectionState, connected_at: connections.connectedAt })
        .from(connections)
        .where(eq(connections.companyId, companyId))
        .orderBy(asc(connections.createdAt), asc(connections.id))
      return json({ connections: rows.map((r) => ({ ...r, connected_at: iso(r.connected_at) })) })
    },
  )

  server.registerTool(
    'list_flows',
    { title: 'Listar fluxos', description: 'Fluxos de automação da empresa; filtro por status e busca por nome.', inputSchema: { status: z.enum(FLOW_STATUSES).optional(), search: z.string().max(200).optional(), ...page }, annotations: READ_ONLY },
    async ({ status, search, limit, offset }) => {
      const where: SQL[] = [eq(flows.companyId, companyId)]
      if (status) where.push(eq(flows.status, status))
      if (search?.trim()) where.push(ilike(flows.name, like(search.trim())))
      const rows = await db
        .select({ id: flows.id, name: flows.name, description: flows.description, status: flows.status, updated_at: flows.updatedAt })
        .from(flows)
        .where(and(...where))
        .orderBy(desc(flows.updatedAt), desc(flows.id))
        .limit(limit ?? 20)
        .offset(offset ?? 0)
      return json({ flows: rows.map((r) => ({ ...r, updated_at: iso(r.updated_at) })) })
    },
  )

  server.registerTool(
    'list_chats',
    { title: 'Listar chats', description: 'Resumo dos chats da empresa (contato, status, não lidas e prévia da última mensagem), mais recentes primeiro.', inputSchema: { status: z.enum(CHAT_STATUSES).optional(), ...page }, annotations: READ_ONLY },
    async ({ status, limit, offset }) => {
      const where: SQL[] = [eq(chats.companyId, companyId)]
      if (status) where.push(eq(chats.status, status))
      const rows = await db
        .select({
          id: chats.id,
          status: chats.status,
          connection_id: chats.connectionId,
          contact_id: contacts.id,
          contact_name: contacts.name,
          contact_phone: contacts.phoneE164,
          unread_count: chats.unreadCount,
          last_message_preview: chats.lastMessagePreview,
          last_message_at: chats.lastMessageAt,
        })
        .from(chats)
        .innerJoin(contacts, and(eq(contacts.id, chats.contactId), eq(contacts.companyId, companyId)))
        .where(and(...where))
        .orderBy(desc(chats.lastMessageAt), desc(chats.id))
        .limit(limit ?? 20)
        .offset(offset ?? 0)
      return json({
        chats: rows.map((r) => ({
          id: r.id,
          status: r.status,
          connection_id: r.connection_id,
          contact: { id: r.contact_id, name: r.contact_name, phone: r.contact_phone },
          unread_count: r.unread_count,
          last_message_preview: r.last_message_preview,
          last_message_at: iso(r.last_message_at),
        })),
      })
    },
  )

  if (ctx.api) registerAllApiTools(server, ctx.api)
  return server
}

/** Atende um request MCP (Streamable HTTP, sem sessão) para a empresa do token. */
export async function handleMcpRequest(req: Request, ctx: McpContext): Promise<Response> {
  const server = createMcpServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(req)
  } finally {
    await server.close()
  }
}

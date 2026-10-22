// Base das ferramentas MCP que passam pela API do CRM (`McpApi`): cada chamada roda como o usuário dono da credencial,
// então a rota aplica a mesma validação, permissão, auditoria e realtime do painel. Ferramenta `write` só aparece em
// credencial `access = 'write'`; ferramenta com `perm` só aparece para quem tem a permissão (a rota confere de novo).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PermissionKey } from '@crm/shared'
import { z, type ZodRawShape } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface McpApiRequest {
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  /** A chamada grava. Recusada (sem chegar na rota) em credencial só leitura. */
  write?: boolean
}

export interface McpApiResponse {
  status: number
  body: unknown
}

/** Chamada interna à API do CRM em nome do usuário da credencial (implementada em `apps/api`). */
export interface McpApi {
  request(method: HttpMethod, path: string, req?: McpApiRequest): Promise<McpApiResponse>
}

export interface McpApiContext {
  api: McpApi
  access: 'read' | 'write'
  perms: ReadonlySet<PermissionKey>
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const

export const UUID = z.uuid()
export const page = {
  page: z.number().int().min(1).optional().describe('Página (1 = primeira)'),
  limit: z.number().int().min(1).max(100).optional().describe('Itens por página (1–100)'),
}

type CallResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export const text = (data: unknown): CallResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
export const fail = (data: unknown): CallResult => ({ ...text(data), isError: true })

/** Resposta da API → resultado MCP: 2xx vira conteúdo; erro devolve o corpo da API (código, mensagem, campos). */
export function fromApi(res: McpApiResponse): CallResult {
  if (res.status >= 200 && res.status < 300) return text(res.body ?? { ok: true })
  return fail({ status: res.status, ...(res.body && typeof res.body === 'object' ? res.body : { error: res.body }) })
}

export interface ToolSpec<S extends ZodRawShape> {
  name: string
  title: string
  description: string
  input?: S
  /** Permissão exigida para a ferramenta aparecer (qualquer uma da lista). */
  perm?: PermissionKey | readonly PermissionKey[]
  kind?: 'read' | 'write' | 'destructive'
  run: (args: z.infer<z.ZodObject<S>>, api: McpApi) => Promise<CallResult>
}

/** Registra as ferramentas visíveis para o contexto; devolve os nomes registrados. */
export function registerApiTools(server: McpServer, ctx: McpApiContext, tools: readonly ToolSpec<ZodRawShape>[]): string[] {
  const names: string[] = []
  for (const t of tools) {
    const kind = t.kind ?? 'read'
    if (kind !== 'read' && ctx.access !== 'write') continue
    const perms = t.perm === undefined ? [] : typeof t.perm === 'string' ? [t.perm] : t.perm
    if (perms.length > 0 && !perms.some((p) => ctx.perms.has(p))) continue
    const annotations = kind === 'read' ? READ : kind === 'write' ? WRITE : DESTRUCTIVE
    const api: McpApi = {
      // Defesa extra: ferramenta de leitura nunca grava, mesmo que a rota aceite.
      request: (method, path, req) => ctx.api.request(method, path, { ...req, write: kind !== 'read' && (req?.write ?? true) }),
    }
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input ?? {}, annotations }, ((args: never) =>
      t.run(args ?? ({} as never), api)) as never)
    names.push(t.name)
  }
  return names
}

/** Ajuda a tipar a lista de ferramentas mantendo a inferência dos argumentos de cada uma. */
export function tool<S extends ZodRawShape>(spec: ToolSpec<S>): ToolSpec<ZodRawShape> {
  return spec as unknown as ToolSpec<ZodRawShape>
}

/** Remove `undefined` (a API não recebe chaves vazias). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

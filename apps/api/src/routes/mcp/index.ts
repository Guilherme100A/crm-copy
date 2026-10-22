// Servidor MCP (SPEC T94; 09 §3.4, §6). Credenciais (`settings.mcp.view|edit|delete`):
//   GET /api/mcp_credentials → { mcp_credentials, mcp_endpoint_url }; POST → { mcp_credential, token, mcp_endpoint_url }
//   (token mostrado só aqui); DELETE /api/mcp_credentials/:id revoga na hora.
// Endpoint MCP `/api/mcp` (rota pública para a sessão e fora do CSRF): `Authorization: Bearer <token>` da credencial;
// inválido/expirado/revogado → 401. Streamable HTTP sem sessão, ferramentas somente leitura da empresa do token.
// T115: `/api/mcp/<credencial>` é a URL do conector OAuth (aceita só tokens dessa credencial) e o 401 traz
// `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<API>/.well-known/oauth-protected-resource/api/mcp[/<id>]"`.
// Credencial com usuário dono (criador do token ou quem autorizou o OAuth) e ainda membro da empresa: entram as
// ferramentas que chamam esta mesma API (`app.fetch` com `MCP_ACTOR`) com as permissões dele; gravar exige
// `access = 'write'`.
import {
  findMembership,
  handleMcpRequest,
  McpCredentialsError,
  McpCredentialsService,
  McpOAuthService,
  permissionsOf,
  type McpApi,
  type McpApiContext,
  type McpAuth,
} from '@crm/core'
import { companies, users, type Database } from '@crm/db'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { MCP_ACTOR, type McpActor } from '../../lib/mcp-actor'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { parseBearer } from '../../middleware/auth'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** `API_PUBLIC_URL` da URL do servidor MCP (default `process.env`). */
    mcpEnv?: Record<string, string | undefined>
  }
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof McpCredentialsError)) throw err
    if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
    throw new ApiError('VALIDATION_ERROR', err.message, err.details)
  }
}

/** Corpo plano ou envelopado em `{ mcp_credential: {...} }`. */
async function body(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
  return json && typeof json === 'object' && !Array.isArray(json) && 'mcp_credential' in json ? (json as { mcp_credential: unknown }).mcp_credential : json
}

/** Quem atende a chamada interna: o app raiz (todas as rotas e middlewares). */
export interface McpInternalApp {
  fetch(req: Request, env?: unknown): Response | Promise<Response>
}

/** Só leitura, mas por POST: validar e simular fluxo. */
const READ_ONLY_POST = /^\/api\/flows\/[^/]+\/(validate|simulate)$/
const INTERNAL_ORIGIN = 'http://mcp.internal'

const refused = (message: string) => ({ status: 403, body: { error: { code: 'FORBIDDEN', message } } })

/** Ator da credencial; `null` sem usuário dono ou se ele saiu da empresa (sobram as ferramentas da T94). */
async function loadActor(db: Database, auth: McpAuth): Promise<McpActor | null> {
  if (!auth.userId) return null
  const member = await findMembership(db, auth.userId, auth.companyId)
  if (!member) return null
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, systemRole: users.systemRole, locale: users.locale, lastCompanyId: users.lastCompanyId })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1)
  if (!user) return null
  return { user, companyId: auth.companyId, member, perms: permissionsOf(member, user), credentialId: auth.credentialId }
}

export function internalApi(app: McpInternalApp, actor: McpActor, access: McpAuth['access']): McpApi {
  return {
    async request(method, path, req = {}) {
      if (!path.startsWith('/api/') || path.startsWith('/api/mcp') || path.startsWith('/api/events')) return refused('Rota fora do MCP')
      if (req.write && access !== 'write') return refused('Credencial MCP só leitura: crie uma credencial com escrita')
      if (method !== 'GET' && !req.write && !READ_ONLY_POST.test(path)) return refused('Ferramenta de leitura não grava')
      const url = new URL(path, INTERNAL_ORIGIN)
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      const init: RequestInit = { method, headers: { accept: 'application/json' } }
      if (req.body !== undefined && method !== 'GET') {
        init.body = JSON.stringify(req.body)
        init.headers = { ...init.headers, 'content-type': 'application/json' }
      }
      const res = await app.fetch(new Request(url, init), { [MCP_ACTOR]: actor })
      const raw = await res.text()
      let body: unknown = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw.slice(0, 2000)
        }
      }
      return { status: res.status, body }
    },
  }
}

export function mcpRoutes(deps: ResolvedDeps, root?: McpInternalApp) {
  const svc = new McpCredentialsService({ db: deps.db, ...(deps.mcpEnv ? { env: deps.mcpEnv } : {}) })
  const app = new Hono<AppEnv>()

  app.get('/api/mcp_credentials', requirePerm('settings.mcp.view'), async (c) =>
    c.json({ mcp_credentials: await svc.list(getCompanyCtx(c).companyId), mcp_endpoint_url: svc.endpointUrl() }, 200),
  )

  app.post('/api/mcp_credentials', requirePerm('settings.mcp.edit'), async (c) => {
    const ctx = getCompanyCtx(c)
    const { credential, token } = await domain(async () => svc.create(ctx.companyId, await body(c), ctx.user?.id ?? null))
    setAudit(c, { action: 'mcp_credentials.create', targetType: 'mcp_credential', targetId: credential.id, detail: { name: credential.name } })
    return c.json({ mcp_credential: credential, token, mcp_endpoint_url: svc.endpointUrl() }, 201)
  })

  app.delete('/api/mcp_credentials/:id', requirePerm('settings.mcp.delete'), async (c) => {
    const ctx = getCompanyCtx(c)
    const credential = await domain(() => svc.revoke(ctx.companyId, c.req.param('id')))
    setAudit(c, { action: 'mcp_credentials.revoke', targetType: 'mcp_credential', targetId: credential.id, detail: { name: credential.name } })
    return c.json({ ok: true }, 200)
  })

  const oauth = new McpOAuthService({ db: deps.db, ...(deps.mcpEnv ? { env: deps.mcpEnv } : {}) })
  const serveMcp = async (c: Context<AppEnv>, credentialId: string | null) => {
    const auth = await svc.authenticate(parseBearer(c.req.header('authorization')))
    if (!auth || (credentialId !== null && auth.credentialId !== credentialId)) {
      c.header('WWW-Authenticate', `Bearer realm="mcp", resource_metadata="${oauth.resourceMetadataUrl(credentialId)}"`)
      throw new ApiError('UNAUTHORIZED', 'Token MCP inválido, expirado ou revogado')
    }
    const [company] = await deps.db.select({ active: companies.active }).from(companies).where(eq(companies.id, auth.companyId)).limit(1)
    if (company && !company.active) throw new ApiError('FORBIDDEN', 'Empresa desativada', { error_code: 'company_inactive' })
    const actor = root ? await loadActor(deps.db, auth) : null
    const api: McpApiContext | undefined =
      actor && root ? { api: internalApi(root, actor, auth.access), access: auth.access, perms: actor.perms } : undefined
    return handleMcpRequest(c.req.raw, { db: deps.db, companyId: auth.companyId, ...(api ? { api } : {}) })
  }

  app.all('/api/mcp', (c) => serveMcp(c, null))
  // T115: URL do conector OAuth; id fora do formato UUID cai no 401 com os metadados genéricos.
  app.all('/api/mcp/:credentialId', (c) => {
    const id = c.req.param('credentialId')
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? serveMcp(c, id) : serveMcp(c, '')
  })

  return app
}

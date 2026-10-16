// Servidor MCP (SPEC T94; 09 §3.4, §6). Credenciais (`settings.mcp.view|edit|delete`):
//   GET /api/mcp_credentials → { mcp_credentials, mcp_endpoint_url }; POST → { mcp_credential, token, mcp_endpoint_url }
//   (token mostrado só aqui); DELETE /api/mcp_credentials/:id revoga na hora.
// Endpoint MCP `/api/mcp` (rota pública para a sessão e fora do CSRF): `Authorization: Bearer <token>` da credencial;
// inválido/expirado/revogado → 401. Streamable HTTP sem sessão, ferramentas somente leitura da empresa do token.
import { handleMcpRequest, McpCredentialsError, McpCredentialsService } from '@crm/core'
import { companies } from '@crm/db'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
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

export function mcpRoutes(deps: ResolvedDeps) {
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

  app.all('/api/mcp', async (c) => {
    const auth = await svc.authenticate(parseBearer(c.req.header('authorization')))
    if (!auth) {
      c.header('WWW-Authenticate', 'Bearer realm="mcp"')
      throw new ApiError('UNAUTHORIZED', 'Token MCP inválido, expirado ou revogado')
    }
    const [company] = await deps.db.select({ active: companies.active }).from(companies).where(eq(companies.id, auth.companyId)).limit(1)
    if (company && !company.active) throw new ApiError('FORBIDDEN', 'Empresa desativada', { error_code: 'company_inactive' })
    return handleMcpRequest(c.req.raw, { db: deps.db, companyId: auth.companyId })
  })

  return app
}

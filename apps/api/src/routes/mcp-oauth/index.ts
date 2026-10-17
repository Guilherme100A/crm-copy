// OAuth 2.1 do servidor MCP (SPEC T115; 09 §3.4, §4, §5 item 9). Rotas em Hono sobre o `McpOAuthService` (o roteador
// de auth do SDK é Express; daqui só os schemas). Públicas (sem sessão e fora do CSRF, com CORS para clientes web):
//   GET  /.well-known/oauth-authorization-server              → metadados RFC 8414
//   GET  /.well-known/oauth-protected-resource[/api/mcp[/:id]] → metadados RFC 9728 (genérico ou do conector)
//   POST /api/mcp-oauth/register  → 201 cliente (RFC 7591)
//   GET  /api/mcp-oauth/authorize → 302 para `<WEB>/oauth/consent?request=<id>` (ou de volta ao cliente com `error`)
//   POST /api/mcp-oauth/token     → authorization_code (PKCE S256) | refresh_token (rotação; reuso revoga a família)
//   POST /api/mcp-oauth/revoke    → 200 (RFC 7009; revoga a conexão do token)
// Com sessão (tela de consentimento): GET /api/mcp-oauth/consent?request=<id> e POST /api/mcp-oauth/consent
// `{ request, company_id, approve }` → `{ redirect_to }`. Erros OAuth no formato `{ error, error_description }`.
// Segredos (code, tokens, client_secret) só na query do redirect ao cliente ou no corpo: nunca no caminho (logger).
import {
  McpOAuthConsentError,
  McpOAuthError,
  McpOAuthService,
  MCP_OAUTH_PATHS,
  type ClientCredentials,
} from '@crm/core'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { clientIp, getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

function oauthError(c: Context<AppEnv>, err: unknown): Response {
  if (!(err instanceof McpOAuthError)) throw err
  if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="mcp-oauth"')
  return c.json(err.toJSON(), err.status as 400 | 401, NO_STORE)
}

function consentError(err: unknown): never {
  if (!(err instanceof McpOAuthConsentError)) throw err
  if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
  if (err.code === 'forbidden') throw new ApiError('FORBIDDEN', err.message)
  throw new ApiError('VALIDATION_ERROR', err.message, { fields: [{ path: 'company_id', message: err.message }] })
}

/** `Authorization: Basic base64(urlencode(id):urlencode(secret))` (RFC 6749 §2.3.1). */
function basicCredentials(header: string | undefined): ClientCredentials {
  const m = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i)
  if (!m) return {}
  try {
    const raw = Buffer.from(m[1]!, 'base64').toString('utf8')
    const i = raw.indexOf(':')
    if (i < 0) return {}
    return { clientId: decodeURIComponent(raw.slice(0, i)), clientSecret: decodeURIComponent(raw.slice(i + 1)) }
  } catch {
    return {}
  }
}

/** Corpo `application/x-www-form-urlencoded` (padrão OAuth) ou JSON. */
async function formBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? ''
  try {
    if (type.includes('application/json')) {
      const json: unknown = await c.req.json()
      return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
    }
    const body = await c.req.parseBody()
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string'))
  } catch {
    throw new McpOAuthError('invalid_request', 'Corpo inválido')
  }
}

/** Usuário da sessão (a tela de consentimento não aceita token de API). */
function sessionUser(c: Context<AppEnv>) {
  const ctx = getCtx(c)
  if (!ctx.user || ctx.auth.kind !== 'session')
    throw new ApiError('FORBIDDEN', 'A autorização exige login no navegador')
  return ctx.user
}

export function mcpOAuthRoutes(deps: ResolvedDeps) {
  const svc = new McpOAuthService({ db: deps.db, ...(deps.mcpEnv ? { env: deps.mcpEnv } : {}) })
  const app = new Hono<AppEnv>()
  const open = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
    maxAge: 86_400,
  })
  app.use('/.well-known/oauth-authorization-server', open)
  app.use('/.well-known/oauth-protected-resource', open)
  app.use('/.well-known/oauth-protected-resource/*', open)
  for (const path of [MCP_OAUTH_PATHS.register, MCP_OAUTH_PATHS.token, MCP_OAUTH_PATHS.revoke]) app.use(path, open)

  app.get('/.well-known/oauth-authorization-server', (c) => c.json(svc.authorizationServerMetadata(), 200))
  app.get('/.well-known/oauth-protected-resource', async (c) => c.json(await svc.protectedResourceMetadata(), 200))
  app.get('/.well-known/oauth-protected-resource/api/mcp', async (c) =>
    c.json(await svc.protectedResourceMetadata(), 200),
  )
  app.get('/.well-known/oauth-protected-resource/api/mcp/:credentialId', async (c) => {
    const meta = await svc.protectedResourceMetadata(c.req.param('credentialId'))
    return meta
      ? c.json(meta, 200)
      : c.json({ error: 'not_found', error_description: 'Credencial OAuth não encontrada' }, 404)
  })

  app.post(MCP_OAUTH_PATHS.register, async (c) => {
    try {
      let input: unknown
      try {
        input = await c.req.json()
      } catch {
        throw new McpOAuthError('invalid_client_metadata', 'JSON inválido')
      }
      return c.json(await svc.register(input), 201, NO_STORE)
    } catch (err) {
      return oauthError(c, err)
    }
  })

  app.get(MCP_OAUTH_PATHS.authorize, async (c) => {
    try {
      const { location } = await svc.authorize(c.req.query())
      return c.redirect(location, 302)
    } catch (err) {
      return oauthError(c, err)
    }
  })

  app.post(MCP_OAUTH_PATHS.token, async (c) => {
    try {
      return c.json(await svc.token(await formBody(c), basicCredentials(c.req.header('authorization'))), 200, NO_STORE)
    } catch (err) {
      return oauthError(c, err)
    }
  })

  app.post(MCP_OAUTH_PATHS.revoke, async (c) => {
    try {
      await svc.revoke(await formBody(c), basicCredentials(c.req.header('authorization')))
      return c.json({}, 200, NO_STORE)
    } catch (err) {
      return oauthError(c, err)
    }
  })

  app.get(MCP_OAUTH_PATHS.consent, async (c) => {
    const user = sessionUser(c)
    const info = await svc.consentInfo(user, c.req.query('request')).catch(consentError)
    return c.json({ authorization_request: info }, 200, NO_STORE)
  })

  app.post(MCP_OAUTH_PATHS.consent, async (c) => {
    const user = sessionUser(c)
    let body: Record<string, unknown>
    try {
      const json: unknown = await c.req.json()
      body = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
    } catch {
      throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
    }
    const r = await svc.decide(user, body).catch(consentError)
    // A empresa auditada é a da credencial (pode não ser a empresa ativa da sessão).
    setAudit(c, { skip: true })
    await deps.audit.record({
      companyId: r.company_id,
      actorUserId: user.id,
      action: r.approved ? 'mcp_oauth.approve' : 'mcp_oauth.deny',
      targetType: 'mcp_credential',
      targetId: r.credential_id,
      detail: { request_id: c.get('requestId'), client_id: r.client_id },
      ip: clientIp(c, deps.trustProxy),
    })
    return c.json({ redirect_to: r.redirect_to }, 200, NO_STORE)
  })

  return app
}

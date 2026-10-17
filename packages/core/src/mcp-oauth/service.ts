// Servidor de autorização OAuth 2.1 do endpoint MCP (T115; 09 §3.4, §4, §5 item 9). Implementado sobre os schemas do
// `@modelcontextprotocol/sdk` (o roteador de auth do SDK é Express; a API é Hono e só chama este serviço).
//
// Vínculo cliente ↔ credencial: a URL do conector é `<API>/api/mcp/<credentialId>` (credencial `oauth`). O cliente a
// recebe como `resource` (RFC 8707) e o `/authorize` liga o pedido à credencial e à empresa dela; o consentimento
// confirma essa empresa (vínculo + `settings.mcp.edit`). Fluxo: register → authorize (pedido salvo, 302 para a tela de
// consentimento da web) → decide (código de uso único) → token (PKCE S256) → refresh com rotação → revoke.
import { and, eq, isNull } from 'drizzle-orm'
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  companies,
  mcpCredentials,
  mcpOauthAuthorizations,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthTokens,
  type Database,
} from '@crm/db'
import { MCP_ENDPOINT_PATH } from '../mcp/credentials'
import { findMembership, isUuid, permissionsOf } from '../platform/company-context'
import { hashToken } from '../platform/tokens'
import type { AuthUser } from '../platform/types'
import {
  generateSecret,
  MCP_OAUTH_ACCESS_PREFIX,
  MCP_OAUTH_CLIENT_PREFIX,
  MCP_OAUTH_CODE_PREFIX,
  MCP_OAUTH_REFRESH_PREFIX,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_SECRET_PREFIX,
  MCP_OAUTH_TTL,
  sameSecret,
  verifyPkce,
} from './tokens'

type Env = Record<string, string | undefined>
type ClientRow = typeof mcpOauthClients.$inferSelect

export const MCP_OAUTH_BASE_PATH = '/api/mcp-oauth'
export const MCP_OAUTH_PATHS = {
  register: `${MCP_OAUTH_BASE_PATH}/register`,
  authorize: `${MCP_OAUTH_BASE_PATH}/authorize`,
  token: `${MCP_OAUTH_BASE_PATH}/token`,
  revoke: `${MCP_OAUTH_BASE_PATH}/revoke`,
  /** Tela de consentimento (sessão): GET lê o pedido, POST decide. */
  consent: `${MCP_OAUTH_BASE_PATH}/consent`,
} as const
/** Rota da web com a tela de consentimento (`?request=<id>`). */
export const MCP_OAUTH_CONSENT_WEB_PATH = '/oauth/consent'
export const AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'
const TOKEN_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const

/** Erro no formato OAuth (`{ error, error_description }`, RFC 6749 §5.2). */
export class McpOAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description)
    this.name = 'McpOAuthError'
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.description }
  }
}

/** Erros da tela de consentimento (sessão do CRM): viram o erro padrão da API. */
export class McpOAuthConsentError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'validation',
    message: string,
  ) {
    super(message)
    this.name = 'McpOAuthConsentError'
  }
}

export interface McpOAuthServiceOptions {
  db: Database
  /** `API_PUBLIC_URL`, `WEB_PUBLIC_URL` e `MCP_OAUTH_ISSUER`, lidos a cada chamada. Default `process.env`. */
  env?: Env
  now?: () => Date
}

export interface ClientCredentials {
  clientId?: string
  clientSecret?: string
}

export interface ConsentInfo {
  request_id: string
  client: { client_id: string; name: string; redirect_uri: string }
  credential: { id: string; name: string }
  company: { id: string; name: string }
  scope: string
  expires_at: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** `redirect_uri` aceito: https, ou http só em loopback (clientes locais). Sem fragmento. */
function isAllowedRedirect(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
}

export class McpOAuthService {
  constructor(private readonly opts: McpOAuthServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  private env(): Env {
    return this.opts.env ?? process.env
  }

  apiBase(): string {
    return trimSlash(this.env().API_PUBLIC_URL?.trim() || 'http://localhost:3000')
  }

  /** `MCP_OAUTH_ISSUER` (origem onde a API publica `/.well-known/*`); padrão `API_PUBLIC_URL`. */
  issuer(): string {
    return trimSlash(this.env().MCP_OAUTH_ISSUER?.trim() || this.apiBase())
  }

  webBase(): string {
    return trimSlash(this.env().WEB_PUBLIC_URL?.trim() || 'http://localhost:5173')
  }

  /** URL do conector de uma credencial OAuth: `<API>/api/mcp/<credentialId>`. */
  connectorUrl(credentialId: string): string {
    return `${this.apiBase()}${MCP_ENDPOINT_PATH}/${credentialId}`
  }

  /** `resource_metadata` do `WWW-Authenticate` (RFC 9728 §5.1) para `/api/mcp` ou `/api/mcp/<id>`. */
  resourceMetadataUrl(credentialId?: string | null): string {
    return `${this.apiBase()}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_ENDPOINT_PATH}${credentialId ? `/${credentialId}` : ''}`
  }

  /** RFC 8414. */
  authorizationServerMetadata(): Record<string, unknown> {
    const api = this.apiBase()
    return {
      issuer: this.issuer(),
      authorization_endpoint: `${api}${MCP_OAUTH_PATHS.authorize}`,
      token_endpoint: `${api}${MCP_OAUTH_PATHS.token}`,
      registration_endpoint: `${api}${MCP_OAUTH_PATHS.register}`,
      revocation_endpoint: `${api}${MCP_OAUTH_PATHS.revoke}`,
      scopes_supported: [MCP_OAUTH_SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: [...GRANT_TYPES],
      token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    }
  }

  /**
   * RFC 9728. Sem id: o endpoint genérico `/api/mcp`. Com id: só credencial `oauth` não revogada (senão `null` → 404).
   */
  async protectedResourceMetadata(credentialId?: string): Promise<Record<string, unknown> | null> {
    let resource = `${this.apiBase()}${MCP_ENDPOINT_PATH}`
    if (credentialId !== undefined) {
      if (!(await this.oauthCredential(credentialId))) return null
      resource = this.connectorUrl(credentialId)
    }
    return {
      resource,
      authorization_servers: [this.issuer()],
      scopes_supported: [MCP_OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: this.env().APP_NAME?.trim() || 'CRM',
    }
  }

  private async oauthCredential(id: string) {
    if (!isUuid(id)) return null
    const [row] = await this.opts.db.select().from(mcpCredentials).where(eq(mcpCredentials.id, id)).limit(1)
    return row && row.authType === 'oauth' && !row.revokedAt ? row : null
  }

  // ---------- registro dinâmico (RFC 7591) ----------

  async register(input: unknown): Promise<Record<string, unknown>> {
    const parsed = OAuthClientMetadataSchema.safeParse(input ?? {})
    if (!parsed.success)
      throw new McpOAuthError(
        'invalid_client_metadata',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      )
    const m = parsed.data
    if (m.redirect_uris.length === 0 || !m.redirect_uris.every(isAllowedRedirect))
      throw new McpOAuthError(
        'invalid_redirect_uri',
        'redirect_uris precisa de URLs https (ou http em localhost), sem fragmento',
      )
    const method = m.token_endpoint_auth_method ?? 'client_secret_basic'
    if (!(TOKEN_AUTH_METHODS as readonly string[]).includes(method))
      throw new McpOAuthError('invalid_client_metadata', `token_endpoint_auth_method não suportado: ${method}`)
    const grantTypes = m.grant_types ?? ['authorization_code', 'refresh_token']
    if (!grantTypes.every((g) => (GRANT_TYPES as readonly string[]).includes(g)))
      throw new McpOAuthError('invalid_client_metadata', 'grant_types não suportado')
    const responseTypes = m.response_types ?? ['code']
    if (!responseTypes.every((r) => r === 'code'))
      throw new McpOAuthError('invalid_client_metadata', 'response_types não suportado')
    if (m.client_name !== undefined && m.client_name.length > 200)
      throw new McpOAuthError('invalid_client_metadata', 'client_name longo demais')

    const clientId = generateSecret(MCP_OAUTH_CLIENT_PREFIX)
    const secret = method === 'none' ? null : generateSecret(MCP_OAUTH_SECRET_PREFIX)
    const metadata: Record<string, unknown> = {
      ...m,
      redirect_uris: m.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: responseTypes,
    }
    const now = this.now()
    await this.opts.db.insert(mcpOauthClients).values({
      clientId,
      clientSecretHash: secret ? hashToken(secret) : null,
      clientName: m.client_name?.trim() || null,
      redirectUris: m.redirect_uris,
      tokenEndpointAuthMethod: method,
      metadata,
      createdAt: now,
    })
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }
  }

  private async findClient(clientId: string | undefined): Promise<ClientRow | null> {
    if (!clientId || clientId.length > 200) return null
    const [row] = await this.opts.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, clientId))
      .limit(1)
    return row ?? null
  }

  /** Autenticação do cliente no `/token` e no `/revoke` (público: só `client_id`; confidencial: + segredo). */
  private async authenticateClient(creds: ClientCredentials): Promise<ClientRow> {
    const client = await this.findClient(creds.clientId)
    if (!client) throw new McpOAuthError('invalid_client', 'Cliente desconhecido ou não autenticado', 401)
    if (client.clientSecretHash && !(creds.clientSecret && sameSecret(creds.clientSecret, client.clientSecretHash)))
      throw new McpOAuthError('invalid_client', 'Cliente desconhecido ou não autenticado', 401)
    return client
  }

  private clientName(client: ClientRow): string {
    return client.clientName || client.clientId.slice(0, MCP_OAUTH_CLIENT_PREFIX.length + 6)
  }

  // ---------- /authorize ----------

  /**
   * Valida o pedido. Erros antes de conhecer um `redirect_uri` confiável são lançados (`McpOAuthError`, resposta
   * direta); os demais voltam ao cliente pelo `redirect_uri`. Sucesso: pedido salvo e redirecionamento para a tela de
   * consentimento da web.
   */
  async authorize(params: Record<string, unknown>): Promise<{ location: string }> {
    const client = await this.findClient(str(params.client_id))
    if (!client) throw new McpOAuthError('invalid_client', 'client_id desconhecido')
    const asked = str(params.redirect_uri)
    let redirectUri: string
    if (asked) {
      if (!client.redirectUris.includes(asked))
        throw new McpOAuthError('invalid_request', 'redirect_uri não registrado para este cliente')
      redirectUri = asked
    } else if (client.redirectUris.length === 1) {
      redirectUri = client.redirectUris[0]!
    } else {
      throw new McpOAuthError('invalid_request', 'redirect_uri obrigatório')
    }
    const state = str(params.state) ?? null
    const fail = (error: string, description: string) => ({
      location: this.redirectWith(redirectUri, { error, error_description: description, state }),
    })

    if (params.response_type !== 'code') return fail('unsupported_response_type', 'Só response_type=code')
    const challenge = str(params.code_challenge)
    if (!challenge) return fail('invalid_request', 'code_challenge obrigatório (PKCE)')
    if (params.code_challenge_method !== 'S256') return fail('invalid_request', 'Só code_challenge_method=S256')
    if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge)) return fail('invalid_request', 'code_challenge inválido')
    // Escopo pedido não restringe nem amplia: o concedido é sempre o único que existe (somente leitura), devolvido
    // no `/token` (RFC 6749 §3.3). Clientes que pedem `offline_access` ou escopos próprios continuam funcionando.
    const scope = MCP_OAUTH_SCOPE
    const resource = str(params.resource)
    const credential = resource ? await this.credentialFromResource(resource) : null
    if (!credential)
      return fail(
        'invalid_target',
        'resource precisa ser a URL do conector de uma credencial OAuth (<API>/api/mcp/<id>)',
      )

    const now = this.now()
    const [row] = await this.opts.db
      .insert(mcpOauthAuthorizations)
      .values({
        companyId: credential.companyId,
        credentialId: credential.id,
        clientId: client.clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
        scope,
        resource: this.connectorUrl(credential.id),
        expiresAt: new Date(now.getTime() + MCP_OAUTH_TTL.request * 1000),
        createdAt: now,
      })
      .returning({ id: mcpOauthAuthorizations.id })
    return { location: `${this.webBase()}${MCP_OAUTH_CONSENT_WEB_PATH}?request=${row!.id}` }
  }

  private async credentialFromResource(resource: string) {
    const prefix = `${this.apiBase()}${MCP_ENDPOINT_PATH}/`
    const normalized = trimSlash(resource)
    if (!normalized.startsWith(prefix)) return null
    return this.oauthCredential(normalized.slice(prefix.length))
  }

  private redirectWith(redirectUri: string, params: Record<string, string | null>): string {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
    u.searchParams.set('iss', this.issuer())
    return u.toString()
  }

  // ---------- consentimento (sessão) ----------

  private async pendingRequest(user: Pick<AuthUser, 'id' | 'systemRole'>, requestId: unknown) {
    const notFound = () => new McpOAuthConsentError('not_found', 'Pedido de autorização não encontrado ou expirado')
    if (typeof requestId !== 'string' || !isUuid(requestId)) throw notFound()
    const [row] = await this.opts.db
      .select({
        req: mcpOauthAuthorizations,
        client: mcpOauthClients,
        credential: mcpCredentials,
        companyName: companies.name,
      })
      .from(mcpOauthAuthorizations)
      .innerJoin(mcpOauthClients, eq(mcpOauthClients.clientId, mcpOauthAuthorizations.clientId))
      .innerJoin(mcpCredentials, eq(mcpCredentials.id, mcpOauthAuthorizations.credentialId))
      .innerJoin(companies, eq(companies.id, mcpOauthAuthorizations.companyId))
      .where(eq(mcpOauthAuthorizations.id, requestId))
      .limit(1)
    if (!row || row.req.decidedAt || row.req.expiresAt.getTime() <= this.now().getTime() || row.credential.revokedAt)
      throw notFound()
    // Empresa da credencial: sem vínculo → 404 (não vaza existência); sem `settings.mcp.edit` → 403.
    const member = await findMembership(this.opts.db, user.id, row.req.companyId)
    if (!member) throw notFound()
    if (!permissionsOf(member, user).has('settings.mcp.edit'))
      throw new McpOAuthConsentError('forbidden', 'Sem permissão para conectar clientes MCP nesta empresa')
    return row
  }

  async consentInfo(user: Pick<AuthUser, 'id' | 'systemRole'>, requestId: unknown): Promise<ConsentInfo> {
    const { req, client, credential, companyName } = await this.pendingRequest(user, requestId)
    return {
      request_id: req.id,
      client: { client_id: client.clientId, name: this.clientName(client), redirect_uri: req.redirectUri },
      credential: { id: credential.id, name: credential.name },
      company: { id: req.companyId, name: companyName },
      scope: req.scope,
      expires_at: req.expiresAt.toISOString(),
    }
  }

  /**
   * Aprova (gera o código de uso único) ou nega. Aprovar exige confirmar a empresa da credencial (`company_id`).
   * Devolve a URL de volta ao cliente (`redirect_uri` com `code`/`error`, `state` e `iss`).
   */
  async decide(
    user: Pick<AuthUser, 'id' | 'systemRole'>,
    input: { request?: unknown; company_id?: unknown; approve?: unknown },
  ): Promise<{ redirect_to: string; approved: boolean; company_id: string; credential_id: string; client_id: string }> {
    const { req } = await this.pendingRequest(user, input.request)
    const now = this.now()
    const approve = input.approve === true
    if (approve && input.company_id !== req.companyId)
      throw new McpOAuthConsentError('validation', 'Confirme a empresa da credencial para aprovar')
    const code = approve ? generateSecret(MCP_OAUTH_CODE_PREFIX) : null
    const [done] = await this.opts.db
      .update(mcpOauthAuthorizations)
      .set({
        decidedAt: now,
        userId: user.id,
        ...(code ? { codeHash: hashToken(code), expiresAt: new Date(now.getTime() + MCP_OAUTH_TTL.code * 1000) } : {}),
      })
      .where(and(eq(mcpOauthAuthorizations.id, req.id), isNull(mcpOauthAuthorizations.decidedAt)))
      .returning({ id: mcpOauthAuthorizations.id })
    if (!done) throw new McpOAuthConsentError('not_found', 'Pedido de autorização já decidido')
    const redirect_to = code
      ? this.redirectWith(req.redirectUri, { code, state: req.state })
      : this.redirectWith(req.redirectUri, {
          error: 'access_denied',
          error_description: 'O usuário negou o acesso',
          state: req.state,
        })
    return {
      redirect_to,
      approved: approve,
      company_id: req.companyId,
      credential_id: req.credentialId,
      client_id: req.clientId,
    }
  }

  // ---------- /token ----------

  async token(form: Record<string, unknown>, creds: ClientCredentials): Promise<TokenResponse> {
    const grantType = str(form.grant_type)
    if (!grantType) throw new McpOAuthError('invalid_request', 'grant_type obrigatório')
    if (!(GRANT_TYPES as readonly string[]).includes(grantType))
      throw new McpOAuthError('unsupported_grant_type', `grant_type não suportado: ${grantType}`)
    const client = await this.authenticateClient({
      clientId: creds.clientId ?? str(form.client_id),
      clientSecret: creds.clientSecret ?? str(form.client_secret),
    })
    return grantType === 'authorization_code' ? this.exchangeCode(client, form) : this.refresh(client, form)
  }

  private async exchangeCode(client: ClientRow, form: Record<string, unknown>): Promise<TokenResponse> {
    const code = str(form.code)
    if (!code) throw new McpOAuthError('invalid_request', 'code obrigatório')
    const invalid = (d = 'Código inválido, expirado ou já usado') => new McpOAuthError('invalid_grant', d)
    const [req] = await this.opts.db
      .select()
      .from(mcpOauthAuthorizations)
      .where(eq(mcpOauthAuthorizations.codeHash, hashToken(code)))
      .limit(1)
    if (!req || req.clientId !== client.clientId) throw invalid()
    const now = this.now()
    if (req.usedAt) {
      // Código reapresentado: derruba o que foi emitido com ele (RFC 6749 §4.1.2).
      await this.opts.db
        .update(mcpOauthGrants)
        .set({ revokedAt: now })
        .where(and(eq(mcpOauthGrants.authorizationId, req.id), isNull(mcpOauthGrants.revokedAt)))
      throw invalid()
    }
    if (req.expiresAt.getTime() <= now.getTime()) throw invalid()
    if (str(form.redirect_uri) !== req.redirectUri) throw invalid('redirect_uri diferente do usado no /authorize')
    if (!verifyPkce(form.code_verifier, req.codeChallenge))
      throw invalid('code_verifier ausente ou não confere (PKCE S256)')
    const resource = str(form.resource)
    if (resource && trimSlash(resource) !== req.resource)
      throw new McpOAuthError('invalid_target', 'resource diferente do autorizado')
    const credential = await this.oauthCredential(req.credentialId)
    if (!credential) throw invalid('Credencial revogada')

    return this.opts.db.transaction(async (tx) => {
      const [used] = await tx
        .update(mcpOauthAuthorizations)
        .set({ usedAt: now })
        .where(and(eq(mcpOauthAuthorizations.id, req.id), isNull(mcpOauthAuthorizations.usedAt)))
        .returning({ id: mcpOauthAuthorizations.id })
      if (!used) throw invalid()
      const [grant] = await tx
        .insert(mcpOauthGrants)
        .values({
          companyId: req.companyId,
          credentialId: req.credentialId,
          clientId: client.clientId,
          userId: req.userId,
          authorizationId: req.id,
          clientName: this.clientName(client),
          scope: req.scope,
          createdAt: now,
        })
        .returning({ id: mcpOauthGrants.id })
      return this.issue(tx, req.companyId, grant!.id, req.scope, now)
    })
  }

  private async refresh(client: ClientRow, form: Record<string, unknown>): Promise<TokenResponse> {
    const refreshToken = str(form.refresh_token)
    if (!refreshToken) throw new McpOAuthError('invalid_request', 'refresh_token obrigatório')
    const invalid = (d = 'Refresh token inválido, expirado ou revogado') => new McpOAuthError('invalid_grant', d)
    if (!refreshToken.startsWith(MCP_OAUTH_REFRESH_PREFIX) || refreshToken.length > 200) throw invalid()
    const [row] = await this.opts.db
      .select({ token: mcpOauthTokens, grant: mcpOauthGrants, credentialRevokedAt: mcpCredentials.revokedAt })
      .from(mcpOauthTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
      .innerJoin(mcpCredentials, eq(mcpCredentials.id, mcpOauthGrants.credentialId))
      .where(eq(mcpOauthTokens.refreshHash, hashToken(refreshToken)))
      .limit(1)
    if (!row || row.grant.clientId !== client.clientId) throw invalid()
    if (row.grant.revokedAt || row.credentialRevokedAt) throw invalid()
    const now = this.now()
    if (row.token.rotatedAt) {
      // Reuso de refresh já rotacionado: revoga a família inteira (AC-T115-04).
      await this.revokeGrant(row.grant.id, now)
      throw invalid('Refresh token reutilizado: a conexão foi revogada')
    }
    if (row.token.refreshExpiresAt.getTime() <= now.getTime()) throw invalid()

    const issued = await this.opts.db.transaction(async (tx) => {
      const [rotated] = await tx
        .update(mcpOauthTokens)
        .set({ rotatedAt: now })
        .where(and(eq(mcpOauthTokens.id, row.token.id), isNull(mcpOauthTokens.rotatedAt)))
        .returning({ id: mcpOauthTokens.id })
      return rotated ? this.issue(tx, row.grant.companyId, row.grant.id, row.grant.scope, now) : null
    })
    if (!issued) {
      // Corrida: outro pedido rotacionou o mesmo refresh primeiro → também é reuso.
      await this.revokeGrant(row.grant.id, now)
      throw invalid('Refresh token reutilizado: a conexão foi revogada')
    }
    return issued
  }

  private async issue(
    tx: Pick<Database, 'insert'>,
    companyId: string,
    grantId: string,
    scope: string,
    now: Date,
  ): Promise<TokenResponse> {
    const access = generateSecret(MCP_OAUTH_ACCESS_PREFIX)
    const refresh = generateSecret(MCP_OAUTH_REFRESH_PREFIX)
    await tx.insert(mcpOauthTokens).values({
      companyId,
      grantId,
      accessHash: hashToken(access),
      refreshHash: hashToken(refresh),
      accessExpiresAt: new Date(now.getTime() + MCP_OAUTH_TTL.access * 1000),
      refreshExpiresAt: new Date(now.getTime() + MCP_OAUTH_TTL.refresh * 1000),
      createdAt: now,
    })
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: MCP_OAUTH_TTL.access,
      refresh_token: refresh,
      scope,
    }
  }

  private async revokeGrant(grantId: string, now: Date): Promise<void> {
    await this.opts.db
      .update(mcpOauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)))
  }

  // ---------- /revoke (RFC 7009) ----------

  /** Revoga a conexão (grant) do token, seja access ou refresh. Token desconhecido ou de outro cliente: nada (200). */
  async revoke(form: Record<string, unknown>, creds: ClientCredentials): Promise<void> {
    const token = str(form.token)
    if (!token) throw new McpOAuthError('invalid_request', 'token obrigatório')
    const client = await this.authenticateClient({
      clientId: creds.clientId ?? str(form.client_id),
      clientSecret: creds.clientSecret ?? str(form.client_secret),
    })
    if (token.length > 200) return
    const column = token.startsWith(MCP_OAUTH_REFRESH_PREFIX)
      ? mcpOauthTokens.refreshHash
      : token.startsWith(MCP_OAUTH_ACCESS_PREFIX)
        ? mcpOauthTokens.accessHash
        : null
    if (!column) return
    const [row] = await this.opts.db
      .select({ grantId: mcpOauthGrants.id, clientId: mcpOauthGrants.clientId })
      .from(mcpOauthTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
      .where(eq(column, hashToken(token)))
      .limit(1)
    if (row && row.clientId === client.clientId) await this.revokeGrant(row.grantId, this.now())
  }
}

// Credenciais MCP (T94; 09 §3.4, §6): token estático Bearer mostrado uma única vez (no banco só o SHA-256), expiração
// opcional, último uso e revogação imediata. A listagem traz só nome, tipo, status, expiração e último uso.
// T115: `auth_type = 'oauth'` (conector do Claude) não tem token próprio: nasce `pending`, fica `connected` (com o nome
// do cliente) quando um cliente conclui o OAuth pela URL do conector (`<API>/api/mcp/<id>`), e `authenticate` aceita o
// access token OAuth.
import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { MCP_ACCESS_MODES, mcpCredentials, mcpOauthGrants, type Database, type McpAccessMode } from '@crm/db'
import { authenticateOAuthAccess, connectedClients, MCP_OAUTH_ACCESS_PREFIX } from '../mcp-oauth/tokens'
import { hashToken } from '../platform/tokens'

type Env = Record<string, string | undefined>
type Row = typeof mcpCredentials.$inferSelect

export const MCP_TOKEN_PREFIX = 'crm_mcp_'
export const MCP_ENDPOINT_PATH = '/api/mcp'
/** Último uso gravado no máximo a cada minuto por credencial. */
const LAST_USED_EVERY_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `static`: `active`/`expired`; `oauth` (T115): `pending` (aguardando o cliente) ou `connected`. */
export type McpCredentialStatus = 'active' | 'expired' | 'pending' | 'connected'

/** Credencial válida: empresa, modo de acesso e usuário dono das ações (`null` → só as ferramentas de leitura antigas). */
export interface McpAuth {
  credentialId: string
  companyId: string
  access: McpAccessMode
  userId: string | null
}

export interface McpCredentialDto {
  id: string
  name: string
  auth_type: 'static' | 'oauth'
  /** `read` (padrão) ou `write` (libera as ferramentas que gravam, nos limites das permissões do usuário). */
  access: McpAccessMode
  status: McpCredentialStatus
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  /** T115: nome do cliente OAuth conectado ("Conectada · <cliente>"); `null` fora de `connected`. */
  connected_client_hint: string | null
  /** T115: URL do conector (`<API>/api/mcp/<id>`) das credenciais `oauth`; `null` para `static`. */
  connector_url: string | null
}

export class McpCredentialsError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'McpCredentialsError'
  }
}

export interface McpCredentialsServiceOptions {
  db: Database
  /** `API_PUBLIC_URL`, lido a cada chamada. Default `process.env`. */
  env?: Env
  now?: () => Date
}

const createSchema = z
  .object({
    name: z.string().trim().min(1, 'Informe o nome').max(100),
    auth_type: z.enum(['static', 'oauth']).default('static'),
    access: z.enum(MCP_ACCESS_MODES).default('read'),
    expires_at: z.iso.datetime({ offset: true }).nullish(),
    expires_in_days: z.number().int().min(1).max(3650).nullish(),
  })

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export class McpCredentialsService {
  constructor(private readonly opts: McpCredentialsServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /** URL única do servidor MCP (`<API_PUBLIC_URL>/api/mcp`). */
  endpointUrl(): string {
    const base = ((this.opts.env ?? process.env).API_PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '')
    return `${base}${MCP_ENDPOINT_PATH}`
  }

  /** T115: URL do conector OAuth da credencial (o id no caminho liga o cliente à credencial). */
  connectorUrl(id: string): string {
    return `${this.endpointUrl()}/${id}`
  }

  /** `connectedClient`: nome do cliente OAuth com conexão ativa (T115). */
  toDto(r: Row, connectedClient: string | null = null): McpCredentialDto {
    const expired = r.expiresAt !== null && r.expiresAt.getTime() <= this.now().getTime()
    const oauth = r.authType === 'oauth'
    return {
      id: r.id,
      name: r.name,
      auth_type: r.authType,
      access: r.access,
      status: oauth ? (connectedClient ? 'connected' : 'pending') : expired ? 'expired' : 'active',
      expires_at: iso(r.expiresAt),
      last_used_at: iso(r.lastUsedAt),
      created_at: r.createdAt.toISOString(),
      connected_client_hint: oauth ? connectedClient : null,
      connector_url: oauth ? this.connectorUrl(r.id) : null,
    }
  }

  async list(companyId: string): Promise<McpCredentialDto[]> {
    const rows = await this.opts.db
      .select()
      .from(mcpCredentials)
      .where(and(eq(mcpCredentials.companyId, companyId), isNull(mcpCredentials.revokedAt)))
      .orderBy(desc(mcpCredentials.createdAt), desc(mcpCredentials.id))
    const connected = await connectedClients(this.opts.db, companyId, rows.filter((r) => r.authType === 'oauth').map((r) => r.id))
    return rows.map((r) => this.toDto(r, connected.get(r.id) ?? null))
  }

  /**
   * Cria a credencial e devolve o token cru (a única vez em que ele aparece). `oauth` (T115): sem token nem
   * expiração; nasce `pending` e o cliente conecta pela `connector_url`.
   */
  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<{ credential: McpCredentialDto; token: string | null }> {
    const r = createSchema.safeParse(input ?? {})
    if (!r.success)
      throw new McpCredentialsError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
    const now = this.now()
    if (r.data.auth_type === 'oauth') {
      const [row] = await this.opts.db
        .insert(mcpCredentials)
        .values({ companyId, name: r.data.name, authType: 'oauth', access: r.data.access, tokenHash: null, tokenHint: null, expiresAt: null, createdByUserId: actorUserId, createdAt: now, updatedAt: now })
        .returning()
      return { credential: this.toDto(row!), token: null }
    }
    let expiresAt: Date | null = null
    if (r.data.expires_at) expiresAt = new Date(r.data.expires_at)
    else if (r.data.expires_in_days) expiresAt = new Date(now.getTime() + r.data.expires_in_days * 86_400_000)
    if (expiresAt && expiresAt.getTime() <= now.getTime())
      throw new McpCredentialsError('validation', 'Dados inválidos', { fields: [{ path: 'expires_at', message: 'A expiração precisa ser no futuro' }] })
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const [row] = await this.opts.db
      .insert(mcpCredentials)
      .values({ companyId, name: r.data.name, authType: 'static', access: r.data.access, tokenHash: hashToken(token), tokenHint: token.slice(-4), expiresAt, createdByUserId: actorUserId, createdAt: now, updatedAt: now })
      .returning()
    return { credential: this.toDto(row!), token }
  }

  /** Revoga na hora (some da listagem; o token passa a dar 401). */
  async revoke(companyId: string, id: string): Promise<McpCredentialDto> {
    if (!UUID_RE.test(id)) throw new McpCredentialsError('not_found', 'Credencial não encontrada')
    const now = this.now()
    const [row] = await this.opts.db
      .update(mcpCredentials)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(mcpCredentials.companyId, companyId), eq(mcpCredentials.id, id), isNull(mcpCredentials.revokedAt)))
      .returning()
    if (!row) throw new McpCredentialsError('not_found', 'Credencial não encontrada')
    // T115: as conexões OAuth da credencial caem junto (access e refresh deixam de valer na hora).
    if (row.authType === 'oauth')
      await this.opts.db.update(mcpOauthGrants).set({ revokedAt: now }).where(and(eq(mcpOauthGrants.credentialId, row.id), isNull(mcpOauthGrants.revokedAt)))
    return this.toDto(row)
  }

  /**
   * Empresa do token Bearer; `null` se ausente, desconhecido, expirado, revogado ou de outro tipo. Atualiza o último
   * uso (no máximo uma vez por minuto).
   */
  async authenticate(token: string | undefined | null): Promise<McpAuth | null> {
    if (token?.startsWith(MCP_OAUTH_ACCESS_PREFIX)) return this.authenticateOAuth(token)
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return null
    const [row] = await this.opts.db.select().from(mcpCredentials).where(eq(mcpCredentials.tokenHash, hashToken(token))).limit(1)
    const now = this.now()
    if (!row || row.authType !== 'static' || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return null
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)
      await this.opts.db.update(mcpCredentials).set({ lastUsedAt: now }).where(eq(mcpCredentials.id, row.id))
    return { credentialId: row.id, companyId: row.companyId, access: row.access, userId: row.createdByUserId }
  }

  /** T115: access token OAuth (grant e credencial ativos, dentro do TTL); grava o último uso da credencial. */
  private async authenticateOAuth(token: string): Promise<McpAuth | null> {
    const now = this.now()
    const auth = await authenticateOAuthAccess(this.opts.db, token, now)
    if (!auth) return null
    const since = new Date(now.getTime() - LAST_USED_EVERY_MS)
    await this.opts.db
      .update(mcpCredentials)
      .set({ lastUsedAt: now })
      .where(and(eq(mcpCredentials.id, auth.credentialId), or(isNull(mcpCredentials.lastUsedAt), lte(mcpCredentials.lastUsedAt, since))))
    return { credentialId: auth.credentialId, companyId: auth.companyId, access: auth.access, userId: auth.userId }
  }
}

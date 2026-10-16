// Credenciais MCP (T94; 09 §3.4, §6): token estático Bearer mostrado uma única vez (no banco só o SHA-256), expiração
// opcional, último uso e revogação imediata. A listagem traz só nome, tipo, status, expiração e último uso.
// `auth_type = 'oauth'` (conector do Claude) é da T115: aqui é recusado na criação.
import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { mcpCredentials, type Database } from '@crm/db'
import { hashToken } from '../platform/tokens'

type Env = Record<string, string | undefined>
type Row = typeof mcpCredentials.$inferSelect

export const MCP_TOKEN_PREFIX = 'crm_mcp_'
export const MCP_ENDPOINT_PATH = '/api/mcp'
/** Último uso gravado no máximo a cada minuto por credencial. */
const LAST_USED_EVERY_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type McpCredentialStatus = 'active' | 'expired'

export interface McpCredentialDto {
  id: string
  name: string
  auth_type: 'static' | 'oauth'
  status: McpCredentialStatus
  expires_at: string | null
  last_used_at: string | null
  created_at: string
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
    expires_at: z.iso.datetime({ offset: true }).nullish(),
    expires_in_days: z.number().int().min(1).max(3650).nullish(),
  })
  .refine((v) => v.auth_type === 'static', { path: ['auth_type'], message: 'Credencial OAuth ainda não disponível' })

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

  toDto(r: Row): McpCredentialDto {
    const expired = r.expiresAt !== null && r.expiresAt.getTime() <= this.now().getTime()
    return {
      id: r.id,
      name: r.name,
      auth_type: r.authType,
      status: expired ? 'expired' : 'active',
      expires_at: iso(r.expiresAt),
      last_used_at: iso(r.lastUsedAt),
      created_at: r.createdAt.toISOString(),
    }
  }

  async list(companyId: string): Promise<McpCredentialDto[]> {
    const rows = await this.opts.db
      .select()
      .from(mcpCredentials)
      .where(and(eq(mcpCredentials.companyId, companyId), isNull(mcpCredentials.revokedAt)))
      .orderBy(desc(mcpCredentials.createdAt), desc(mcpCredentials.id))
    return rows.map((r) => this.toDto(r))
  }

  /** Cria a credencial e devolve o token cru (a única vez em que ele aparece). */
  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<{ credential: McpCredentialDto; token: string }> {
    const r = createSchema.safeParse(input ?? {})
    if (!r.success)
      throw new McpCredentialsError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
    const now = this.now()
    let expiresAt: Date | null = null
    if (r.data.expires_at) expiresAt = new Date(r.data.expires_at)
    else if (r.data.expires_in_days) expiresAt = new Date(now.getTime() + r.data.expires_in_days * 86_400_000)
    if (expiresAt && expiresAt.getTime() <= now.getTime())
      throw new McpCredentialsError('validation', 'Dados inválidos', { fields: [{ path: 'expires_at', message: 'A expiração precisa ser no futuro' }] })
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const [row] = await this.opts.db
      .insert(mcpCredentials)
      .values({ companyId, name: r.data.name, authType: 'static', tokenHash: hashToken(token), tokenHint: token.slice(-4), expiresAt, createdByUserId: actorUserId, createdAt: now, updatedAt: now })
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
    return this.toDto(row)
  }

  /**
   * Empresa do token Bearer; `null` se ausente, desconhecido, expirado, revogado ou de outro tipo. Atualiza o último
   * uso (no máximo uma vez por minuto).
   */
  async authenticate(token: string | undefined | null): Promise<{ credentialId: string; companyId: string } | null> {
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return null
    const [row] = await this.opts.db.select().from(mcpCredentials).where(eq(mcpCredentials.tokenHash, hashToken(token))).limit(1)
    const now = this.now()
    if (!row || row.authType !== 'static' || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return null
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)
      await this.opts.db.update(mcpCredentials).set({ lastUsedAt: now }).where(eq(mcpCredentials.id, row.id))
    return { credentialId: row.id, companyId: row.companyId }
  }
}

// Integrações UTMify por empresa (T113; 11-facebook-ads.md §3.6, §6 `/utmify_integrations`). O token só fica cifrado;
// sai decifrado apenas para o adapter (`trackerFor`), nunca em DTO, erro ou log (AC-T113-04).
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { flowNodeActions, flowNodes, flows, utmifyIntegrations, type Database } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { createUtmifyTracker, utmifyPlatform } from './adapter'
import type { SalesTracker, SalesTrackerFactory } from './port'

type Env = Record<string, string | undefined>
type Row = typeof utmifyIntegrations.$inferSelect

export type UtmifyErrorCode = 'not_found' | 'validation' | 'conflict'

export class UtmifyError extends Error {
  constructor(
    readonly code: UtmifyErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `conflict`: `{ flows, warning }`. Nunca o token. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'UtmifyError'
  }
}

export const utmifyIntegrationNotFound = () => new UtmifyError('not_found', 'Integração UTMify não encontrada')

const companyNameSchema = z
  .string('Informe o nome da empresa com pelo menos 2 caracteres.')
  .trim()
  .min(2, 'Informe o nome da empresa com pelo menos 2 caracteres.')
  .max(120, 'O nome da empresa pode ter até 120 caracteres')
const tokenSchema = z.string('Token inválido').max(2000, 'Token longo demais').nullish()

export const utmifyIntegrationCreateSchema = z.object({
  company_name: companyNameSchema,
  /** Ausente ou em branco: integração sem token (`token_configured: false`; fora dos seletores). */
  integration_token: tokenSchema,
})

export const utmifyIntegrationUpdateSchema = z.object({
  company_name: companyNameSchema.optional(),
  /** Ausente, vazio ou só espaços: mantém o token atual. */
  integration_token: tokenSchema,
})

export interface UtmifyIntegrationDto {
  id: string
  /** Nome exibido do provedor. */
  name: string
  company_name: string
  token_configured: boolean
  /** `…abcd` (últimos 4 caracteres) ou `null`. */
  token_hint: string | null
  created_at: string
  updated_at: string
}

export interface UtmifyIntegrationUsage {
  /** Fluxos ativos com bloco "Venda aprovada" enviando por esta integração. */
  flows: { id: string; name: string }[]
}

export interface UtmifyIntegrationsServiceOptions {
  db: Database
  /** Default: o cifrador de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  /** `UTMIFY_API_URL` e `APP_NAME`, lidos a cada chamada. Default `process.env`. */
  env?: Env
  fetch?: typeof globalThis.fetch
  /** Troca o adapter (testes). Default: UTMify. */
  trackerFactory?: SalesTrackerFactory
  now?: () => Date
}

export const UTMIFY_USAGE_WARNING = 'O bloco "Venda aprovada" destes fluxos deixará de enviar vendas para a UTMify.'

const defaultFactory: SalesTrackerFactory = (creds, ctx) =>
  createUtmifyTracker({
    token: creds.token,
    ...(ctx.env.UTMIFY_API_URL?.trim() ? { apiUrl: ctx.env.UTMIFY_API_URL.trim() } : {}),
    platform: utmifyPlatform(ctx.env.APP_NAME),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  })

export class UtmifyIntegrationsService {
  private readonly db: Database

  constructor(private readonly opts: UtmifyIntegrationsServiceOptions) {
    this.db = opts.db
  }

  /** `configured: true` = só as com token (seletores do bloco "Venda aprovada", 11 §3.6). */
  async list(companyId: string, opts: { configured?: boolean } = {}): Promise<UtmifyIntegrationDto[]> {
    const rows = await this.db
      .select()
      .from(utmifyIntegrations)
      .where(
        and(
          eq(utmifyIntegrations.companyId, companyId),
          opts.configured ? isNotNull(utmifyIntegrations.tokenEnc) : undefined,
        ),
      )
      .orderBy(asc(utmifyIntegrations.createdAt), asc(utmifyIntegrations.id))
    return rows.map(toDto)
  }

  async get(companyId: string, id: string): Promise<UtmifyIntegrationDto> {
    return toDto(await this.row(companyId, id))
  }

  /** Linha da integração ou `null` (id inválido, inexistente ou de outra empresa). */
  async find(companyId: string, id: string | null | undefined): Promise<Row | null> {
    if (!id || !z.uuid().safeParse(id).success) return null
    const [row] = await this.db
      .select()
      .from(utmifyIntegrations)
      .where(and(eq(utmifyIntegrations.companyId, companyId), eq(utmifyIntegrations.id, id)))
      .limit(1)
    return row ?? null
  }

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<UtmifyIntegrationDto> {
    const data = parse(utmifyIntegrationCreateSchema, input)
    const id = randomUUID()
    const now = this.now()
    const token = data.integration_token?.trim() ?? ''
    await this.db.insert(utmifyIntegrations).values({
      id,
      companyId,
      companyName: data.company_name,
      tokenEnc: token ? this.seal(companyId, id, token) : null,
      tokenHint: token ? token.slice(-4) : null,
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    return this.get(companyId, id)
  }

  async update(companyId: string, id: string, input: unknown): Promise<UtmifyIntegrationDto> {
    const data = parse(utmifyIntegrationUpdateSchema, input)
    const row = await this.row(companyId, id)
    const patch: Partial<typeof utmifyIntegrations.$inferInsert> = {}
    if (data.company_name !== undefined && data.company_name !== row.companyName) patch.companyName = data.company_name
    const token = data.integration_token?.trim() ?? ''
    if (token) {
      patch.tokenEnc = this.seal(companyId, id, token)
      patch.tokenHint = token.slice(-4)
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = this.now()
      await this.db
        .update(utmifyIntegrations)
        .set(patch)
        .where(and(eq(utmifyIntegrations.companyId, companyId), eq(utmifyIntegrations.id, id)))
    }
    return this.get(companyId, id)
  }

  /** Fluxos ATIVOS com bloco "Venda aprovada" (`register_approved_sale.utmify_integration_id`) apontando para a integração. */
  async usage(companyId: string, id: string): Promise<UtmifyIntegrationUsage> {
    await this.row(companyId, id)
    const rows = await this.db
      .selectDistinct({ id: flows.id, name: flows.name })
      .from(flowNodeActions)
      .innerJoin(flowNodes, eq(flowNodes.id, flowNodeActions.nodeId))
      .innerJoin(flows, eq(flows.id, flowNodes.flowId))
      .where(
        and(
          eq(flowNodeActions.companyId, companyId),
          eq(flows.status, 'active'),
          eq(flowNodeActions.type, 'register_approved_sale'),
          sql`trim(${flowNodeActions.config}->>'utmify_integration_id') = ${id}`,
        ),
      )
    return { flows: rows.map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /** Exclui. Em uso por bloco "Venda aprovada" de fluxo ativo e sem `force` → `conflict` com o aviso e os fluxos. */
  async remove(
    companyId: string,
    id: string,
    opts: { force?: boolean } = {},
  ): Promise<{ deleted: UtmifyIntegrationDto; warning: string | null; flows: UtmifyIntegrationUsage['flows'] }> {
    const deleted = await this.get(companyId, id)
    const { flows: used } = await this.usage(companyId, id)
    if (used.length && !opts.force)
      throw new UtmifyError('conflict', `A integração está em uso. ${UTMIFY_USAGE_WARNING}`, {
        flows: used,
        warning: UTMIFY_USAGE_WARNING,
      })
    await this.db
      .delete(utmifyIntegrations)
      .where(and(eq(utmifyIntegrations.companyId, companyId), eq(utmifyIntegrations.id, id)))
    return { deleted, warning: used.length ? UTMIFY_USAGE_WARNING : null, flows: used }
  }

  /** Adapter da integração com o token decifrado; `null` se ela não tem token. */
  trackerFor(row: Row): SalesTracker | null {
    const token = this.tokenOf(row)
    if (!token) return null
    const factory = this.opts.trackerFactory ?? defaultFactory
    return factory(
      { integrationId: row.id, companyId: row.companyId, token },
      { env: this.env(), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) },
    )
  }

  /** Token decifrado (só para o adapter e para redigir mensagens de erro). */
  tokenOf(row: Row): string | null {
    return row.tokenEnc ? this.open(row) : null
  }

  // ---------- internos ----------

  private async row(companyId: string, id: string): Promise<Row> {
    const row = await this.find(companyId, id)
    if (!row) throw utmifyIntegrationNotFound()
    return row
  }

  private aad = (companyId: string, id: string) => `utmify-integration/${companyId}/${id}/token`
  private cipher = () => this.opts.cipher ?? getCredentialsCipher()
  private seal = (companyId: string, id: string, value: string) =>
    serializeEncrypted(this.cipher().encrypt(value, this.aad(companyId, id)))
  private open = (r: Row) =>
    this.cipher().decrypt<string>(parseEncrypted<string>(r.tokenEnc!), this.aad(r.companyId, r.id))
  private env = (): Env => this.opts.env ?? process.env
  private now = () => this.opts.now?.() ?? new Date()
}

function toDto(r: Row): UtmifyIntegrationDto {
  return {
    id: r.id,
    name: 'UTMify',
    company_name: r.companyName,
    token_configured: Boolean(r.tokenEnc),
    token_hint: r.tokenHint ? `…${r.tokenHint}` : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new UtmifyError('validation', 'Dados inválidos', {
      fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    })
  return r.data
}

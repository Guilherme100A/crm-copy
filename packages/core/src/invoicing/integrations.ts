// Emissores de NF por empresa (T112; 19-integracoes.md §3.2, §6 "Emissores de NF"). Único provedor: Notasy.
// O token só fica cifrado; sai decifrado apenas para o adapter (`issuerFor`), nunca em DTO, erro ou log.
import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  flowNodeActions,
  flowNodes,
  flows,
  INVOICE_PROVIDERS,
  invoiceIntegrations,
  type Database,
  type InvoiceProvider,
} from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { createNotasyIssuer, normalizeNotasyToken } from './notasy/adapter'
import type { InvoiceIssuer, InvoiceIssuerFactory } from './port'

type Env = Record<string, string | undefined>
type Row = typeof invoiceIntegrations.$inferSelect

export type InvoicingErrorCode = 'not_found' | 'validation' | 'conflict'

export class InvoicingError extends Error {
  constructor(
    readonly code: InvoicingErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `conflict`: `{ flows }` ou `{ invoice_emit_status }`. Nunca o token. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'InvoicingError'
  }
}

export const invoiceIntegrationNotFound = () => new InvoicingError('not_found', 'Emissor de NF não encontrado')

const companyNameSchema = z
  .string('Informe o nome da empresa com pelo menos 2 caracteres.')
  .trim()
  .min(2, 'Informe o nome da empresa com pelo menos 2 caracteres.')
  .max(120, 'O nome da empresa pode ter até 120 caracteres')
const tokenSchema = z.string('Token inválido').max(2000, 'Token longo demais').nullish()

export const invoiceIntegrationCreateSchema = z.object({
  provider: z.enum(INVOICE_PROVIDERS, 'Provedor inválido (use notasy)').default('notasy'),
  company_name: companyNameSchema,
  /** Ausente ou em branco: emissor sem token (`token_configured: false`; a emissão falha com "Emissor não configurado"). */
  integration_token: tokenSchema,
})

export const invoiceIntegrationUpdateSchema = z.object({
  /** Só pode repetir o atual. */
  provider: z.string().optional(),
  company_name: companyNameSchema.optional(),
  /** Ausente, vazio ou só espaços: mantém o token atual. */
  integration_token: tokenSchema,
})

export interface InvoiceIntegrationDto {
  id: string
  provider: InvoiceProvider
  /** Nome exibido do provedor. */
  name: string
  company_name: string
  token_configured: boolean
  /** `…abcd` (últimos 4 caracteres) ou `null`. */
  token_hint: string | null
  created_at: string
  updated_at: string
}

export interface InvoiceIntegrationUsage {
  /** Fluxos ativos com bloco "Venda aprovada" emitindo por este emissor. */
  flows: { id: string; name: string }[]
}

export interface InvoiceIntegrationsServiceOptions {
  db: Database
  /** Default: o cifrador de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  /** `NOTASY_API_URL`, lido a cada chamada. Default `process.env`. */
  env?: Env
  fetch?: typeof globalThis.fetch
  /** Troca o adapter (testes). Default: Notasy. */
  issuerFactory?: InvoiceIssuerFactory
  now?: () => Date
}

export const INVOICE_PROVIDER_NAMES: Record<InvoiceProvider, string> = { notasy: 'Notasy' }

export const USAGE_WARNING = 'O bloco "Venda aprovada" destes fluxos deixará de emitir nota fiscal.'

const defaultFactory: InvoiceIssuerFactory = (creds, ctx) =>
  createNotasyIssuer({
    token: creds.token,
    ...(ctx.env.NOTASY_API_URL?.trim() ? { apiUrl: ctx.env.NOTASY_API_URL.trim() } : {}),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  })

export class InvoiceIntegrationsService {
  private readonly db: Database

  constructor(private readonly opts: InvoiceIntegrationsServiceOptions) {
    this.db = opts.db
  }

  async list(companyId: string): Promise<InvoiceIntegrationDto[]> {
    const rows = await this.db
      .select()
      .from(invoiceIntegrations)
      .where(eq(invoiceIntegrations.companyId, companyId))
      .orderBy(asc(invoiceIntegrations.createdAt), asc(invoiceIntegrations.id))
    return rows.map(toDto)
  }

  async get(companyId: string, id: string): Promise<InvoiceIntegrationDto> {
    return toDto(await this.row(companyId, id))
  }

  /** Linha do emissor ou `null` (id inválido, inexistente ou de outra empresa). */
  async find(companyId: string, id: string | null | undefined): Promise<Row | null> {
    if (!id || !z.uuid().safeParse(id).success) return null
    const [row] = await this.db
      .select()
      .from(invoiceIntegrations)
      .where(and(eq(invoiceIntegrations.companyId, companyId), eq(invoiceIntegrations.id, id)))
      .limit(1)
    return row ?? null
  }

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<InvoiceIntegrationDto> {
    const data = parse(invoiceIntegrationCreateSchema, input)
    const id = randomUUID()
    const now = this.now()
    const token = data.integration_token ? normalizeNotasyToken(data.integration_token) : ''
    await this.db.insert(invoiceIntegrations).values({
      id,
      companyId,
      provider: data.provider,
      companyName: data.company_name,
      tokenEnc: token ? this.seal(companyId, id, token) : null,
      tokenHint: token ? token.slice(-4) : null,
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    return this.get(companyId, id)
  }

  async update(companyId: string, id: string, input: unknown): Promise<InvoiceIntegrationDto> {
    const data = parse(invoiceIntegrationUpdateSchema, input)
    const row = await this.row(companyId, id)
    if (data.provider !== undefined && data.provider !== row.provider)
      throw invalid('provider', 'O provedor não pode ser alterado depois de criado')
    const patch: Partial<typeof invoiceIntegrations.$inferInsert> = {}
    if (data.company_name !== undefined && data.company_name !== row.companyName) patch.companyName = data.company_name
    const token = data.integration_token?.trim() ? normalizeNotasyToken(data.integration_token) : ''
    if (token) {
      patch.tokenEnc = this.seal(companyId, id, token)
      patch.tokenHint = token.slice(-4)
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = this.now()
      await this.db
        .update(invoiceIntegrations)
        .set(patch)
        .where(and(eq(invoiceIntegrations.companyId, companyId), eq(invoiceIntegrations.id, id)))
    }
    return this.get(companyId, id)
  }

  /** Fluxos ATIVOS com bloco "Venda aprovada" (`register_approved_sale.note_issuer_id`) apontando para o emissor (AC-T112-04). */
  async usage(companyId: string, id: string): Promise<InvoiceIntegrationUsage> {
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
          sql`trim(${flowNodeActions.config}->>'note_issuer_id') = ${id}`,
        ),
      )
    return { flows: rows.map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /**
   * Exclui. Em uso por bloco "Venda aprovada" de fluxo ativo e sem `force` → `conflict` com o aviso e os fluxos
   * (AC-T112-04). Com `force`, exclui e devolve o mesmo aviso.
   */
  async remove(
    companyId: string,
    id: string,
    opts: { force?: boolean } = {},
  ): Promise<{ deleted: InvoiceIntegrationDto; warning: string | null; flows: InvoiceIntegrationUsage['flows'] }> {
    const deleted = await this.get(companyId, id)
    const { flows: used } = await this.usage(companyId, id)
    if (used.length && !opts.force)
      throw new InvoicingError('conflict', `O emissor está em uso. ${USAGE_WARNING}`, {
        flows: used,
        warning: USAGE_WARNING,
      })
    await this.db
      .delete(invoiceIntegrations)
      .where(and(eq(invoiceIntegrations.companyId, companyId), eq(invoiceIntegrations.id, id)))
    return { deleted, warning: used.length ? USAGE_WARNING : null, flows: used }
  }

  /** Adapter do emissor com o token decifrado; `null` se o emissor não tem token. */
  issuerFor(row: Row): InvoiceIssuer | null {
    if (!row.tokenEnc) return null
    const token = this.open(row)
    if (!token) return null
    const factory = this.opts.issuerFactory ?? defaultFactory
    return factory(
      { integrationId: row.id, companyId: row.companyId, token },
      { env: this.env(), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) },
    )
  }

  /** Token decifrado (só para redigir mensagens de erro). */
  tokenOf(row: Row): string | null {
    return row.tokenEnc ? this.open(row) : null
  }

  // ---------- internos ----------

  private async row(companyId: string, id: string): Promise<Row> {
    const row = await this.find(companyId, id)
    if (!row) throw invoiceIntegrationNotFound()
    return row
  }

  private aad = (companyId: string, id: string) => `invoice-integration/${companyId}/${id}/token`
  private cipher = () => this.opts.cipher ?? getCredentialsCipher()
  private seal = (companyId: string, id: string, value: string) =>
    serializeEncrypted(this.cipher().encrypt(value, this.aad(companyId, id)))
  private open = (r: Row) =>
    this.cipher().decrypt<string>(parseEncrypted<string>(r.tokenEnc!), this.aad(r.companyId, r.id))
  private env = (): Env => this.opts.env ?? process.env
  private now = () => this.opts.now?.() ?? new Date()
}

function toDto(r: Row): InvoiceIntegrationDto {
  return {
    id: r.id,
    provider: r.provider,
    name: INVOICE_PROVIDER_NAMES[r.provider] ?? r.provider,
    company_name: r.companyName,
    token_configured: Boolean(r.tokenEnc),
    token_hint: r.tokenHint ? `…${r.tokenHint}` : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

const invalid = (path: string, message: string) =>
  new InvoicingError('validation', message, { fields: [{ path, message }] })

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new InvoicingError('validation', 'Dados inválidos', {
      fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    })
  return r.data
}

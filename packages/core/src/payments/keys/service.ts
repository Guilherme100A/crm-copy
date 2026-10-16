// Chaves de pagamento ao lead por empresa (T109; 19-integracoes.md §3.1, §5.2). Segredos (`client_secret`,
// `webhook_secret`) só cifrados; saem decifrados apenas para o adapter (`gatewayFor`/`testConnection`), nunca em DTO nem log.
import { randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { flowNodeActions, flowNodes, flows, PAYMENT_GATEWAY_IDS, paymentIntegrations, type Database, type PaymentGatewayId } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { paymentGatewayFactory, type ConnectionTestResult, type PaymentGateway } from '../port'
// Registra o adapter XPag na porta.
import '../xpag/index'

type Env = Record<string, string | undefined>
type Row = typeof paymentIntegrations.$inferSelect

export type PaymentIntegrationsErrorCode = 'not_found' | 'validation' | 'conflict' | 'upstream'

export class PaymentIntegrationsError extends Error {
  constructor(
    readonly code: PaymentIntegrationsErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `conflict`: `{ flows }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PaymentIntegrationsError'
  }
}

const invalid = (path: string, message: string) => new PaymentIntegrationsError('validation', message, { fields: [{ path, message }] })
const notFound = () => new PaymentIntegrationsError('not_found', 'Integração de pagamento não encontrada')

const labelSchema = z.string('Informe um nome com pelo menos 2 caracteres.').trim().min(2, 'Informe um nome com pelo menos 2 caracteres.').max(120, 'O nome pode ter até 120 caracteres')

export const paymentIntegrationCreateSchema = z.object({
  label: labelSchema,
  gateway: z.enum(PAYMENT_GATEWAY_IDS, 'Gateway inválido'),
  client_id: z.string('Informe o Client ID').trim().min(1, 'Informe o Client ID').max(500, 'Client ID longo demais'),
  client_secret: z.string('Informe o Client Secret').trim().min(1, 'Informe o Client Secret').max(1000, 'Client Secret longo demais'),
})

export const paymentIntegrationUpdateSchema = z.object({
  label: labelSchema.optional(),
  /** Só pode repetir o atual (AC-T109-01). */
  gateway: z.string().optional(),
  client_id: z.string().trim().min(1, 'Informe o Client ID').max(500, 'Client ID longo demais').optional(),
  /** Ausente, vazio ou só espaços: mantém o segredo atual. */
  client_secret: z.string('Client Secret inválido').max(1000, 'Client Secret longo demais').nullish(),
})

export interface PaymentIntegrationDto {
  id: string
  label: string
  gateway: PaymentGatewayId
  client_id: string
  secret_configured: boolean
  /** `…abcd` (últimos 4 caracteres) ou `null`. */
  secret_hint: string | null
  /** URL pública do webhook (sem segredo). */
  webhook_url: string
  zenith_oauth: boolean
  last_tested_at: string | null
  last_test_ok: boolean | null
  created_at: string
  updated_at: string
}

export interface PaymentIntegrationUsage {
  flows: { id: string; name: string }[]
}

export interface PaymentIntegrationsServiceOptions {
  db: Database
  /** Default: o cifrador de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  /** `XPAG_API_URL`, `API_PUBLIC_URL`… lidos a cada chamada. Default `process.env`. */
  env?: Env
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export class PaymentIntegrationsService {
  private readonly db: Database

  constructor(private readonly opts: PaymentIntegrationsServiceOptions) {
    this.db = opts.db
  }

  async list(companyId: string, filter: { gateway?: string } = {}): Promise<PaymentIntegrationDto[]> {
    const where = [eq(paymentIntegrations.companyId, companyId)]
    if (filter.gateway) where.push(eq(paymentIntegrations.gateway, filter.gateway as PaymentGatewayId))
    const rows = await this.db
      .select()
      .from(paymentIntegrations)
      .where(and(...where))
      .orderBy(asc(paymentIntegrations.createdAt), asc(paymentIntegrations.id))
    return rows.map((r) => this.toDto(r))
  }

  async get(companyId: string, id: string): Promise<PaymentIntegrationDto> {
    return this.toDto(await this.row(companyId, id))
  }

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<PaymentIntegrationDto> {
    const data = parse(paymentIntegrationCreateSchema, input)
    const id = randomUUID()
    const now = this.now()
    await this.db.insert(paymentIntegrations).values({
      id,
      companyId,
      label: data.label,
      gateway: data.gateway,
      clientId: data.client_id,
      clientSecretEnc: this.seal(companyId, id, 'client_secret', data.client_secret),
      secretHint: data.client_secret.slice(-4),
      webhookSecretEnc: this.seal(companyId, id, 'webhook_secret', randomBytes(32).toString('base64url')),
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    return this.get(companyId, id)
  }

  async update(companyId: string, id: string, input: unknown): Promise<PaymentIntegrationDto> {
    const data = parse(paymentIntegrationUpdateSchema, input)
    const row = await this.row(companyId, id)
    if (data.gateway !== undefined && data.gateway !== row.gateway) throw invalid('gateway', 'O gateway não pode ser alterado depois de criado')
    const patch: Partial<typeof paymentIntegrations.$inferInsert> = {}
    if (data.label !== undefined) patch.label = data.label
    if (data.client_id !== undefined && data.client_id !== row.clientId) patch.clientId = data.client_id
    const secret = data.client_secret?.trim()
    if (secret) {
      patch.clientSecretEnc = this.seal(companyId, id, 'client_secret', secret)
      patch.secretHint = secret.slice(-4)
    }
    if (patch.clientId !== undefined || patch.clientSecretEnc !== undefined) {
      // Credencial nova: o último teste não vale mais.
      patch.lastTestedAt = null
      patch.lastTestOk = null
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = this.now()
      await this.db.update(paymentIntegrations).set(patch).where(and(eq(paymentIntegrations.companyId, companyId), eq(paymentIntegrations.id, id)))
    }
    return this.get(companyId, id)
  }

  /** Fluxos ATIVOS com bloco Pagamento apontando para a integração (AC-T109-05). */
  async usage(companyId: string, id: string): Promise<PaymentIntegrationUsage> {
    const rows = await this.db
      .selectDistinct({ id: flows.id, name: flows.name })
      .from(flowNodeActions)
      .innerJoin(flowNodes, eq(flowNodes.id, flowNodeActions.nodeId))
      .innerJoin(flows, eq(flows.id, flowNodes.flowId))
      .where(and(eq(flowNodeActions.companyId, companyId), eq(flows.status, 'active'), sql`${flowNodeActions.config}->>'payment_integration_id' = ${id}`))
    return { flows: rows.map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /** Exclui. Em uso por fluxo ativo → `conflict` com a lista de fluxos. */
  async remove(companyId: string, id: string): Promise<{ deleted: PaymentIntegrationDto }> {
    const deleted = await this.get(companyId, id)
    const usage = await this.usage(companyId, id)
    if (usage.flows.length)
      throw new PaymentIntegrationsError('conflict', 'A chave está em uso por blocos de Pagamento de fluxos ativos', { flows: usage.flows })
    await this.db.delete(paymentIntegrations).where(and(eq(paymentIntegrations.companyId, companyId), eq(paymentIntegrations.id, id)))
    return { deleted }
  }

  /** Testa a credencial no gateway (AC-T109-02). Recusa → `{ ok: false, error }` sem a chave. */
  async testConnection(companyId: string, id: string): Promise<ConnectionTestResult> {
    const row = await this.row(companyId, id)
    let result: ConnectionTestResult
    try {
      result = await this.build(row).testConnection()
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : 'falha ao testar a conexão' }
    }
    if (!result.ok) result = { ok: false, error: this.redact(row, result.error ?? 'falha ao testar a conexão') }
    await this.db
      .update(paymentIntegrations)
      .set({ lastTestedAt: this.now(), lastTestOk: result.ok })
      .where(and(eq(paymentIntegrations.companyId, companyId), eq(paymentIntegrations.id, id)))
    return result
  }

  /** Adapter da integração com as credenciais decifradas (bloco Pagamento e webhooks, T111). */
  async gatewayFor(companyId: string, id: string): Promise<PaymentGateway> {
    return this.build(await this.row(companyId, id))
  }

  /** URL pública do webhook de uma integração (sem segredo). */
  webhookUrl(gateway: string, id: string): string {
    const base = (this.env().API_PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '')
    return `${base}/api/hooks/payments/${gateway}/${id}`
  }

  // ---------- internos ----------

  private build(row: Row): PaymentGateway {
    const factory = paymentGatewayFactory(row.gateway)
    if (!factory) throw new PaymentIntegrationsError('upstream', `Gateway ${row.gateway} ainda não disponível`)
    return factory(
      {
        integrationId: row.id,
        companyId: row.companyId,
        clientId: row.clientId,
        clientSecret: row.clientSecretEnc ? this.open(row, 'client_secret', row.clientSecretEnc) : null,
        webhookSecret: this.open(row, 'webhook_secret', row.webhookSecretEnc),
        webhookUrl: this.webhookUrl(row.gateway, row.id),
        extra: row.extraEnc ? (JSON.parse(this.open(row, 'extra', row.extraEnc)) as Record<string, unknown>) : null,
      },
      { env: this.env(), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) },
    )
  }

  private redact(row: Row, text: string): string {
    let out = text
    for (const [field, enc] of [['client_secret', row.clientSecretEnc], ['webhook_secret', row.webhookSecretEnc]] as const) {
      if (!enc) continue
      const s = this.open(row, field, enc)
      if (s) out = out.split(s).join('[redacted]')
    }
    return out.length > 300 ? `${out.slice(0, 300)}…` : out
  }

  private async row(companyId: string, id: string): Promise<Row> {
    if (!z.uuid().safeParse(id).success) throw notFound()
    const [row] = await this.db
      .select()
      .from(paymentIntegrations)
      .where(and(eq(paymentIntegrations.companyId, companyId), eq(paymentIntegrations.id, id)))
      .limit(1)
    if (!row) throw notFound()
    return row
  }

  private toDto(r: Row): PaymentIntegrationDto {
    return {
      id: r.id,
      label: r.label,
      gateway: r.gateway,
      client_id: r.clientId,
      secret_configured: Boolean(r.clientSecretEnc),
      secret_hint: r.secretHint ? `…${r.secretHint}` : null,
      webhook_url: this.webhookUrl(r.gateway, r.id),
      zenith_oauth: r.zenithOauth,
      last_tested_at: iso(r.lastTestedAt),
      last_test_ok: r.lastTestOk,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }

  private aad = (companyId: string, id: string, field: string) => `payment-integration/${companyId}/${id}/${field}`
  private cipher = () => this.opts.cipher ?? getCredentialsCipher()
  private seal = (companyId: string, id: string, field: string, value: string) => serializeEncrypted(this.cipher().encrypt(value, this.aad(companyId, id, field)))
  private open = (r: Row, field: string, enc: string) => this.cipher().decrypt<string>(parseEncrypted<string>(enc), this.aad(r.companyId, r.id, field))
  private env = (): Env => this.opts.env ?? process.env
  private now = () => this.opts.now?.() ?? new Date()
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new PaymentIntegrationsError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  return r.data
}

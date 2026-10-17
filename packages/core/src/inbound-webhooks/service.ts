// Webhooks de entrada (T72; 09-webhooks-entrada.md §3, §5, §6): CRUD, histórico e recepção pública.
// A recepção só grava o request e decide pending/skipped; o processamento (dedupe, contato, etiquetas, Kanban, fluxo)
// é da fila `inbound-webhooks` (T81). Nada aqui processa o payload inline (AC-T72-03).
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { connections, inboundWebhookRequests, inboundWebhooks, type Database, type InboundWebhookRequestStatus, type InboundWebhookStep } from '@crm/db'
import { buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import { companyLimit } from '../admin/limits'
import { inboundWebhookConfigSchema } from './config'

type Env = Record<string, string | undefined>
type Row = typeof inboundWebhooks.$inferSelect
type RequestRow = typeof inboundWebhookRequests.$inferSelect

/** Bytes do corpo guardados em `raw_body`; acima disso `raw_body_truncated = true`. */
export const INBOUND_WEBHOOK_BODY_LIMIT = 256 * 1024
/** Leitura máxima do corpo (hash e tamanho); acima disso a leitura para. */
export const INBOUND_WEBHOOK_READ_LIMIT = 5 * 1024 * 1024
/** Requests mantidos por webhook (`retention_max`). */
export const INBOUND_WEBHOOK_RETENTION = 1000
export const DEFAULT_INBOUND_WEBHOOKS_MONTHLY_LIMIT = 30_000
export const DEFAULT_INBOUND_WEBHOOKS_MAX_PER_COMPANY = 100
export const DEFAULT_INBOUND_WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const

export const INBOUND_WEBHOOKS_QUEUE = 'inbound-webhooks'
export const INBOUND_WEBHOOK_JOB = 'inbound-webhook'
export interface InboundWebhookJobData {
  requestId: string
  webhookId: string
  companyId: string
}
/** jobId do BullMQ (sem `:`), idempotente por request. */
export const inboundWebhookJobId = (requestId: string) => `iwr-${requestId}`

export type InboundWebhooksErrorCode = 'not_found' | 'validation' | 'limit'

export class InboundWebhooksError extends Error {
  constructor(
    readonly code: InboundWebhooksErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'InboundWebhooksError'
  }
}

const notFound = () => new InboundWebhooksError('not_found', 'Webhook não encontrado')
const invalid = (path: string, message: string) => new InboundWebhooksError('validation', message, { fields: [{ path, message }] })

const nameSchema = z.string('Informe o nome do webhook').trim().min(1, 'Informe o nome do webhook').max(120, 'O nome pode ter até 120 caracteres')

export const inboundWebhookCreateSchema = z.object({
  name: nameSchema,
  connection_id: z.uuid('Conexão inválida').nullish(),
  active: z.boolean().optional(),
  config: inboundWebhookConfigSchema.optional(),
})

export const inboundWebhookUpdateSchema = z.object({
  name: nameSchema.optional(),
  connection_id: z.uuid('Conexão inválida').nullish(),
  active: z.boolean().optional(),
  config: inboundWebhookConfigSchema.optional(),
})

export const inboundWebhookRequestsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export interface InboundWebhookRequestDto {
  id: string
  webhook_id: string
  processing_status: InboundWebhookRequestStatus
  raw_body: string
  raw_body_truncated: boolean
  body_size: number
  body_hash: string
  content_type: string | null
  steps: InboundWebhookStep[]
  error: string | null
  reason: string | null
  created_at: string
  processed_at: string | null
}

export interface InboundWebhookDto {
  id: string
  name: string
  connection_id: string | null
  active: boolean
  public_token: string
  public_receive_url: string
  config: Record<string, unknown>
  /** Requests aceitos no mês corrente ("Disparos no mês"). */
  month_count: number
  request_stats: { total: number; processed: number; failed: number; pending: number; skipped: number; retention_max: number }
  last_inbound_webhook_request: { id: string; raw_body: string; raw_body_truncated: boolean; created_at: string } | null
  created_at: string
  updated_at: string
}

/** Corpo lido pela borda HTTP (`readInboundBody`). */
export interface ReceivedBody {
  text: string
  truncated: boolean
  size: number
  hash: string
  contentType: string | null
}

export type ReceiveOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'accepted' | 'inactive' | 'quota'; requestId: string; webhookId: string; companyId: string }

export interface InboundWebhooksServiceOptions {
  db: Database
  /** `API_PUBLIC_URL` (base da URL pública). Default `process.env`. */
  env?: Env
  /** Cota mensal de requests aceitos por empresa (default 30 000). */
  monthlyLimit?: number
  /** Webhooks por empresa (default 100). */
  maxPerCompany?: number
  now?: () => Date
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const monthOf = (d: Date) => d.toISOString().slice(0, 7)
const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/

export class InboundWebhooksService {
  private readonly db: Database

  constructor(private readonly opts: InboundWebhooksServiceOptions) {
    this.db = opts.db
  }

  get monthlyLimit(): number {
    return this.opts.monthlyLimit ?? DEFAULT_INBOUND_WEBHOOKS_MONTHLY_LIMIT
  }

  // ---------- CRUD ----------

  async list(companyId: string): Promise<{ items: InboundWebhookDto[]; usage: { used: number; limit: number } }> {
    const rows = await this.db.select().from(inboundWebhooks).where(eq(inboundWebhooks.companyId, companyId)).orderBy(asc(inboundWebhooks.createdAt), asc(inboundWebhooks.id))
    const items = await Promise.all(rows.map((r) => this.toDto(r)))
    return { items, usage: { used: await this.monthUsage(companyId), limit: this.monthlyLimit } }
  }

  async get(companyId: string, id: string): Promise<InboundWebhookDto> {
    return this.toDto(await this.row(companyId, id))
  }

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<InboundWebhookDto> {
    const data = parse(inboundWebhookCreateSchema, input)
    if (data.connection_id) await this.assertConnection(companyId, data.connection_id)
    const max = this.opts.maxPerCompany ?? DEFAULT_INBOUND_WEBHOOKS_MAX_PER_COMPANY
    const [{ n } = { n: 0 }] = await this.db.select({ n: count() }).from(inboundWebhooks).where(eq(inboundWebhooks.companyId, companyId))
    // Limite da empresa (`settings.limits.webhooks`, T95) substitui o teto fixo quando definido.
    const companyMax = await companyLimit(this.db, companyId, 'webhooks')
    if (companyMax !== null && n >= companyMax)
      throw new InboundWebhooksError('limit', 'Limite de webhooks da empresa atingido', { limit: companyMax, used: n })
    if (companyMax === null && n >= max) throw new InboundWebhooksError('limit', `Limite de ${max} webhooks por empresa atingido`, { limit: max })
    const id = randomUUID()
    const now = this.now()
    await this.db.insert(inboundWebhooks).values({
      id,
      companyId,
      name: data.name,
      connectionId: data.connection_id ?? null,
      active: data.active ?? true,
      publicToken: randomBytes(32).toString('base64url'),
      config: (data.config ?? {}) as Record<string, unknown>,
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    return this.get(companyId, id)
  }

  async update(companyId: string, id: string, input: unknown): Promise<InboundWebhookDto> {
    const data = parse(inboundWebhookUpdateSchema, input)
    await this.row(companyId, id)
    if (data.connection_id) await this.assertConnection(companyId, data.connection_id)
    const patch: Partial<typeof inboundWebhooks.$inferInsert> = {}
    if (data.name !== undefined) patch.name = data.name
    if (data.connection_id !== undefined) patch.connectionId = data.connection_id
    if (data.active !== undefined) patch.active = data.active
    if (data.config !== undefined) patch.config = data.config as Record<string, unknown>
    if (Object.keys(patch).length) {
      patch.updatedAt = this.now()
      await this.db.update(inboundWebhooks).set(patch).where(and(eq(inboundWebhooks.companyId, companyId), eq(inboundWebhooks.id, id)))
    }
    return this.get(companyId, id)
  }

  async remove(companyId: string, id: string): Promise<InboundWebhookDto> {
    const dto = await this.get(companyId, id)
    await this.db.delete(inboundWebhooks).where(and(eq(inboundWebhooks.companyId, companyId), eq(inboundWebhooks.id, id)))
    return dto
  }

  async requests(companyId: string, id: string, query: unknown): Promise<PageResponse<InboundWebhookRequestDto>> {
    await this.row(companyId, id)
    const q = parse(inboundWebhookRequestsQuerySchema, query)
    const where = and(eq(inboundWebhookRequests.companyId, companyId), eq(inboundWebhookRequests.webhookId, id))
    const [rows, [{ n } = { n: 0 }]] = await Promise.all([
      this.db.select().from(inboundWebhookRequests).where(where).orderBy(desc(inboundWebhookRequests.seq)).limit(q.limit).offset(pageOffset(q)),
      this.db.select({ n: count() }).from(inboundWebhookRequests).where(where),
    ])
    return { items: rows.map(requestDto), page: buildPageMeta(q, { total: n }) }
  }

  // ---------- recepção pública ----------

  /** Webhook do token (ou `null`). Formato inválido nem consulta o banco. */
  async findByToken(token: string): Promise<Row | null> {
    if (!TOKEN_RE.test(token)) return null
    const [row] = await this.db.select().from(inboundWebhooks).where(eq(inboundWebhooks.publicToken, token)).limit(1)
    return row ?? null
  }

  /**
   * Grava o request (AC-T72-01..04). Inativo → `skipped`/`webhook_inactive`; cota mensal da empresa esgotada →
   * `skipped`/`monthly_limit_reached`; senão `pending` (+1 no mês) para a fila. Aplica a retenção por webhook.
   */
  async receive(webhook: Row, body: ReceivedBody): Promise<ReceiveOutcome> {
    const now = this.now()
    const period = monthOf(now)
    let outcome: 'accepted' | 'inactive' | 'quota' = 'accepted'
    if (!webhook.active) outcome = 'inactive'
    else if ((await this.monthUsage(webhook.companyId, period)) >= this.monthlyLimit) outcome = 'quota'
    const id = randomUUID()
    await this.db.transaction(async (tx) => {
      await tx.insert(inboundWebhookRequests).values({
        id,
        companyId: webhook.companyId,
        webhookId: webhook.id,
        processingStatus: outcome === 'accepted' ? 'pending' : 'skipped',
        rawBody: body.text,
        rawBodyTruncated: body.truncated,
        bodySize: body.size,
        bodyHash: body.hash,
        contentType: body.contentType,
        error: outcome === 'inactive' ? 'webhook_inactive' : outcome === 'quota' ? 'monthly_limit_reached' : null,
        createdAt: now,
        updatedAt: now,
      })
      if (outcome === 'accepted')
        await tx
          .update(inboundWebhooks)
          .set({
            monthCount: sql`case when ${inboundWebhooks.monthPeriod} = ${period} then ${inboundWebhooks.monthCount} + 1 else 1 end`,
            monthPeriod: period,
          })
          .where(eq(inboundWebhooks.id, webhook.id))
      // Retenção: só os N mais recentes do webhook (o N+1º remove o mais antigo).
      await tx.execute(sql`
        delete from ${inboundWebhookRequests}
        where ${inboundWebhookRequests.webhookId} = ${webhook.id}
          and ${inboundWebhookRequests.seq} <= (
            select r.seq from ${inboundWebhookRequests} r where r.webhook_id = ${webhook.id}
            order by r.seq desc offset ${INBOUND_WEBHOOK_RETENTION} limit 1
          )`)
    })
    return { outcome, requestId: id, webhookId: webhook.id, companyId: webhook.companyId }
  }

  /** URL pública de recepção do token. */
  publicReceiveUrl(token: string): string {
    const base = ((this.opts.env ?? process.env).API_PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '')
    return `${base}/api/hooks/in/${token}`
  }

  // ---------- internos ----------

  /** Requests aceitos no mês pela empresa (soma dos webhooks). */
  private async monthUsage(companyId: string, period = monthOf(this.now())): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`coalesce(sum(${inboundWebhooks.monthCount}), 0)::int` })
      .from(inboundWebhooks)
      .where(and(eq(inboundWebhooks.companyId, companyId), eq(inboundWebhooks.monthPeriod, period)))
    return r?.n ?? 0
  }

  private async assertConnection(companyId: string, connectionId: string): Promise<void> {
    const [c] = await this.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.companyId, companyId), eq(connections.id, connectionId)))
      .limit(1)
    if (!c) throw invalid('connection_id', 'Conexão não encontrada')
  }

  private async row(companyId: string, id: string): Promise<Row> {
    if (!z.uuid().safeParse(id).success) throw notFound()
    const [row] = await this.db
      .select()
      .from(inboundWebhooks)
      .where(and(eq(inboundWebhooks.companyId, companyId), eq(inboundWebhooks.id, id)))
      .limit(1)
    if (!row) throw notFound()
    return row
  }

  private async toDto(r: Row): Promise<InboundWebhookDto> {
    const [stats, [last]] = await Promise.all([
      this.db
        .select({ status: inboundWebhookRequests.processingStatus, n: count() })
        .from(inboundWebhookRequests)
        .where(eq(inboundWebhookRequests.webhookId, r.id))
        .groupBy(inboundWebhookRequests.processingStatus),
      this.db
        .select({ id: inboundWebhookRequests.id, rawBody: inboundWebhookRequests.rawBody, truncated: inboundWebhookRequests.rawBodyTruncated, createdAt: inboundWebhookRequests.createdAt })
        .from(inboundWebhookRequests)
        .where(eq(inboundWebhookRequests.webhookId, r.id))
        .orderBy(desc(inboundWebhookRequests.seq))
        .limit(1),
    ])
    const by = (s: InboundWebhookRequestStatus) => stats.find((x) => x.status === s)?.n ?? 0
    return {
      id: r.id,
      name: r.name,
      connection_id: r.connectionId,
      active: r.active,
      public_token: r.publicToken,
      public_receive_url: this.publicReceiveUrl(r.publicToken),
      config: r.config,
      month_count: r.monthPeriod === monthOf(this.now()) ? r.monthCount : 0,
      request_stats: {
        total: stats.reduce((a, x) => a + x.n, 0),
        processed: by('processed'),
        failed: by('failed'),
        pending: by('pending'),
        skipped: by('skipped'),
        retention_max: INBOUND_WEBHOOK_RETENTION,
      },
      last_inbound_webhook_request: last ? { id: last.id, raw_body: last.rawBody, raw_body_truncated: last.truncated, created_at: last.createdAt.toISOString() } : null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }

  private now = () => this.opts.now?.() ?? new Date()
}

function requestDto(r: RequestRow): InboundWebhookRequestDto {
  return {
    id: r.id,
    webhook_id: r.webhookId,
    processing_status: r.processingStatus,
    raw_body: r.rawBody,
    raw_body_truncated: r.rawBodyTruncated,
    body_size: r.bodySize,
    body_hash: r.bodyHash,
    content_type: r.contentType,
    steps: r.steps,
    error: r.error,
    reason: r.reason,
    created_at: r.createdAt.toISOString(),
    processed_at: iso(r.processedAt),
  }
}

/**
 * Lê o corpo guardando os primeiros `storeLimit` bytes; segue contando e calculando o hash até `readLimit`
 * (acima disso para de ler e marca truncado). Texto sem NUL (o Postgres não aceita `\0` em text).
 */
export async function readInboundBody(
  stream: ReadableStream<Uint8Array> | null,
  opts: { contentType?: string | null; storeLimit?: number; readLimit?: number } = {},
): Promise<ReceivedBody> {
  const storeLimit = opts.storeLimit ?? INBOUND_WEBHOOK_BODY_LIMIT
  const readLimit = Math.max(storeLimit, opts.readLimit ?? INBOUND_WEBHOOK_READ_LIMIT)
  const hash = createHash('sha256')
  const kept: Uint8Array[] = []
  let keptBytes = 0
  let size = 0
  let truncated = false
  if (stream) {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        const room = readLimit - size
        const chunk = value.byteLength > room ? value.subarray(0, room) : value
        hash.update(chunk)
        size += chunk.byteLength
        if (keptBytes < storeLimit) {
          const part = chunk.subarray(0, storeLimit - keptBytes)
          kept.push(part)
          keptBytes += part.byteLength
        }
        if (size > storeLimit) truncated = true
        if (value.byteLength > room || size >= readLimit) {
          truncated = true
          await reader.cancel().catch(() => undefined)
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(kept)).replace(/\0/g, '')
  return { text, truncated, size, hash: hash.digest('hex'), contentType: opts.contentType?.slice(0, 200) ?? null }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new InboundWebhooksError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  return r.data
}

// Fontes de venda por webhook genérico (T73): CRUD com token público e segredo HMAC opcional (cifrado), recepção
// (`receive`: HMAC em tempo constante → grava o evento `pending`), teste do mapeamento sem gravar, lista de eventos,
// replay e rotação do token. O processamento do evento fica em `processor.ts` (job `inbound-sales`).
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, asc, count, desc, eq } from 'drizzle-orm'
import { inboundSaleEvents, saleSources, type Database, type InboundSaleEventStatus } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'
import { z } from 'zod'
import { resolveSaleEvent, SALE_EVENT_FIELDS, SALE_EVENT_STATUSES, type ResolveResult } from './mapping'

export const INBOUND_SALES_QUEUE = 'inbound-sales'
export const INBOUND_SALE_JOB = 'inbound-sale'
export const SALE_HOOK_BODY_LIMIT = 256 * 1024
export const DEFAULT_SALE_HOOK_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const
export const SALE_SIGNATURE_HEADER = 'x-signature'

export interface InboundSaleJobData {
  eventId: string
  saleSourceId: string
  companyId: string
}
export const inboundSaleJobId = (eventId: string, attempt = 0) => (attempt > 0 ? `ise-${eventId}-r${attempt}` : `ise-${eventId}`)

export class SaleSourcesError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation' | 'invalid_signature' | 'malformed',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SaleSourcesError'
  }
}

const mappingSchema = z.partialRecord(z.enum(SALE_EVENT_FIELDS), z.string().trim().min(1).max(300))
const statusMapSchema = z.record(z.string().trim().min(1).max(100), z.enum(SALE_EVENT_STATUSES))
const baseSchema = {
  name: z.string().trim().min(2, 'O nome deve ter de 2 a 120 caracteres').max(120, 'O nome deve ter de 2 a 120 caracteres'),
  active: z.boolean(),
  hmac_secret: z.string().max(500).nullable(),
  mapping: mappingSchema,
  status_map: statusMapSchema,
  amount_unit: z.enum(['decimal', 'cents']),
}
export const saleSourceCreateSchema = z.object({ ...baseSchema, active: baseSchema.active.optional(), hmac_secret: baseSchema.hmac_secret.optional(), mapping: baseSchema.mapping.optional(), status_map: baseSchema.status_map.optional(), amount_unit: baseSchema.amount_unit.optional() })
export const saleSourceUpdateSchema = z.object(baseSchema).partial()
export const saleSourceTestSchema = z.object({
  sample: z.unknown(),
  mapping: mappingSchema.optional(),
  status_map: statusMapSchema.optional(),
  amount_unit: baseSchema.amount_unit.optional(),
})

export interface SaleSourceDto {
  id: string
  name: string
  active: boolean
  token: string
  public_url: string
  hmac_configured: boolean
  mapping: Record<string, string>
  status_map: Record<string, string>
  amount_unit: 'decimal' | 'cents'
  created_at: string
  updated_at: string
}

export interface InboundSaleEventDto {
  id: string
  sale_source_id: string
  status: InboundSaleEventStatus
  raw_body: string
  sale_event: Record<string, unknown> | null
  error: string | null
  missing: { field: string; path: string }[]
  sale_id: string | null
  contact_id: string | null
  attempts: number
  processed_at: string | null
  created_at: string
  updated_at: string
}

export interface SaleSourcesServiceOptions {
  db: Database
  cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>
  /** `API_PUBLIC_URL`. Default `process.env`. */
  env?: Record<string, string | undefined>
  now?: () => Date
}

type Row = typeof saleSources.$inferSelect
type EventRow = typeof inboundSaleEvents.$inferSelect
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/
const newToken = () => randomBytes(32).toString('base64url')

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success) throw new SaleSourcesError('validation', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  return r.data
}

const lowerKeys = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]))

export class SaleSourcesService {
  constructor(private readonly opts: SaleSourcesServiceOptions) {}

  private get db() {
    return this.opts.db
  }
  private now() {
    return this.opts.now?.() ?? new Date()
  }
  private cipher() {
    return this.opts.cipher ?? getCredentialsCipher()
  }
  private aad = (r: { companyId: string; id: string }) => `sale-source/${r.companyId}/${r.id}/hmac`

  publicUrl(token: string): string {
    const base = ((this.opts.env ?? process.env).API_PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '')
    return `${base}/api/hooks/sales/${token}`
  }

  // ------------------------------------------------------------------ CRUD

  async list(companyId: string): Promise<SaleSourceDto[]> {
    const rows = await this.db.select().from(saleSources).where(eq(saleSources.companyId, companyId)).orderBy(asc(saleSources.createdAt), asc(saleSources.id))
    return rows.map((r) => this.toDto(r))
  }

  async get(companyId: string, id: string): Promise<SaleSourceDto> {
    return this.toDto(await this.row(companyId, id))
  }

  async create(companyId: string, input: unknown, actorUserId: string | null = null): Promise<SaleSourceDto> {
    const d = parse(saleSourceCreateSchema, input)
    const id = randomUUID()
    const secret = d.hmac_secret?.trim()
    const [row] = await this.db
      .insert(saleSources)
      .values({
        id,
        companyId,
        name: d.name,
        active: d.active ?? true,
        token: newToken(),
        hmacSecretEnc: secret ? serializeEncrypted(this.cipher().encrypt(secret, this.aad({ companyId, id }))) : null,
        mapping: d.mapping ?? {},
        statusMap: lowerKeys(d.status_map),
        amountUnit: d.amount_unit ?? 'decimal',
        createdByUserId: actorUserId,
      })
      .returning()
    return this.toDto(row!)
  }

  /** `hmac_secret` `''`/`null` remove o HMAC; ausente mantém. */
  async update(companyId: string, id: string, input: unknown): Promise<SaleSourceDto> {
    const cur = await this.row(companyId, id)
    const d = parse(saleSourceUpdateSchema, input)
    const patch: Partial<typeof saleSources.$inferInsert> = { updatedAt: this.now() }
    if (d.name !== undefined) patch.name = d.name
    if (d.active !== undefined) patch.active = d.active
    if (d.mapping !== undefined) patch.mapping = d.mapping
    if (d.status_map !== undefined) patch.statusMap = lowerKeys(d.status_map)
    if (d.amount_unit !== undefined) patch.amountUnit = d.amount_unit
    if (d.hmac_secret !== undefined) {
      const secret = d.hmac_secret?.trim()
      patch.hmacSecretEnc = secret ? serializeEncrypted(this.cipher().encrypt(secret, this.aad(cur))) : null
    }
    const [row] = await this.db.update(saleSources).set(patch).where(eq(saleSources.id, cur.id)).returning()
    return this.toDto(row!)
  }

  async remove(companyId: string, id: string): Promise<void> {
    const cur = await this.row(companyId, id)
    await this.db.delete(saleSources).where(eq(saleSources.id, cur.id))
  }

  /** Token novo; a URL antiga deixa de existir (404). */
  async rotateToken(companyId: string, id: string): Promise<SaleSourceDto> {
    const cur = await this.row(companyId, id)
    const [row] = await this.db.update(saleSources).set({ token: newToken(), updatedAt: this.now() }).where(eq(saleSources.id, cur.id)).returning()
    return this.toDto(row!)
  }

  // ------------------------------------------------------------------ recepção pública

  /** Fonte ativa do token (inexistente ou inativa → null = 404). */
  async findByToken(token: string): Promise<Row | null> {
    if (!TOKEN_RE.test(token)) return null
    const [row] = await this.db.select().from(saleSources).where(eq(saleSources.token, token)).limit(1)
    return row && row.active ? row : null
  }

  /**
   * Autentica (HMAC-SHA256 do corpo cru em hex, header `x-signature`, com ou sem `sha256=`, tempo constante) e grava o
   * evento `pending`. Assinatura ausente/errada com segredo configurado → `invalid_signature` (nada gravado).
   */
  async receive(source: Row, rawBody: string, signature: string | null | undefined): Promise<InboundSaleJobData> {
    if (source.hmacSecretEnc) {
      const secret = this.cipher().decrypt<string>(parseEncrypted<string>(source.hmacSecretEnc), this.aad(source))
      const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
      const got = (signature ?? '').trim().replace(/^sha256=/i, '').toLowerCase()
      const a = Buffer.from(got)
      const b = Buffer.from(expected)
      if (!got || a.length !== b.length || !timingSafeEqual(a, b)) throw new SaleSourcesError('invalid_signature', 'Assinatura inválida')
    }
    try {
      JSON.parse(rawBody)
    } catch {
      throw new SaleSourcesError('malformed', 'JSON inválido')
    }
    const [ev] = await this.db.insert(inboundSaleEvents).values({ companyId: source.companyId, saleSourceId: source.id, status: 'pending', rawBody }).returning({ id: inboundSaleEvents.id })
    return { eventId: ev!.id, saleSourceId: source.id, companyId: source.companyId }
  }

  // ------------------------------------------------------------------ teste, eventos, replay

  /** Dry-run do mapeamento (o que vier no corpo sobrepõe o salvo). Não grava nada. */
  async test(companyId: string, id: string | null, input: unknown): Promise<ResolveResult> {
    const d = parse(saleSourceTestSchema, input)
    const cur = id ? await this.row(companyId, id) : null
    let sample = d.sample
    if (typeof sample === 'string') {
      try {
        sample = JSON.parse(sample)
      } catch {
        throw new SaleSourcesError('validation', 'Amostra com JSON inválido', { fields: [{ path: 'sample', message: 'JSON inválido' }] })
      }
    }
    return resolveSaleEvent(sample, {
      mapping: d.mapping ?? cur?.mapping ?? {},
      statusMap: d.status_map ?? cur?.statusMap ?? {},
      amountUnit: d.amount_unit ?? cur?.amountUnit ?? 'decimal',
    })
  }

  async events(companyId: string, id: string, q: { status?: string; page?: number; limit?: number } = {}): Promise<{ items: InboundSaleEventDto[]; total: number; page: number; limit: number }> {
    const cur = await this.row(companyId, id)
    const page = Math.max(1, Math.floor(q.page ?? 1))
    const limit = Math.max(1, Math.min(Math.floor(q.limit ?? 20), 100))
    const where = [eq(inboundSaleEvents.saleSourceId, cur.id)]
    if (q.status && ['pending', 'processed', 'failed'].includes(q.status)) where.push(eq(inboundSaleEvents.status, q.status as InboundSaleEventStatus))
    const [rows, [total]] = await Promise.all([
      this.db.select().from(inboundSaleEvents).where(and(...where)).orderBy(desc(inboundSaleEvents.seq)).limit(limit).offset((page - 1) * limit),
      this.db.select({ n: count() }).from(inboundSaleEvents).where(and(...where)),
    ])
    return { items: rows.map(eventDto), total: total?.n ?? 0, page, limit }
  }

  /** Replay: volta o evento a `pending` (o processador relê o mapeamento atual); devolve o jobId novo. */
  async replay(companyId: string, id: string, eventId: string): Promise<{ event: InboundSaleEventDto; job: InboundSaleJobData; jobId: string }> {
    const cur = await this.row(companyId, id)
    if (!UUID_RE.test(eventId)) throw new SaleSourcesError('not_found', 'Evento não encontrado')
    const [ev] = await this.db.select().from(inboundSaleEvents).where(and(eq(inboundSaleEvents.id, eventId), eq(inboundSaleEvents.saleSourceId, cur.id))).limit(1)
    if (!ev) throw new SaleSourcesError('not_found', 'Evento não encontrado')
    const [row] = await this.db
      .update(inboundSaleEvents)
      .set({ status: 'pending', error: null, missing: [], updatedAt: this.now() })
      .where(eq(inboundSaleEvents.id, ev.id))
      .returning()
    return { event: eventDto(row!), job: { eventId: ev.id, saleSourceId: cur.id, companyId }, jobId: inboundSaleJobId(ev.id, row!.attempts + 1) }
  }

  // ------------------------------------------------------------------ internos

  private async row(companyId: string, id: string): Promise<Row> {
    if (!UUID_RE.test(id)) throw new SaleSourcesError('not_found', 'Fonte de venda não encontrada')
    const [row] = await this.db.select().from(saleSources).where(and(eq(saleSources.companyId, companyId), eq(saleSources.id, id))).limit(1)
    if (!row) throw new SaleSourcesError('not_found', 'Fonte de venda não encontrada')
    return row
  }

  private toDto(r: Row): SaleSourceDto {
    return {
      id: r.id,
      name: r.name,
      active: r.active,
      token: r.token,
      public_url: this.publicUrl(r.token),
      hmac_configured: Boolean(r.hmacSecretEnc),
      mapping: r.mapping,
      status_map: r.statusMap,
      amount_unit: r.amountUnit,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }
}

export function eventDto(r: EventRow): InboundSaleEventDto {
  return {
    id: r.id,
    sale_source_id: r.saleSourceId,
    status: r.status,
    raw_body: r.rawBody,
    sale_event: r.saleEvent ?? null,
    error: r.error,
    missing: r.missing,
    sale_id: r.saleId,
    contact_id: r.contactId,
    attempts: r.attempts,
    processed_at: r.processedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

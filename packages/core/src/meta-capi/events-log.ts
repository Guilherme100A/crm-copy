// Diagnóstico "Eventos enviados" do pixel (revisão 3): lista o `capi_event_log` com status (aceito pela Meta com
// `events_received`, recusado com mensagem/`fbtrace_id`, descartado e motivo, pendente), modo usado
// (business_messaging/chat/system_generated), NOMES dos identificadores enviados (nunca os valores) e a pontuação
// estimada de correspondência. Filtros por status, modo, evento, origem e período; paginação por página.
// Resposta da Meta: https://developers.facebook.com/docs/marketing-api/reference/ads-pixel/events/
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { capiEventLog, pixelConfigs, type CapiEventStatus, type Database } from '@crm/db'
import { buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import { MATCH_SCORE_MAX } from './hashing'
import { PixelConfigError } from './pixels'

export interface CapiEventLogQuery {
  page: number
  limit: number
  status?: CapiEventStatus
  mode?: string
  event_name?: string
  source?: string
  from?: Date
  to?: Date
}

export interface CapiEventLogDto {
  id: string
  event_id: string
  event_name: string
  /** Nome enviado à Meta (LeadSubmitted no modo business_messaging). */
  sent_event_name: string
  status: CapiEventStatus
  mode: string
  source: string
  source_id: string | null
  event_time: string | null
  identifiers: string[]
  match_score: number | null
  match_score_max: number
  match_level: 'low' | 'medium' | 'high' | null
  test_event: boolean
  value: number | null
  currency: string | null
  events_received: number | null
  fbtrace_id: string | null
  error: string | null
  /** O business_messaging foi recusado e o evento foi aceito no modo padrão. */
  fallback: { error: string | null; fbtrace_id: string | null } | null
  created_at: string
  updated_at: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function matchLevel(score: number | null | undefined): CapiEventLogDto['match_level'] {
  if (score === null || score === undefined) return null
  if (score >= 3) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

type Row = typeof capiEventLog.$inferSelect

export function toCapiEventLogDto(r: Row): CapiEventLogDto {
  const resp = (r.response ?? {}) as Record<string, unknown>
  const bm = (resp.business_messaging ?? null) as Record<string, unknown> | null
  const cd = (r.customData ?? {}) as Record<string, unknown>
  return {
    id: r.id,
    event_id: r.eventId,
    event_name: r.eventName,
    sent_event_name: r.actionSource === 'business_messaging' && r.eventName === 'Lead' ? 'LeadSubmitted' : r.eventName,
    status: r.status,
    mode: r.actionSource,
    source: r.source,
    source_id: r.sourceId,
    event_time: r.eventTime?.toISOString() ?? null,
    identifiers: r.identifiers ?? [],
    match_score: r.matchScore,
    match_score_max: MATCH_SCORE_MAX,
    match_level: matchLevel(r.matchScore),
    test_event: r.testEvent,
    value: typeof cd.value === 'number' ? cd.value : null,
    currency: typeof cd.currency === 'string' ? cd.currency : null,
    events_received: typeof resp.events_received === 'number' ? resp.events_received : null,
    fbtrace_id: typeof resp.fbtrace_id === 'string' ? resp.fbtrace_id : null,
    error: r.error,
    fallback: bm?.rejected ? { error: typeof bm.error === 'string' ? bm.error : null, fbtrace_id: typeof bm.fbtrace_id === 'string' ? bm.fbtrace_id : null } : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

export class CapiEventLogService {
  constructor(private readonly opts: { db: Database }) {}

  async list(companyId: string, pixelConfigId: string, q: CapiEventLogQuery): Promise<PageResponse<CapiEventLogDto> & { summary: Record<CapiEventStatus, number> }> {
    if (!UUID_RE.test(pixelConfigId)) throw new PixelConfigError('not_found', 'Pixel não encontrado')
    const db = this.opts.db
    const [pixel] = await db
      .select({ id: pixelConfigs.id })
      .from(pixelConfigs)
      .where(and(eq(pixelConfigs.companyId, companyId), eq(pixelConfigs.id, pixelConfigId)))
    if (!pixel) throw new PixelConfigError('not_found', 'Pixel não encontrado')
    const base: SQL[] = [eq(capiEventLog.companyId, companyId), eq(capiEventLog.pixelConfigId, pixelConfigId)]
    if (q.mode) base.push(eq(capiEventLog.actionSource, q.mode))
    if (q.event_name) base.push(eq(capiEventLog.eventName, q.event_name))
    if (q.source) base.push(eq(capiEventLog.source, q.source))
    if (q.from) base.push(gte(capiEventLog.createdAt, q.from))
    if (q.to) base.push(lte(capiEventLog.createdAt, q.to))
    const where = and(...base, ...(q.status ? [eq(capiEventLog.status, q.status)] : []))
    const [rows, [total], byStatus] = await Promise.all([
      db.select().from(capiEventLog).where(where).orderBy(desc(capiEventLog.createdAt), desc(capiEventLog.id)).limit(q.limit).offset(pageOffset(q)),
      db.select({ n: count() }).from(capiEventLog).where(where),
      db
        .select({ status: capiEventLog.status, n: count() })
        .from(capiEventLog)
        .where(and(...base))
        .groupBy(capiEventLog.status),
    ])
    const summary = { pending: 0, sent: 0, failed: 0, discarded: 0 } as Record<CapiEventStatus, number>
    for (const s of byStatus) summary[s.status] = s.n
    return { items: rows.map(toCapiEventLogDto), page: buildPageMeta(q, { total: total?.n ?? 0 }), summary }
  }
}

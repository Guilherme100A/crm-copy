// Lead automático na 1ª mensagem vinda de anúncio (revisão 3): quando chega uma mensagem de contato que veio de um
// anúncio de clique para WhatsApp (`ctwa_clid` no `externalAdReply`) ou de um link rastreável, o worker enfileira um
// job `meta-capi` `ad_lead`, que manda `Lead` (LeadSubmitted no modo business_messaging) para cada pixel da empresa com
// `auto_lead_on_ad`. Dedupe por contato: `event_id = ad-lead-<contactId>` (o `capi_event_log` impede o 2º POST) e o
// `jobId` do BullMQ igual.
import { and, eq } from 'drizzle-orm'
import { pixelConfigs, type Database } from '@crm/db'
import type { CapiSaleOutcome, MetaCapiSaleJobData } from './sales'
import type { CapiActionSource, CapiEventName, CapiService, CapiSource } from './service'

export interface MetaCapiAdLeadJobData {
  kind: 'ad_lead'
  companyId: string
  contactId: string
  /** Hora da mensagem (ISO), vira o `event_time`. */
  at?: string
  /** `ctwa` (anúncio de clique para WhatsApp) ou `link` (link rastreável). */
  via?: 'ctwa' | 'link'
}

export type MetaCapiJobData = MetaCapiSaleJobData | MetaCapiAdLeadJobData | MetaCapiEventJobData

export const isAdLeadJob = (d: MetaCapiJobData): d is MetaCapiAdLeadJobData => (d as { kind?: unknown }).kind === 'ad_lead'
export const adLeadEventId = (contactId: string) => `ad-lead-${contactId}`
export const adLeadJobId = (contactId: string) => `capi-ad-lead-${contactId}`

export type CapiAdLeadEnqueue = (data: MetaCapiAdLeadJobData, opts: { jobId: string }) => Promise<void>

/** Manda o Lead do contato para os pixels com `auto_lead_on_ad`. Sem pixel com a opção: nada. */
export async function sendAdLeadToPixels(deps: { db: Database; capi: Pick<CapiService, 'send' | 'userFromContact'> }, data: MetaCapiAdLeadJobData): Promise<CapiSaleOutcome[]> {
  const pixels = await deps.db
    .select({ id: pixelConfigs.id })
    .from(pixelConfigs)
    .where(and(eq(pixelConfigs.companyId, data.companyId), eq(pixelConfigs.autoLeadOnAd, true)))
  if (!pixels.length) return []
  const user = await deps.capi.userFromContact(data.companyId, data.contactId)
  if (!user.externalId) return []
  const at = data.at ? new Date(data.at) : undefined
  const out: CapiSaleOutcome[] = []
  for (const p of pixels) {
    const result = await deps.capi.send({
      companyId: data.companyId,
      pixelConfigId: p.id,
      eventName: 'Lead',
      eventId: adLeadEventId(data.contactId),
      ...(at && Number.isFinite(at.getTime()) ? { eventTime: at } : {}),
      user,
      actionSource: 'chat',
      source: 'ad_lead',
      sourceId: data.contactId,
    })
    out.push({ pixelConfigId: p.id, result })
  }
  return out
}

// ---- Retentativa de um evento do nó Pixel (revisão 3) ---------------------------------------------------------------
// Resultado `uncertain` (timeout/rede/5xx) no nó Pixel: o passo do fluxo não repete o POST (`ctx.once`), então o nó
// enfileira este job, que reenvia o MESMO evento (mesmo `event_id`, mesmo `event_time` e mesmo modo, lidos do
// `capi_event_log`) com o backoff da fila `meta-capi`.

export interface MetaCapiEventJobData {
  kind: 'event'
  companyId: string
  pixelConfigId: string
  eventName: CapiEventName
  eventId: string
  value?: string | number | null
  currency?: string | null
  contactId?: string | null
  actionSource?: CapiActionSource
  source: CapiSource
  sourceId?: string | null
  pageId?: string | null
  wabaId?: string | null
}

export const isEventJob = (d: MetaCapiJobData): d is MetaCapiEventJobData => (d as { kind?: unknown }).kind === 'event'
export const eventJobId = (pixelConfigId: string, eventId: string) => `capi-event-${pixelConfigId}-${eventId}`
export type CapiEventEnqueue = (data: MetaCapiEventJobData, opts: { jobId: string }) => Promise<void>

export async function sendEventJob(deps: { capi: Pick<CapiService, 'send' | 'userFromContact'> }, data: MetaCapiEventJobData): Promise<CapiSaleOutcome[]> {
  const user = await deps.capi.userFromContact(data.companyId, data.contactId ?? null)
  const result = await deps.capi.send({
    companyId: data.companyId,
    pixelConfigId: data.pixelConfigId,
    eventName: data.eventName,
    eventId: data.eventId,
    value: data.value ?? null,
    currency: data.currency ?? null,
    user,
    ...(data.actionSource ? { actionSource: data.actionSource } : {}),
    source: data.source,
    sourceId: data.sourceId ?? null,
    pageId: data.pageId ?? null,
    wabaId: data.wabaId ?? null,
  })
  return [{ pixelConfigId: data.pixelConfigId, result }]
}

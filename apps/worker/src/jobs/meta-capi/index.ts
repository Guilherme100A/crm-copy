// Job `meta-capi` (T104; revisão 3). Três tipos de job na mesma fila:
// - venda (`{ companyId, saleId }`): `Purchase` de cada venda registrada (`sale.recorded`) para os pixels com
//   `auto_send_sales` (`event_id = sale-<id>`);
// - `ad_lead`: Lead automático da 1ª mensagem vinda de anúncio para os pixels com `auto_lead_on_ad`
//   (`event_id = ad-lead-<contactId>`);
// - `event`: retentativa de um evento do nó Pixel que ficou incerto (timeout/rede/5xx).
// O dedupe é do `capi_event_log` (mesmo `event_id`): reprocessar o job não reenvia o que já foi aceito. Rejeição da Meta
// fica no log (`failed`) e incerto fica `uncertain`; nos dois casos o job lança para o BullMQ tentar de novo — com o
// MESMO payload e, quando fixado, o MESMO modo (o CapiService lê isso do log). Descartado (> 7 dias) não lança.
// T126: venda ainda não visível (job antes do commit de quem a gravou) tenta de novo em poucos segundos.
import {
  CapiService,
  META_CAPI_QUEUE,
  adLeadJobId,
  defineQueue,
  isAdLeadJob,
  isEventJob,
  isSaleNotVisibleError,
  sendAdLeadToPixels,
  sendEventJob,
  sendSaleToPixels,
  type CapiAdLeadEnqueue,
  type CapiSaleOutcome,
  type CapiServiceOptions,
  type CrmInboundEvent,
  type MetaCapiJobData,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { META_CAPI_QUEUE } from '@crm/core'

/** Enfileirador da fila `meta-capi` (venda, `ad_lead` e `event`). */
export type MetaCapiEnqueue = (data: MetaCapiJobData, opts: { jobId: string }) => Promise<void>

/** Estratégia de backoff própria do job (`settings.backoffStrategy` do worker). */
export const META_CAPI_BACKOFF = 'meta-capi'
/** Falha/incerto da Meta: 30 s, 60 s, 120 s… (como antes da T126). */
export const META_CAPI_RETRY_BASE_MS = 30_000
/** Venda ainda não visível: 2 s, 4 s, 8 s, 16 s; com 5 tentativas, uma venda que nunca aparece (rollback) termina `failed`. */
export const META_CAPI_NOT_VISIBLE_BASE_MS = 2_000

export const META_CAPI_QUEUE_OPTS = { defaultJobOptions: { attempts: 5, backoff: { type: META_CAPI_BACKOFF } } } as const

/** Atraso até a próxima tentativa (`attemptsMade` = tentativas já feitas, ≥ 1). */
export function metaCapiBackoff(attemptsMade: number, _type?: string, err?: Error): number {
  const base = isSaleNotVisibleError(err) ? META_CAPI_NOT_VISIBLE_BASE_MS : META_CAPI_RETRY_BASE_MS
  return Math.round(2 ** (Math.max(1, attemptsMade) - 1) * base)
}

type MetaCapiDeps = Partial<Omit<CapiServiceOptions, 'db'>> & { db?: Database }
let configured: MetaCapiDeps = {}

/** Dependências do processo (`db` obrigatório; Graph/`fetch`/`testEventCode` opcionais). */
export function configureMetaCapi(deps: MetaCapiDeps): void {
  configured = { ...configured, ...deps }
}

export function createMetaCapiProcessor(deps: { deps: () => MetaCapiDeps }): Processor<MetaCapiJobData, CapiSaleOutcome[]> {
  return async (job: Pick<Job<MetaCapiJobData>, 'data'>) => {
    const { db, ...opts } = deps.deps()
    if (!db) throw new Error('meta-capi: dependências não configuradas (configureMetaCapi({ db }))')
    const capi = new CapiService({ ...opts, db })
    const data = job.data
    const out = isEventJob(data) ? await sendEventJob({ capi }, data) : isAdLeadJob(data) ? await sendAdLeadToPixels({ db, capi }, data) : await sendSaleToPixels({ db, capi }, data)
    const retry = out.filter((o) => o.result.status === 'failed' || o.result.status === 'uncertain')
    if (retry.length)
      throw new Error(`meta-capi: ${retry.length} envio(s) sem aceite: ${retry.map((f) => (f.result.status === 'failed' || f.result.status === 'uncertain' ? `${f.result.status}: ${f.result.error}` : '')).join('; ')}`)
    return out
  }
}

/** `enqueue` do `capiSalePublisher` (e dos jobs `ad_lead`/`event`) a partir da fila `meta-capi` (prefixo `CRM_QUEUE_PREFIX`). */
export function metaCapiEnqueuer(queue = defineQueue<MetaCapiJobData>(META_CAPI_QUEUE, META_CAPI_QUEUE_OPTS)): MetaCapiEnqueue {
  return async (data: MetaCapiJobData, opts: { jobId: string }) => {
    await queue.add(META_CAPI_QUEUE, data, { jobId: opts.jobId })
  }
}

/**
 * Ouvinte do `crm.inbound`: mensagem que veio de anúncio (`ad_source`) enfileira o Lead automático do contato. O job só
 * envia para pixels com `auto_lead_on_ad`; o dedupe por contato (jobId e event_id) garante um Lead por contato.
 */
export function adLeadInboundListener(enqueue: CapiAdLeadEnqueue, logger?: { warn(obj: object, msg?: string): void }) {
  return async (e: CrmInboundEvent): Promise<void> => {
    if (!e.ad_source) return
    try {
      await enqueue({ kind: 'ad_lead', companyId: e.company_id, contactId: e.contact_id, at: new Date().toISOString(), via: e.ad_source }, { jobId: adLeadJobId(e.contact_id) })
    } catch (err) {
      logger?.warn({ err, contactId: e.contact_id }, 'falha ao enfileirar o Lead automático de anúncio')
    }
  }
}

/** Registra fila e worker `meta-capi`. Com `deps`, usa essas (testes); sem, as do processo. */
export function registerMetaCapiJob(registry: WorkerRegistry, deps?: MetaCapiDeps): WorkerRegistry {
  registry.queue(META_CAPI_QUEUE, META_CAPI_QUEUE_OPTS)
  registry.worker<MetaCapiJobData, CapiSaleOutcome[]>(META_CAPI_QUEUE, createMetaCapiProcessor({ deps: () => deps ?? configured }), {
    settings: { backoffStrategy: metaCapiBackoff },
  })
  return registry
}

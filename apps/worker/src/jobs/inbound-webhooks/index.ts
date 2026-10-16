// Job `inbound-webhooks` (T81): processa cada request aceito pela recepção pública da T72 (job `inbound-webhook`,
// jobId `iwr-<requestId>`) e, no job repetível `inbound-webhooks-sweep`, reenfileira os `pending` cujo enqueue falhou.
import {
  defineQueue,
  INBOUND_WEBHOOK_JOB,
  INBOUND_WEBHOOKS_QUEUE,
  InboundWebhookProcessor,
  type InboundProcessResult,
  type InboundWebhookJobData,
  type InboundWebhookProcessorOptions,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor, Queue } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { INBOUND_WEBHOOKS_QUEUE } from '@crm/core'
export const INBOUND_WEBHOOKS_SWEEP_JOB = 'inbound-webhooks-sweep'
/** Varredura dos `pending` a cada minuto. */
export const INBOUND_WEBHOOKS_SWEEP_EVERY_MS = 60_000

type InboundWebhooksDeps = Partial<Omit<InboundWebhookProcessorOptions, 'db'>> & { db?: Database }
let configured: InboundWebhooksDeps = {}
let processProcessor: InboundWebhookProcessor | undefined

/** Dependências do processo: `db`, o motor (`engine` com enqueue do flow-step), o `control`, o `redis` e o `publisher`. */
export function configureInboundWebhooks(deps: InboundWebhooksDeps): void {
  configured = { ...configured, ...deps }
  processProcessor = undefined
}

/** Processador do processo; `undefined` enquanto `configureInboundWebhooks({ db })` não foi chamado. */
export function inboundWebhookProcessor(): InboundWebhookProcessor | undefined {
  if (processProcessor) return processProcessor
  const { db, ...rest } = configured
  if (!db) return undefined
  processProcessor = new InboundWebhookProcessor({ ...rest, db })
  return processProcessor
}

export function createInboundWebhookProcessor(deps: {
  processor: () => Pick<InboundWebhookProcessor, 'process' | 'sweepPending'> | undefined
  /** Reenfileirador da varredura (default: a fila `inbound-webhooks`). */
  enqueue?: (data: InboundWebhookJobData, opts: { jobId: string }) => Promise<void>
}): Processor<InboundWebhookJobData | Record<string, never>, InboundProcessResult | { swept: number }> {
  let queue: Queue<InboundWebhookJobData> | undefined
  const enqueue =
    deps.enqueue ??
    (async (data: InboundWebhookJobData, opts: { jobId: string }) => {
      queue ??= defineQueue<InboundWebhookJobData>(INBOUND_WEBHOOKS_QUEUE)
      await queue.add(INBOUND_WEBHOOK_JOB, data, { jobId: opts.jobId })
    })
  return async (job: Pick<Job<InboundWebhookJobData | Record<string, never>>, 'name' | 'data'>) => {
    const p = deps.processor()
    if (!p) throw new Error('inbound-webhooks: dependências não configuradas (configureInboundWebhooks({ db, engine, control }))')
    if (job.name === INBOUND_WEBHOOKS_SWEEP_JOB) return { swept: await p.sweepPending({}, enqueue) }
    return p.process(job.data as InboundWebhookJobData)
  }
}

/** Agenda a varredura repetível (chamar no boot do worker). */
export async function scheduleInboundWebhooksSweep(queue: Pick<Queue, 'upsertJobScheduler'> = defineQueue(INBOUND_WEBHOOKS_QUEUE)): Promise<void> {
  await queue.upsertJobScheduler(INBOUND_WEBHOOKS_SWEEP_JOB, { every: INBOUND_WEBHOOKS_SWEEP_EVERY_MS }, { name: INBOUND_WEBHOOKS_SWEEP_JOB, data: {} })
}

/** Registra fila e worker `inbound-webhooks`. Com `deps.processor`, usa esse (testes); sem, o do processo. */
export function registerInboundWebhooksJob(registry: WorkerRegistry, deps?: { processor: Pick<InboundWebhookProcessor, 'process' | 'sweepPending'> }): WorkerRegistry {
  registry.queue(INBOUND_WEBHOOKS_QUEUE)
  registry.worker(INBOUND_WEBHOOKS_QUEUE, createInboundWebhookProcessor({ processor: () => deps?.processor ?? inboundWebhookProcessor() }))
  return registry
}

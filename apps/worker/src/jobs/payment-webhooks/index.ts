// Job `payment-webhooks` (T111): aplica um evento de pagamento (já autenticado pela API) na cobrança e retoma o run
// do bloco Pagamento quando aprovado dentro do `listener_ttl`. Run em execução no momento → o job falha e o BullMQ
// tenta de novo; webhook repetido ou fora do TTL só atualiza `payment_charges`.
import { PAYMENT_WEBHOOKS_QUEUE, PaymentWebhookService, type FlowControl, type PaymentWebhookJobData, type PaymentWebhookOutcome, type PaymentWebhookServiceOptions } from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { PAYMENT_WEBHOOKS_QUEUE } from '@crm/core'
export const PAYMENT_WEBHOOKS_QUEUE_OPTS = { defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 5_000 } } } as const

type PaymentWebhooksDeps = Partial<Omit<PaymentWebhookServiceOptions, 'db' | 'control'>> & { db?: Database; control?: Pick<FlowControl, 'resolvePayment' | 'interruptForPayment'> }
let configured: PaymentWebhooksDeps = {}
let processService: PaymentWebhookService | undefined

/** Dependências do processo: `db` e o `FlowControl` do worker (o mesmo do flow-step/flow-timer). */
export function configurePaymentWebhooks(deps: PaymentWebhooksDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

/** Serviço do processo; `undefined` enquanto `configurePaymentWebhooks({ db, control })` não foi chamado. */
export function paymentWebhookService(): PaymentWebhookService | undefined {
  if (processService) return processService
  const { db, ...rest } = configured
  if (!db || !rest.control) return undefined
  processService = new PaymentWebhookService({ ...rest, db })
  return processService
}

export function createPaymentWebhookProcessor(deps: { service: () => Pick<PaymentWebhookService, 'process'> | undefined }): Processor<PaymentWebhookJobData, PaymentWebhookOutcome> {
  return async (job: Pick<Job<PaymentWebhookJobData>, 'data'>) => {
    const service = deps.service()
    if (!service) throw new Error('payment-webhooks: dependências não configuradas (configurePaymentWebhooks({ db, control }))')
    return service.process(job.data)
  }
}

/** Registra fila e worker `payment-webhooks`. Com `deps.service`, usa esse (testes); sem, o do processo. */
export function registerPaymentWebhooksJob(registry: WorkerRegistry, deps?: { service: Pick<PaymentWebhookService, 'process'> }): WorkerRegistry {
  registry.queue(PAYMENT_WEBHOOKS_QUEUE, PAYMENT_WEBHOOKS_QUEUE_OPTS)
  registry.worker<PaymentWebhookJobData, PaymentWebhookOutcome>(PAYMENT_WEBHOOKS_QUEUE, createPaymentWebhookProcessor({ service: () => deps?.service ?? paymentWebhookService() }))
  return registry
}

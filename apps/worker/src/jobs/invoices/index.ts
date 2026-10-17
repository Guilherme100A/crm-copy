// Job `invoices` (T112): envia a venda aprovada ao emissor de NF (Notasy) e grava o status em `sale_invoices`
// (`sale.updated` a cada transição). Falha do emissor: o job lança `InvoiceRetryError` e o BullMQ repete com backoff
// (no máximo 3 chamadas ao emissor; a 3ª falha conclui o job com status `failed`). Venda ainda não visível (job antes do
// commit do passo do fluxo, T126): repete em poucos segundos sem gastar tentativa do emissor.
import {
  defineQueue,
  INVOICES_JOB_OPTIONS,
  INVOICES_QUEUE,
  InvoiceEmissionService,
  InvoiceIntegrationsService,
  isInvoiceRetryError,
  isSaleNotVisibleError,
  type InvoiceEnqueue,
  type InvoiceIntegrationsServiceOptions,
  type InvoiceJobData,
  type InvoiceProcessOutcome,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { INVOICES_BACKOFF, INVOICES_QUEUE } from '@crm/core'

/** Falha do emissor: 10 s, 20 s (entre a 1ª, a 2ª e a 3ª chamada). */
export const INVOICES_RETRY_BASE_MS = 10_000
/** Venda ainda não visível: 2 s, 4 s, 8 s… */
export const INVOICES_NOT_VISIBLE_BASE_MS = 2_000
/** Tentativas e backoff: `INVOICES_JOB_OPTIONS` do core (as mesmas na fila da API). */
export const INVOICES_QUEUE_OPTS = { defaultJobOptions: INVOICES_JOB_OPTIONS } as const

type InvoicesDeps = Partial<Omit<InvoiceIntegrationsServiceOptions, 'db'>> & {
  db?: Database
  /** `sale.updated` (realtime do processo). */
  publisher?: ConstructorParameters<typeof InvoiceEmissionService>[0]['publisher']
  logger?: ConstructorParameters<typeof InvoiceEmissionService>[0]['logger']
  /** Base do backoff entre chamadas ao emissor (default `INVOICES_RETRY_BASE_MS`; testes usam poucos ms). */
  retryBaseMs?: number
  /** Base do backoff de "venda ainda não visível" (default `INVOICES_NOT_VISIBLE_BASE_MS`). */
  notVisibleBaseMs?: number
}

let configured: InvoicesDeps = {}
let processService: InvoiceEmissionService | undefined

/** Dependências do processo: `db` (obrigatório), cifrador/env do emissor, publisher e logger. */
export function configureInvoices(deps: InvoicesDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

function buildService(deps: InvoicesDeps): InvoiceEmissionService | undefined {
  const { db, publisher, logger, retryBaseMs: _r, notVisibleBaseMs: _n, ...integrationOpts } = deps
  if (!db) return undefined
  return new InvoiceEmissionService({
    db,
    integrations: new InvoiceIntegrationsService({ ...integrationOpts, db }),
    ...(publisher ? { publisher } : {}),
    ...(logger ? { logger } : {}),
  })
}

/** Serviço do processo; `undefined` enquanto `configureInvoices({ db })` não foi chamado. */
export function invoiceEmissionService(): InvoiceEmissionService | undefined {
  return (processService ??= buildService(configured))
}

/** Atraso até a próxima tentativa (`attemptsMade` = tentativas do BullMQ já feitas, ≥ 1). */
export function invoicesBackoff(
  attemptsMade: number,
  err?: Error,
  bases: { retryBaseMs?: number; notVisibleBaseMs?: number } = {},
): number {
  if (isSaleNotVisibleError(err))
    return Math.round(
      2 ** Math.min(Math.max(1, attemptsMade) - 1, 6) * (bases.notVisibleBaseMs ?? INVOICES_NOT_VISIBLE_BASE_MS),
    )
  const issuerAttempts = isInvoiceRetryError(err) ? err.attempts : Math.max(1, attemptsMade)
  return Math.round(2 ** (Math.max(1, issuerAttempts) - 1) * (bases.retryBaseMs ?? INVOICES_RETRY_BASE_MS))
}

export function createInvoicesProcessor(deps: {
  service: () => Pick<InvoiceEmissionService, 'process'> | undefined
}): Processor<InvoiceJobData, InvoiceProcessOutcome> {
  return async (job: Pick<Job<InvoiceJobData>, 'data'>) => {
    const service = deps.service()
    if (!service) throw new Error('invoices: dependências não configuradas (configureInvoices({ db }))')
    return service.process(job.data)
  }
}

/** `enqueue` do `invoiceSalePublisher` e da reemissão, a partir da fila `invoices` (prefixo `CRM_QUEUE_PREFIX`). */
export function invoicesEnqueuer(
  queue = defineQueue<InvoiceJobData>(INVOICES_QUEUE, INVOICES_QUEUE_OPTS),
): InvoiceEnqueue {
  return async (data, opts) => {
    await queue.add(INVOICES_QUEUE, data, { jobId: opts.jobId })
  }
}

/** Registra fila e worker `invoices`. Com `deps`, usa essas (testes); sem, as do processo. */
export function registerInvoicesJob(
  registry: WorkerRegistry,
  deps?: InvoicesDeps & { service?: Pick<InvoiceEmissionService, 'process'> },
): WorkerRegistry {
  let own: InvoiceEmissionService | undefined
  const service = () => (deps ? (deps.service ?? (own ??= buildService(deps))) : invoiceEmissionService())
  const bases = () => deps ?? configured
  registry.queue(INVOICES_QUEUE, INVOICES_QUEUE_OPTS)
  registry.worker<InvoiceJobData, InvoiceProcessOutcome>(INVOICES_QUEUE, createInvoicesProcessor({ service }), {
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
        invoicesBackoff(attemptsMade, err, bases()),
    },
  })
  return registry
}

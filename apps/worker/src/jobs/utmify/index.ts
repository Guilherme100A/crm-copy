// Job `utmify` (T113): envia a venda (aprovada ou reembolsada) à UTMify com a atribuição do contato e grava o estado em
// `sale_utmify_events` (`sale.updated` a cada transição). Falha da UTMify: o job lança `UtmifyRetryError` e o BullMQ
// repete com backoff (no máximo 3 chamadas; a 3ª falha conclui o job com status `failed`). Venda ainda não visível (job
// antes do commit do passo do fluxo, T126): repete em poucos segundos sem gastar chamada à UTMify.
import {
  defineQueue,
  isSaleNotVisibleError,
  isUtmifyRetryError,
  UTMIFY_JOB_OPTIONS,
  UTMIFY_QUEUE,
  UtmifyIntegrationsService,
  UtmifySendService,
  type UtmifyEnqueue,
  type UtmifyIntegrationsServiceOptions,
  type UtmifyJobData,
  type UtmifyProcessOutcome,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { UTMIFY_BACKOFF, UTMIFY_QUEUE } from '@crm/core'

/** Falha da UTMify: 10 s, 20 s (entre a 1ª, a 2ª e a 3ª chamada). */
export const UTMIFY_RETRY_BASE_MS = 10_000
/** Venda ainda não visível: 2 s, 4 s, 8 s… */
export const UTMIFY_NOT_VISIBLE_BASE_MS = 2_000
/** Tentativas e backoff: `UTMIFY_JOB_OPTIONS` do core (as mesmas na fila da API). */
export const UTMIFY_QUEUE_OPTS = { defaultJobOptions: UTMIFY_JOB_OPTIONS } as const

type UtmifyDeps = Partial<Omit<UtmifyIntegrationsServiceOptions, 'db'>> & {
  db?: Database
  /** `sale.updated` (realtime do processo). */
  publisher?: ConstructorParameters<typeof UtmifySendService>[0]['publisher']
  logger?: ConstructorParameters<typeof UtmifySendService>[0]['logger']
  /** Base do backoff entre chamadas à UTMify (default `UTMIFY_RETRY_BASE_MS`; testes usam poucos ms). */
  retryBaseMs?: number
  /** Base do backoff de "venda ainda não visível" (default `UTMIFY_NOT_VISIBLE_BASE_MS`). */
  notVisibleBaseMs?: number
}

let configured: UtmifyDeps = {}
let processService: UtmifySendService | undefined

/** Dependências do processo: `db` (obrigatório), cifrador/env da UTMify, publisher e logger. */
export function configureUtmify(deps: UtmifyDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

function buildService(deps: UtmifyDeps): UtmifySendService | undefined {
  const { db, publisher, logger, retryBaseMs: _r, notVisibleBaseMs: _n, ...integrationOpts } = deps
  if (!db) return undefined
  return new UtmifySendService({
    db,
    integrations: new UtmifyIntegrationsService({ ...integrationOpts, db }),
    ...(publisher ? { publisher } : {}),
    ...(logger ? { logger } : {}),
  })
}

/** Serviço do processo; `undefined` enquanto `configureUtmify({ db })` não foi chamado. */
export function utmifySendService(): UtmifySendService | undefined {
  return (processService ??= buildService(configured))
}

/** Atraso até a próxima tentativa (`attemptsMade` = tentativas do BullMQ já feitas, ≥ 1). */
export function utmifyBackoff(
  attemptsMade: number,
  err?: Error,
  bases: { retryBaseMs?: number; notVisibleBaseMs?: number } = {},
): number {
  if (isSaleNotVisibleError(err))
    return Math.round(
      2 ** Math.min(Math.max(1, attemptsMade) - 1, 6) * (bases.notVisibleBaseMs ?? UTMIFY_NOT_VISIBLE_BASE_MS),
    )
  const calls = isUtmifyRetryError(err) ? err.attempts : Math.max(1, attemptsMade)
  return Math.round(2 ** (Math.max(1, calls) - 1) * (bases.retryBaseMs ?? UTMIFY_RETRY_BASE_MS))
}

export function createUtmifyProcessor(deps: {
  service: () => Pick<UtmifySendService, 'process'> | undefined
}): Processor<UtmifyJobData, UtmifyProcessOutcome> {
  return async (job: Pick<Job<UtmifyJobData>, 'data'>) => {
    const service = deps.service()
    if (!service) throw new Error('utmify: dependências não configuradas (configureUtmify({ db }))')
    return service.process(job.data)
  }
}

/** `enqueue` do `utmifySalePublisher`, a partir da fila `utmify` (prefixo `CRM_QUEUE_PREFIX`). */
export function utmifyEnqueuer(queue = defineQueue<UtmifyJobData>(UTMIFY_QUEUE, UTMIFY_QUEUE_OPTS)): UtmifyEnqueue {
  return async (data, opts) => {
    await queue.add(UTMIFY_QUEUE, data, { jobId: opts.jobId })
  }
}

/** Registra fila e worker `utmify`. Com `deps`, usa essas (testes); sem, as do processo. */
export function registerUtmifyJob(
  registry: WorkerRegistry,
  deps?: UtmifyDeps & { service?: Pick<UtmifySendService, 'process'> },
): WorkerRegistry {
  let own: UtmifySendService | undefined
  const service = () => (deps ? (deps.service ?? (own ??= buildService(deps))) : utmifySendService())
  const bases = () => deps ?? configured
  registry.queue(UTMIFY_QUEUE, UTMIFY_QUEUE_OPTS)
  registry.worker<UtmifyJobData, UtmifyProcessOutcome>(UTMIFY_QUEUE, createUtmifyProcessor({ service }), {
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => utmifyBackoff(attemptsMade, err, bases()),
    },
  })
  return registry
}

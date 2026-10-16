// Filas e workers BullMQ do CRM (SPEC 3.9): prefixo `CRM_QUEUE_PREFIX` (padrão `crm`; T121: testes usam um único por execução), nomes com `-` (BullMQ proíbe `:`), retenção sempre
// configurada e backoff exponencial. Retry do BullMQ é a única política de retry.
import { bullConnection, CRM_QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, type BullConnectionOptions } from '@crm/node-kit'
import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq'

export const DEFAULT_JOB_ATTEMPTS = 3
export const DEFAULT_BACKOFF_DELAY_MS = 1000

/** Opções de job aplicadas a toda fila do CRM (sobrescrevíveis por fila e por job). */
export const CRM_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: DEFAULT_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_DELAY_MS },
  removeOnComplete: { ...DEFAULT_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...DEFAULT_JOB_OPTIONS.removeOnFail },
}

/**
 * Prefixo padrão das filas e workers do CRM, lido NO MOMENTO da criação: `CRM_QUEUE_PREFIX` do ambiente ou `crm`.
 * Os testes definem um prefixo único por execução (vitest `test.env`), para workers de outro worktree no mesmo Redis
 * não consumirem estes jobs (T121). Produção não define a variável: continua `crm`.
 */
export function crmQueuePrefix(env: Record<string, string | undefined> = process.env): string {
  return env.CRM_QUEUE_PREFIX?.trim() || CRM_QUEUE_PREFIX
}

const QUEUE_NAME = /^[a-z0-9][a-z0-9-]*$/

export class InvalidQueueNameError extends Error {
  constructor(readonly queueName: string) {
    super(`nome de fila inválido: "${queueName}" (use minúsculas, dígitos e "-"; BullMQ proíbe ":")`)
    this.name = 'InvalidQueueNameError'
  }
}

export function assertQueueName(name: string): string {
  if (!QUEUE_NAME.test(name)) throw new InvalidQueueNameError(name)
  return name
}

export type QueueConnection = BullConnectionOptions | ConnectionOptions

/** Copia as opções: a interface do ioredis não tem assinatura de índice e não casa com o tipo do BullMQ. */
function toConnection(connection: QueueConnection | undefined): ConnectionOptions {
  return { ...(connection ?? bullConnection()) } as ConnectionOptions
}

export interface DefineQueueOptions {
  /** Opções do ioredis (ex.: `bullConnection({ url })`). Default: `bullConnection()` (`REDIS_URL`). */
  connection?: QueueConnection
  /** Default `crmQueuePrefix()` (`CRM_QUEUE_PREFIX` ou `crm`). */
  prefix?: string
  defaultJobOptions?: JobsOptions
}

export function defineQueue<Data = unknown, Result = unknown>(name: string, opts: DefineQueueOptions = {}) {
  return new Queue<Data, Result>(assertQueueName(name), {
    connection: toConnection(opts.connection),
    prefix: opts.prefix ?? crmQueuePrefix(),
    defaultJobOptions: { ...CRM_DEFAULT_JOB_OPTIONS, ...opts.defaultJobOptions },
  })
}

export type DefineWorkerOptions = Partial<Omit<WorkerOptions, 'connection' | 'prefix'>> & {
  connection?: QueueConnection
  prefix?: string
}

/** Worker com os defaults do CRM. Sem listener de `error` o BullMQ trata como não tratado: um é sempre registrado. */
export function defineWorker<Data = unknown, Result = unknown>(
  name: string,
  processor: Processor<Data, Result>,
  opts: DefineWorkerOptions = {},
): Worker<Data, Result> {
  const { connection, prefix, ...rest } = opts
  const worker = new Worker<Data, Result>(assertQueueName(name), processor, {
    removeOnComplete: { ...DEFAULT_JOB_OPTIONS.removeOnComplete },
    removeOnFail: { ...DEFAULT_JOB_OPTIONS.removeOnFail },
    ...rest,
    connection: toConnection(connection),
    prefix: prefix ?? crmQueuePrefix(),
  })
  worker.on('error', () => undefined)
  return worker
}

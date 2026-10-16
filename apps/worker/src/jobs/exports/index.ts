// Jobs `exports`/`imports { jobId }` (T27): o estado mora em `crm.background_jobs`; o processor só chama o runner
// do core. Sem retry (attempts 1): a falha já fica registrada no job, e um export refeito do zero é outro job.
import {
  EXPORTS_QUEUE,
  FsExportFileStore,
  IMPORTS_QUEUE,
  RealtimePublisher,
  runExportJob,
  runImportJob,
  type BackgroundJobData,
  type JobDto,
  type RunJobDeps,
} from '@crm/core'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { EXPORTS_QUEUE, IMPORTS_QUEUE } from '@crm/core'

/** Opções das filas: uma tentativa só (o job falho fica `failed` com a mensagem). */
export const BACKGROUND_JOB_QUEUE_OPTS = { defaultJobOptions: { attempts: 1 } } as const

type Run = (deps: RunJobDeps, jobId: string) => Promise<JobDto | null>

function processorOf(name: string, run: Run, deps: () => RunJobDeps | undefined): Processor<BackgroundJobData, JobDto | null> {
  return async (job: Pick<Job<BackgroundJobData>, 'data'>) => {
    const jobId = job.data?.jobId
    if (typeof jobId !== 'string' || !jobId) throw new Error(`${name}: jobId inválido`)
    const d = deps()
    if (!d) throw new Error(`${name}: dependências não configuradas (configureExports({ db, ... }))`)
    return run(d, jobId)
  }
}

export function createExportsProcessor(deps: RunJobDeps): Processor<BackgroundJobData, JobDto | null> {
  return processorOf(EXPORTS_QUEUE, runExportJob, () => deps)
}

export function createImportsProcessor(deps: RunJobDeps): Processor<BackgroundJobData, JobDto | null> {
  return processorOf(IMPORTS_QUEUE, runImportJob, () => deps)
}

let configured: (Partial<RunJobDeps> & { redis?: ConstructorParameters<typeof RealtimePublisher>[0]['redis'] }) | undefined
let resolved: RunJobDeps | undefined

/** Dependências do processo: `db` obrigatório; `files` padrão `FsExportFileStore` (STORAGE_DIR/exports); `publisher` ou `redis`. */
export function configureExports(deps: Partial<RunJobDeps> & { redis?: ConstructorParameters<typeof RealtimePublisher>[0]['redis'] }): void {
  configured = { ...configured, ...deps }
  resolved = undefined
}

function processDeps(): RunJobDeps | undefined {
  if (resolved) return resolved
  if (!configured?.db) return undefined
  const { redis, ...rest } = configured
  resolved = {
    ...rest,
    db: configured.db,
    files: configured.files ?? new FsExportFileStore(),
    ...(rest.publisher ? {} : redis ? { publisher: new RealtimePublisher({ redis }) } : {}),
  }
  return resolved
}

/** Registra filas e workers `exports` e `imports`. Com `deps`, usa essas dependências (testes); sem, as do processo. */
export function registerExportsJob(registry: WorkerRegistry, deps?: RunJobDeps): WorkerRegistry {
  const get = () => deps ?? processDeps()
  registry.queue(EXPORTS_QUEUE, BACKGROUND_JOB_QUEUE_OPTS)
  registry.queue(IMPORTS_QUEUE, BACKGROUND_JOB_QUEUE_OPTS)
  registry.worker<BackgroundJobData, JobDto | null>(EXPORTS_QUEUE, processorOf(EXPORTS_QUEUE, runExportJob, get))
  registry.worker<BackgroundJobData, JobDto | null>(IMPORTS_QUEUE, processorOf(IMPORTS_QUEUE, runImportJob, get))
  return registry
}

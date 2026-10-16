// Fila `mass-dispatch` (T74): jobs `prepare` (enfileirado pela criação da T60) e `tick` (um por alvo, delayed). Todo
// job leva `dispatchId` em data: o cancelamento da T60 remove os pendentes por ele. Sem retry: o tick se reagenda.
import {
  FLOW_TIMER_QUEUE,
  FlowControl,
  MASS_DISPATCH_QUEUE,
  RealtimePublisher,
  bullTimerScheduler,
  defineQueue,
  flowEngineStarter,
  prepareMassDispatch,
  runMassDispatchTick,
  type FlowStepJobData,
  type FlowTimerJobData,
  type MassDispatchJobData,
  type MassDispatchRunnerDeps,
  type PrepareResult,
  type TickJob,
  type TickResult,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { WaGateway } from '@crm/wa-port'
import type { Job, Processor, Queue } from 'bullmq'
import type { WorkerRegistry } from '../../registry'
import { FLOW_STEP_QUEUE, flowStepEnqueuer } from '../flow-step'

export { MASS_DISPATCH_QUEUE } from '@crm/core'

/** `jobId` do tick (sem `:`): alvo + instante previsto, para não colidir com o tick em execução. */
export const massDispatchTickJobId = (job: TickJob, at: number) => `tick-${job.dispatchId}-${job.targetId}-${at}`

/** Agendamento BullMQ do próximo tick. */
export function bullTickScheduler(queue: () => Pick<Queue<MassDispatchJobData>, 'add'>): MassDispatchRunnerDeps['schedule'] {
  return async (job, delayMs) => {
    const at = Date.now() + delayMs
    await queue().add('tick', { ...job }, { jobId: massDispatchTickJobId(job, at), delay: delayMs, attempts: 1 })
  }
}

export type MassDispatchJobResult = PrepareResult | TickResult | null

export function createMassDispatchProcessor(deps: MassDispatchRunnerDeps | (() => MassDispatchRunnerDeps | undefined)): Processor<MassDispatchJobData, MassDispatchJobResult> {
  return async (job: Pick<Job<MassDispatchJobData>, 'data'>) => {
    const d = typeof deps === 'function' ? deps() : deps
    if (!d) throw new Error('mass-dispatch: dependências não configuradas (configureMassDispatch({ db, wa }))')
    const { kind, dispatchId, targetId } = job.data ?? ({} as MassDispatchJobData)
    if (typeof dispatchId !== 'string' || !dispatchId) throw new Error('mass-dispatch: dispatchId inválido')
    if (kind === 'prepare') return prepareMassDispatch(d, dispatchId)
    if (kind === 'tick' && typeof targetId === 'string') return runMassDispatchTick(d, { dispatchId, targetId })
    throw new Error(`mass-dispatch: job desconhecido ${String(kind)}`)
  }
}

interface ProcessConfig {
  db: Database
  wa: WaGateway
  redis?: ConstructorParameters<typeof RealtimePublisher>[0]['redis']
  overrides?: Partial<MassDispatchRunnerDeps>
}

let configured: ProcessConfig | undefined
let resolved: MassDispatchRunnerDeps | undefined

/**
 * Dependências do processo: banco, gateway (RPC do wa-worker) e Redis do realtime. O controle de runs e os timers
 * dos fluxos usam as filas `flow-step`/`flow-timer`, como o motor do processo.
 */
export function configureMassDispatch(config: ProcessConfig): void {
  configured = config
  resolved = undefined
}

function processDeps(): MassDispatchRunnerDeps | undefined {
  if (resolved) return resolved
  if (!configured) return undefined
  const { db, wa, redis, overrides } = configured
  let queue: Queue<MassDispatchJobData> | undefined
  const control = new FlowControl({
    db,
    timers: bullTimerScheduler(defineQueue<FlowTimerJobData>(FLOW_TIMER_QUEUE)),
    enqueueStep: flowStepEnqueuer(defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE)),
  })
  resolved = {
    db,
    wa,
    control,
    starter: flowEngineStarter({ db, wa, control, engine: { hooks: control.engineHooks() } }),
    schedule: bullTickScheduler(() => (queue ??= defineQueue<MassDispatchJobData>(MASS_DISPATCH_QUEUE))),
    ...(redis ? { publisher: new RealtimePublisher({ redis }) as unknown as MassDispatchRunnerDeps['publisher'] } : {}),
    ...overrides,
  }
  return resolved
}

/** Registra fila e worker `mass-dispatch`. Com `deps`, usa essas dependências (testes); sem, as do processo. */
export function registerMassDispatchJob(registry: WorkerRegistry, deps?: MassDispatchRunnerDeps): WorkerRegistry {
  registry.queue(MASS_DISPATCH_QUEUE, { defaultJobOptions: { attempts: 1 } })
  registry.worker<MassDispatchJobData, MassDispatchJobResult>(MASS_DISPATCH_QUEUE, createMassDispatchProcessor(() => deps ?? processDeps()))
  return registry
}

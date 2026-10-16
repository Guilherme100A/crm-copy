// Fila `schedules` (T64): um job delayed por ocorrência (`schedule-<id>-<runAt ms>`) executa o agendamento no horário
// (mensagem pelo ChatSendService; fluxo pelo motor) e, na recorrência, enfileira a próxima ocorrência. Sem retry:
// a Idempotency-Key por ocorrência evita reenvio e a falha fica registrada no agendamento.
import {
  FLOW_TIMER_QUEUE,
  FlowControl,
  FlowEngine,
  SCHEDULES_QUEUE,
  bullTimerScheduler,
  defineQueue,
  runSchedule,
  scheduleJobId,
  type ChatSendService,
  type FlowStepJobData,
  type FlowTimerJobData,
  type ScheduleJobData,
  type ScheduleRunResult,
  type ScheduleRunnerDeps,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { WaGateway } from '@crm/wa-port'
import type { Job, Processor, Queue } from 'bullmq'
import type { WorkerRegistry } from '../../registry'
import { FLOW_STEP_QUEUE, flowStepEnqueuer } from '../flow-step'

export { SCHEDULES_QUEUE } from '@crm/core'

/** Prefixo das filas do CRM (T121: `CRM_QUEUE_PREFIX`; ausente = o padrão `crm`). */
export const queuePrefix = (env: Record<string, string | undefined> = process.env) => env.CRM_QUEUE_PREFIX?.trim() || undefined

/** Enfileira a ocorrência como job delayed com `jobId` determinístico. */
export function bullScheduleEnqueuer(queue: () => Pick<Queue<ScheduleJobData>, 'add'>): ScheduleRunnerDeps['enqueue'] {
  return async (job, delayMs) => {
    await queue().add('run', { ...job }, { jobId: scheduleJobId(job), delay: Math.max(0, delayMs), attempts: 1 })
  }
}

export function createSchedulesProcessor(deps: ScheduleRunnerDeps | (() => ScheduleRunnerDeps | undefined)): Processor<ScheduleJobData, ScheduleRunResult> {
  return async (job: Pick<Job<ScheduleJobData>, 'data'>) => {
    const d = typeof deps === 'function' ? deps() : deps
    if (!d) throw new Error('schedules: dependências não configuradas (configureSchedules({ db, chatSend, waGateway }))')
    const { scheduleId, runAt } = job.data ?? ({} as ScheduleJobData)
    if (typeof scheduleId !== 'string' || !scheduleId || typeof runAt !== 'string' || Number.isNaN(Date.parse(runAt))) throw new Error('schedules: job inválido')
    return runSchedule(d, { scheduleId, runAt })
  }
}

interface ProcessConfig {
  db: Database
  chatSend: Pick<ChatSendService, 'send'>
  waGateway: WaGateway
  overrides?: Partial<ScheduleRunnerDeps>
}

let configured: ProcessConfig | undefined
let resolved: ScheduleRunnerDeps | undefined

/** Dependências do processo (boot de produção): envio do chat e motor de fluxos com as filas do processo. */
export function configureSchedules(config: ProcessConfig): void {
  configured = config
  resolved = undefined
}

function processDeps(): ScheduleRunnerDeps | undefined {
  if (resolved) return resolved
  if (!configured) return undefined
  const { db, chatSend, waGateway, overrides } = configured
  const prefix = queuePrefix()
  const opts = prefix ? { prefix } : {}
  const enqueueStep = flowStepEnqueuer(defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE, opts))
  const control = new FlowControl({ db, timers: bullTimerScheduler(defineQueue<FlowTimerJobData>(FLOW_TIMER_QUEUE, opts)), enqueueStep })
  const engine = new FlowEngine({ db, wa: waGateway, enqueue: enqueueStep, hooks: control.engineHooks() })
  let queue: Queue<ScheduleJobData> | undefined
  resolved = {
    db,
    send: chatSend,
    flows: engine,
    enqueue: bullScheduleEnqueuer(() => (queue ??= defineQueue<ScheduleJobData>(SCHEDULES_QUEUE, opts))),
    ...overrides,
  }
  return resolved
}

/** Registra fila e worker `schedules`. Com `deps`, usa essas dependências (testes); sem, as do processo. */
export function registerSchedulesJob(registry: WorkerRegistry, deps?: ScheduleRunnerDeps): WorkerRegistry {
  registry.queue(SCHEDULES_QUEUE, { defaultJobOptions: { attempts: 1 } })
  registry.worker<ScheduleJobData, ScheduleRunResult>(SCHEDULES_QUEUE, createSchedulesProcessor(() => deps ?? processDeps()))
  return registry
}

// Job `flow-timer { runId, seq, gen }` (T30): prazo de uma espera de fluxo venceu → `FlowControl.fireTimer`.
// Job delayed com `jobId` determinístico (`timer-<runId>-seq-<n>[-g<gen>]`, sem `:` que o BullMQ recusa).
// O registro também liga o agendamento ao motor (hooks do `flow-step`) e as respostas do `crm.inbound`.
import {
  FLOW_TIMER_QUEUE,
  FlowControl,
  bullTimerScheduler,
  defineQueue,
  type AdvanceResult,
  type FlowControlOptions,
  type FlowStepJobData,
  type FlowTimerJobData,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import { onCrmInbound } from '../../consumers/chats'
import type { WorkerRegistry } from '../../registry'
import { FLOW_STEP_QUEUE, configureFlowStep, flowStepEnqueuer } from '../flow-step'

export { FLOW_TIMER_QUEUE, bullTimerScheduler, flowTimerJobId } from '@crm/core'

export function createFlowTimerProcessor(deps: { control: FlowControl }): Processor<FlowTimerJobData, AdvanceResult> {
  return async (job: Pick<Job<FlowTimerJobData>, 'data'>) => {
    const { runId, seq, gen } = job.data ?? ({} as FlowTimerJobData)
    if (typeof runId !== 'string' || !Number.isInteger(seq)) throw new Error('flow-timer: runId/seq inválidos')
    return deps.control.fireTimer({ runId, seq, gen: gen ?? 0 })
  }
}

let configured: Partial<FlowControlOptions> = {}
let processControl: FlowControl | undefined

/** Dependências do controle do processo. O boot deve passar ao menos `db` (sem `db`, o `crm.inbound` é ignorado). */
export function configureFlowTimer(deps: Partial<FlowControlOptions> & { db?: Database }): void {
  configured = { ...configured, ...deps }
  processControl = undefined
}

function controlFrom(deps: Partial<FlowControlOptions>): FlowControl {
  if (!deps.db) throw new Error('flow-timer: banco não configurado (configureFlowTimer({ db }))')
  return new FlowControl({
    ...deps,
    db: deps.db,
    timers: deps.timers ?? bullTimerScheduler(defineQueue<FlowTimerJobData>(FLOW_TIMER_QUEUE)),
    enqueueStep: deps.enqueueStep ?? flowStepEnqueuer(defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE)),
  })
}

/**
 * Registra fila e worker `flow-timer`, os hooks de agendamento no motor do `flow-step` e as respostas vindas do
 * `crm.inbound`. Com `deps.control`, usa esse controle (testes); sem, o do processo (`configureFlowTimer`).
 */
export function registerFlowTimerJob(registry: WorkerRegistry, deps?: { control: FlowControl }): WorkerRegistry {
  const control = () => deps?.control ?? (processControl ??= controlFrom(configured))
  registry.queue(FLOW_TIMER_QUEUE)
  registry.worker<FlowTimerJobData, AdvanceResult>(FLOW_TIMER_QUEUE, (job) => createFlowTimerProcessor({ control: control() })(job))
  // O motor do processo agenda o timer quando um nó devolve `wait` (hook resolvido no primeiro uso).
  configureFlowStep({ hooks: { afterNode: (info) => control().engineHooks().afterNode!(info) } })
  onCrmInbound(async (e) => {
    if (!deps?.control && !configured.db) return
    await control().resolveReplyForContact({ companyId: e.company_id }, e.contact_id, { text: e.text, message_id: e.message_id, type: e.type })
  })
  return registry
}

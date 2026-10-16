// Job `flow-step { runId, expectedSeq }` (T25): um passo do motor de fluxos. Idempotente: o FlowEngine trava o run e
// só executa se o `seq` ainda é o esperado; entrega duplicada (ou atrasada) termina sem efeito.
// As dependências podem vir na chamada (testes) ou ser configuradas por quem tem o gateway (`configureFlowStep`).
import { FlowEngine, defineQueue, type FlowEngineOptions, type FlowStepJobData, type StepResult } from '@crm/core'
import { createDb } from '@crm/db'
import type { Job, Processor, Queue } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export const FLOW_STEP_QUEUE = 'flow-step'

/** `jobId` determinístico (BullMQ recusa `:` em ids customizados): reenfileirar o mesmo passo não duplica. */
export function flowStepJobId(data: FlowStepJobData): string {
  return `run-${data.runId}-seq-${data.expectedSeq}`
}

/** `enqueue` do FlowEngine a partir de uma fila BullMQ. */
export function flowStepEnqueuer(queue: Pick<Queue<FlowStepJobData>, 'add'>): (data: FlowStepJobData) => Promise<void> {
  return async (data) => {
    await queue.add(FLOW_STEP_QUEUE, data, { jobId: flowStepJobId(data) })
  }
}

export function createFlowStepProcessor(deps: { engine: FlowEngine }): Processor<FlowStepJobData, StepResult> {
  return async (job: Pick<Job<FlowStepJobData>, 'data'>) => {
    const { runId, expectedSeq } = job.data ?? ({} as FlowStepJobData)
    if (typeof runId !== 'string' || !Number.isInteger(expectedSeq)) throw new Error('flow-step: runId/expectedSeq inválidos')
    return deps.engine.step(runId, expectedSeq)
  }
}

let configured: Partial<FlowEngineOptions> = {}
let processEngine: FlowEngine | undefined

/** Completa/troca as dependências do motor do processo (gateway WhatsApp, LLM, logger, db). */
export function configureFlowStep(deps: Partial<FlowEngineOptions>): void {
  configured = { ...configured, ...deps }
  processEngine = undefined
}

function engineFrom(deps: Partial<FlowEngineOptions>): FlowEngine {
  if (!deps.wa) throw new Error('flow-step: WaGateway não configurado (configureFlowStep({ wa }))')
  return new FlowEngine({
    ...deps,
    wa: deps.wa,
    db: deps.db ?? createDb(),
    enqueue: deps.enqueue ?? flowStepEnqueuer(defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE)),
  })
}

/**
 * Registra a fila e o worker `flow-step`. Com `deps.engine`, usa esse motor (testes, E2E); sem, usa o do processo,
 * criado no primeiro job com o que `configureFlowStep` definiu.
 */
export function registerFlowStepJob(registry: WorkerRegistry, deps?: { engine: FlowEngine }): WorkerRegistry {
  const engine = () => deps?.engine ?? (processEngine ??= engineFrom(configured))
  registry.queue(FLOW_STEP_QUEUE)
  registry.worker<FlowStepJobData, StepResult>(FLOW_STEP_QUEUE, (job) => createFlowStepProcessor({ engine: engine() })(job))
  return registry
}

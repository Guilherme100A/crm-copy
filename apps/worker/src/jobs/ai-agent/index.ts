// Job `ai-agent { companyId, chatId, gen }` (T68): o buffer do chat venceu → turno do agente.
// Job delayed com jobId por chat e geração (`turn-<chatId>-g<n>`); o runtime descarta gerações superadas.
import { AI_AGENT_QUEUE, AiAgentRuntime, bullTurnScheduler, defineQueue, type AiAgentRuntimeOptions, type AiTurnJobData, type TurnInfo } from '@crm/core'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { AI_AGENT_QUEUE } from '@crm/core'

let configured: Partial<AiAgentRuntimeOptions> | undefined
let processRuntime: AiAgentRuntime | undefined

/**
 * Dependências do runtime do processo (LLM com as chaves, gateway, STT/TTS, guard…). Sem `configureAiAgent`, o
 * `crm.inbound` é ignorado e os jobs falham com mensagem clara (o agente não responde sem LLM configurado).
 */
export function configureAiAgent(deps: Omit<AiAgentRuntimeOptions, 'scheduler'> & { scheduler?: AiAgentRuntimeOptions['scheduler'] }): void {
  configured = deps
  processRuntime = undefined
}

/** Runtime do processo, com o agendador BullMQ da fila `ai-agent`; `undefined` se não configurado. */
export function aiAgentRuntime(): AiAgentRuntime | undefined {
  if (!configured) return undefined
  return (processRuntime ??= new AiAgentRuntime({
    ...(configured as AiAgentRuntimeOptions),
    scheduler: configured.scheduler ?? bullTurnScheduler(defineQueue<AiTurnJobData>(AI_AGENT_QUEUE)),
  }))
}

export function createAiAgentProcessor(deps: { runtime: () => AiAgentRuntime | undefined }): Processor<AiTurnJobData, TurnInfo> {
  return async (job: Pick<Job<AiTurnJobData>, 'data'>) => {
    const { companyId, chatId, gen } = job.data ?? ({} as AiTurnJobData)
    if (typeof companyId !== 'string' || typeof chatId !== 'string' || !Number.isInteger(gen)) throw new Error('ai-agent: job inválido')
    const runtime = deps.runtime()
    if (!runtime) throw new Error('ai-agent: runtime não configurado (configureAiAgent)')
    return runtime.runTurn({ companyId, chatId, gen })
  }
}

/** Registra fila e worker `ai-agent`. Com `deps.runtime`, usa esse runtime (testes); sem, o do processo. */
export function registerAiAgentJob(registry: WorkerRegistry, deps?: { runtime: AiAgentRuntime }): WorkerRegistry {
  registry.queue(AI_AGENT_QUEUE)
  registry.worker<AiTurnJobData, TurnInfo>(AI_AGENT_QUEUE, createAiAgentProcessor({ runtime: () => deps?.runtime ?? aiAgentRuntime() }))
  return registry
}

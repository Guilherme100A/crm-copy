// Job `ai-agent-lab` (T79): criação assistida de agente (extract → compose → persist). Falhas de negócio viram run
// `failed` com código e NÃO relançam (attempts 1). Dependências por `configureAiAgentLab`; sem configuração, monta do
// env do processo (DATABASE_URL, REDIS_URL, chaves BYOK), para o worker funcionar mesmo sem ligação no boot.
import {
  AI_AGENT_LAB_QUEUE,
  AgentLabService,
  AiKeysService,
  createCompanyLlmProvider,
  RealtimePublisher,
  UsageGuard,
  type AgentLabJobData,
  type AgentLabServiceOptions,
  type PublicRun,
  type RunPublisher,
} from '@crm/core'
import { createDb } from '@crm/db'
import { redisConnection } from '@crm/node-kit'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { AI_AGENT_LAB_QUEUE }
export const AI_AGENT_LAB_QUEUE_OPTS = { defaultJobOptions: { attempts: 1 } } as const

type AiAgentLabDeps = Partial<AgentLabServiceOptions>
let configured: AiAgentLabDeps = {}
let processService: AgentLabService | undefined

/** Dependências do processo (db, redis, llm, guard, publisher…). */
export function configureAiAgentLab(deps: AiAgentLabDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

/** Serviço do processo: o configurado, ou montado do env na primeira chamada. */
export function aiAgentLabService(): AgentLabService {
  if (processService) return processService
  const db = configured.db ?? createDb()
  const redis = configured.redis ?? redisConnection()
  const llm = configured.llm ?? createCompanyLlmProvider({ keys: new AiKeysService({ db }) })
  processService = new AgentLabService({
    ...configured,
    db,
    redis,
    llm,
    guard: configured.guard === undefined ? new UsageGuard({ db, redis }) : configured.guard,
    publisher: configured.publisher ?? (new RealtimePublisher({ redis }) as unknown as RunPublisher),
  })
  return processService
}

export function createAiAgentLabProcessor(deps: { service: () => Pick<AgentLabService, 'processRun'> }): Processor<AgentLabJobData, PublicRun | null> {
  return async (job: Pick<Job<AgentLabJobData>, 'data'>) => deps.service().processRun(job.data.runId)
}

/** Registra fila e worker `ai-agent-lab`. Com `deps.service`, usa esse (testes); sem, o do processo. */
export function registerAiAgentLabJob(registry: WorkerRegistry, deps?: { service: Pick<AgentLabService, 'processRun'> }): WorkerRegistry {
  registry.queue(AI_AGENT_LAB_QUEUE, AI_AGENT_LAB_QUEUE_OPTS)
  registry.worker<AgentLabJobData, PublicRun | null>(AI_AGENT_LAB_QUEUE, createAiAgentLabProcessor({ service: () => deps?.service ?? aiAgentLabService() }))
  return registry
}

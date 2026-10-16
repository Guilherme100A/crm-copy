// Job `ai-knowledge` (T52): ingestão de uma fonte de conhecimento (PDF, texto, FAQ, fluxo, site SSRF-safe). Falhas de
// conteúdo viram `failed` com o código (07 §3.4) e NÃO relançam; só erro de infraestrutura (banco) faz o BullMQ
// tentar de novo. Fonte apagada antes do job → nada.
import { AiKnowledgeService, RealtimePublisher, type AiKnowledgeJobData, type AiKnowledgeServiceOptions, type KnowledgeSourceDto } from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { Redis } from 'ioredis'
import type { WorkerRegistry } from '../../registry'

export const AI_KNOWLEDGE_QUEUE = 'ai-knowledge'
export const AI_KNOWLEDGE_QUEUE_OPTS = { defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } } } as const

type AiKnowledgeDeps = Partial<Omit<AiKnowledgeServiceOptions, 'db' | 'enqueue'>> & { db?: Database; redis?: Redis }
let configured: AiKnowledgeDeps = {}
let processService: AiKnowledgeService | undefined

/** Dependências do processo (`db` obrigatório; `redis` para o realtime, ou `publisher` direto). */
export function configureAiKnowledge(deps: AiKnowledgeDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

/** Serviço do processo; `undefined` enquanto `configureAiKnowledge({ db })` não foi chamado. */
export function aiKnowledgeService(): AiKnowledgeService | undefined {
  if (processService) return processService
  const { db, redis, publisher, ...rest } = configured
  if (!db) return undefined
  processService = new AiKnowledgeService({ ...rest, db, ...(publisher ? { publisher } : redis ? { publisher: new RealtimePublisher({ redis }) } : {}) })
  return processService
}

export function createAiKnowledgeProcessor(deps: { service: () => Pick<AiKnowledgeService, 'process'> | undefined }): Processor<AiKnowledgeJobData, KnowledgeSourceDto | null> {
  return async (job: Pick<Job<AiKnowledgeJobData>, 'data'>) => {
    const service = deps.service()
    if (!service) throw new Error('ai-knowledge: dependências não configuradas (configureAiKnowledge({ db }))')
    return service.process(job.data.sourceId)
  }
}

/** Registra fila e worker `ai-knowledge`. Com `deps.service`, usa esse (testes); sem, o do processo. */
export function registerAiKnowledgeJob(registry: WorkerRegistry, deps?: { service: Pick<AiKnowledgeService, 'process'> }): WorkerRegistry {
  registry.queue(AI_KNOWLEDGE_QUEUE, AI_KNOWLEDGE_QUEUE_OPTS)
  registry.worker<AiKnowledgeJobData, KnowledgeSourceDto | null>(AI_KNOWLEDGE_QUEUE, createAiKnowledgeProcessor({ service: () => deps?.service ?? aiKnowledgeService() }))
  return registry
}

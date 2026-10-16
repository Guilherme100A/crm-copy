// Ponto de registro do worker (SPEC 2.4, compartilhado e ADITIVO): cada módulo registra aqui as suas filas,
// workers e handlers de eventos WhatsApp. O boot (`startWorker`) instancia tudo com as conexões do processo.
import type { DefineQueueOptions, DefineWorkerOptions } from '@crm/core'
import type { WaEventType } from '@crm/wa-port'
import type { Processor } from 'bullmq'
import type { EventHandler, HandlerOptions } from './consumers/framework'
import { registerChatsConsumer } from './consumers/chats'
import { registerFlowStepJob } from './jobs/flow-step'
import { registerFlowTimerJob } from './jobs/flow-timer'
import { registerAiAgentJob } from './jobs/ai-agent'
import { registerAiAgentConsumer } from './consumers/ai-agent'
import { registerExportsJob } from './jobs/exports'
import { registerFlowTriggersConsumer } from './consumers/flow-triggers'
import { registerContactsImportJob } from './jobs/contacts-import'
import { registerContactsBulkJobs } from './jobs/contacts-bulk'
import { registerMassDispatchJob } from './jobs/mass-dispatch'
import { registerSchedulesJob } from './jobs/schedules'
import { registerMetaAdsJob } from './jobs/meta-ads'

export interface QueueDefinition {
  name: string
  opts: Omit<DefineQueueOptions, 'connection'>
}

export interface WorkerDefinition {
  name: string
  processor: Processor
  opts: Omit<DefineWorkerOptions, 'connection'>
}

export interface EventHandlerDefinition {
  type: WaEventType
  handler: EventHandler
  opts: HandlerOptions
}

export interface WorkerRegistry {
  readonly queues: QueueDefinition[]
  readonly workers: WorkerDefinition[]
  readonly handlers: EventHandlerDefinition[]
  queue(name: string, opts?: Omit<DefineQueueOptions, 'connection'>): WorkerRegistry
  worker<Data = unknown, Result = unknown>(
    name: string,
    processor: Processor<Data, Result>,
    opts?: Omit<DefineWorkerOptions, 'connection'>,
  ): WorkerRegistry
  on<T extends WaEventType>(type: T, handler: EventHandler<T>, opts?: HandlerOptions): WorkerRegistry
}

export function createRegistry(): WorkerRegistry {
  const reg: WorkerRegistry = {
    queues: [],
    workers: [],
    handlers: [],
    queue(name, opts = {}) {
      if (reg.queues.some((q) => q.name === name)) throw new Error(`fila "${name}" já registrada`)
      reg.queues.push({ name, opts })
      return reg
    },
    worker(name, processor, opts = {}) {
      if (reg.workers.some((w) => w.name === name)) throw new Error(`worker "${name}" já registrado`)
      reg.workers.push({ name, processor: processor as Processor, opts })
      return reg
    },
    on(type, handler, opts = {}) {
      reg.handlers.push({ type, handler: handler as unknown as EventHandler, opts })
      return reg
    },
  }
  return reg
}

/** Registry do processo. Módulos acrescentam abaixo (uma linha por módulo), ex.: `registerChatsConsumer(registry)`. */
export const registry: WorkerRegistry = createRegistry()
registerChatsConsumer(registry)
registerFlowStepJob(registry)
registerFlowTimerJob(registry)
registerAiAgentJob(registry)
registerAiAgentConsumer()
registerExportsJob(registry)
registerFlowTriggersConsumer()
registerContactsImportJob()
registerContactsBulkJobs()
registerMassDispatchJob(registry)
registerSchedulesJob(registry)
registerMetaAdsJob(registry)

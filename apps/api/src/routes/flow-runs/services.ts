// Serviços do motor de fluxos na API (T43): FlowEngine (só cria runs; os passos rodam no worker), FlowControl
// (cancelar, pausar/retomar com timers) e o enfileiramento do `flow-step`. Um conjunto por app, criado sob demanda.
import { sql } from 'drizzle-orm'
import {
  FlowControl,
  FlowEngine,
  RealtimePublisher,
  bullTimerScheduler,
  defineQueue,
  type FlowStepJobData,
  type FlowTimerJobData,
  type TimerScheduler,
} from '@crm/core'
import type { WaGateway } from '@crm/wa-port'
import type { ResolvedDeps } from '../../lib/types'

/** Nome da conexão (para a confirmação do "cancelar todos"); `null` = conexão desconhecida. */
export type ConnectionNameSource = (ctx: { companyId: string }, connectionId: string) => Promise<string | null> | string | null

declare module '../../lib/types' {
  interface AppDeps {
    /** Motor (default: criado com `waGateway` e o enfileiramento abaixo). */
    flowEngine?: FlowEngine
    /** Controle de runs (default: timers na fila `flow-timer` e `flowStepEnqueue`). */
    flowControl?: FlowControl
    /** Enfileira `flow-step { runId, expectedSeq }` (default: fila BullMQ `flow-step` pelo `REDIS_URL`). */
    flowStepEnqueue?: (job: FlowStepJobData) => Promise<void>
    /** Nome da conexão (além das fontes registradas e de `crm.connections`, T40). */
    connectionName?: ConnectionNameSource
  }
}

const nameSources = new Set<ConnectionNameSource>()

/** Registra uma fonte de nomes de conexão (o módulo de conexões, T40); devolve a função que desfaz o registro. */
export function registerConnectionNameSource(source: ConnectionNameSource): () => void {
  nameSources.add(source)
  return () => {
    nameSources.delete(source)
  }
}

/** `42P01` = relação inexistente (`crm.connections` antes da T40). */
const isUndefinedTable = (err: unknown) => {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) if ((e as { code?: unknown }).code === '42P01') return true
  return false
}

/** jobId do `flow-step` (mesmo formato do worker, T25: `run-<id>-seq-<n>`; o BullMQ recusa `:`). */
export const flowStepJobId = (data: FlowStepJobData) => `run-${data.runId}-seq-${data.expectedSeq}`

export interface FlowServices {
  /** Motor SEM enqueue próprio: quem cria o run enfileira o 1º passo com `enqueue` (vale também p/ engine injetado). */
  engine: FlowEngine
  control: FlowControl
  enqueue: (job: FlowStepJobData) => Promise<void>
  publisher: RealtimePublisher
  connectionName(ctx: { companyId: string }, connectionId: string): Promise<string | null>
}

const cache = new WeakMap<ResolvedDeps, FlowServices>()

/** Gateway da API: o motor só cria runs aqui, nunca executa nós (isso é do worker). */
const noGateway = new Proxy({} as WaGateway, {
  get: () => {
    throw new Error('WaGateway indisponível na API: os passos do fluxo rodam no worker')
  },
})

export function flowServices(deps: ResolvedDeps): FlowServices {
  let s = cache.get(deps)
  if (s) return s
  let stepQueue: ReturnType<typeof defineQueue<FlowStepJobData>> | undefined
  let timerQueue: ReturnType<typeof defineQueue<FlowTimerJobData>> | undefined
  const enqueue =
    deps.flowStepEnqueue ??
    (async (job: FlowStepJobData) => {
      stepQueue ??= defineQueue<FlowStepJobData>('flow-step')
      await stepQueue.add('flow-step', job, { jobId: flowStepJobId(job) })
    })
  // Fila de timers criada só quando um timer precisa ser agendado/removido.
  const timers: TimerScheduler = {
    schedule: (data, delayMs) => bullTimerScheduler((timerQueue ??= defineQueue<FlowTimerJobData>('flow-timer'))).schedule(data, delayMs),
    cancel: (data) => bullTimerScheduler((timerQueue ??= defineQueue<FlowTimerJobData>('flow-timer'))).cancel(data),
  }
  const control = deps.flowControl ?? new FlowControl({ db: deps.db, timers, enqueueStep: enqueue, logger: deps.logger })
  s = {
    engine: deps.flowEngine ?? new FlowEngine({ db: deps.db, wa: deps.waGateway ?? noGateway, logger: deps.logger, hooks: control.engineHooks() }),
    control,
    enqueue,
    publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
    async connectionName(ctx, connectionId) {
      for (const source of [...(deps.connectionName ? [deps.connectionName] : []), ...nameSources]) {
        const name = await source(ctx, connectionId)
        if (name !== null && name !== undefined) return name
      }
      try {
        const res = await deps.db.execute(sql`select name from crm.connections where id::text = ${connectionId} and company_id = ${ctx.companyId} limit 1`)
        const row = res.rows[0] as { name?: string } | undefined
        return typeof row?.name === 'string' ? row.name : null
      } catch (err) {
        if (isUndefinedTable(err)) return null
        throw err
      }
    },
  }
  cache.set(deps, s)
  return s
}

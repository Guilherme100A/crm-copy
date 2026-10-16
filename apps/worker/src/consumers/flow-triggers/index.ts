// Consumidor dos gatilhos de fluxo (T61): cada `crm.inbound` (T33) passa pelo FlowTriggers (palavra-chave,
// boas-vindas, conversa finalizada, resposta padrão e ação fora do horário). Os runs começam pelo FlowEngine.startRun
// (T25), que enfileira o 1º `flow-step`; a palavra-chave cancela o run anterior pelo FlowControl (T30).
import {
  FLOW_TIMER_QUEUE,
  FlowControl,
  FlowEngine,
  FlowTriggers,
  bullTimerScheduler,
  defineQueue,
  type FlowStepJobData,
  type FlowTimerJobData,
  type FlowTriggersOptions,
} from '@crm/core'
import type { WaGateway } from '@crm/wa-port'
import { onCrmInbound } from '../chats'
import { FLOW_STEP_QUEUE, flowStepEnqueuer } from '../../jobs/flow-step'

let configured: Partial<FlowTriggersOptions> = {}
let processTriggers: FlowTriggers | undefined

/** Completa/troca as dependências do processo (db, waGateway da mensagem fora do horário, engine, control, logger). */
export function configureFlowTriggers(deps: Partial<FlowTriggersOptions>): void {
  configured = { ...configured, ...deps }
  processTriggers = undefined
}

/** O motor só CRIA runs aqui; os passos (que usam o WaGateway) rodam no job `flow-step`. */
const noGateway = new Proxy({} as WaGateway, {
  get: () => {
    throw new Error('WaGateway indisponível no consumidor de gatilhos: os passos do fluxo rodam no flow-step')
  },
})

/**
 * Gatilhos do processo, criados no primeiro uso com o que `configureFlowTriggers` definiu. Sem `db` configurado
 * devolve `undefined` e o `crm.inbound` é ignorado (como o flow-timer, T30): a produção chama
 * `configureFlowTriggers({ db, waGateway, logger })` no boot.
 */
export function flowTriggers(): FlowTriggers | undefined {
  if (processTriggers) return processTriggers
  const db = configured.db
  if (!db) return undefined
  const enqueueStep = flowStepEnqueuer(defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE))
  const control = new FlowControl({ db, timers: bullTimerScheduler(defineQueue<FlowTimerJobData>(FLOW_TIMER_QUEUE)), enqueueStep })
  processTriggers = new FlowTriggers({
    ...configured,
    db,
    engine: configured.engine ?? new FlowEngine({ db, wa: noGateway, enqueue: enqueueStep, hooks: control.engineHooks() }),
    control: configured.control ?? control,
  })
  return processTriggers
}

/**
 * Liga o `crm.inbound` aos gatilhos. Com `triggers`, usa esse (testes); sem, o do processo. Falha nos gatilhos é
 * registrada e não derruba o ingest nem os outros ouvintes (agente de IA). Devolve a função que desliga.
 */
export function registerFlowTriggersConsumer(triggers?: FlowTriggers, logger?: { error(obj: object, msg?: string): void }): () => void {
  return onCrmInbound(async (e) => {
    const t = triggers ?? flowTriggers()
    if (!t) return
    try {
      await t.handleInbound(e)
    } catch (err) {
      ;(logger ?? configured.logger)?.error({ err: err instanceof Error ? err.message : String(err), chat_id: e.chat_id, message_id: e.message_id }, 'gatilhos de fluxo: falha ao processar mensagem')
    }
  })
}

// Nós de lógica (T41): condição, distribuidor, conexão de fluxo e intervalo inteligente. `registerLogicNodes` troca o
// stub do grupo `logic` em `nodes/index.ts`; `configureLogicNodes` define as deps usadas pelo registry padrão.
import type { NodeRegistry } from '../../engine/registry'
import { logicHandlers, type LogicDeps } from './handlers'

let processDeps: LogicDeps = {}

/** Deps do registry padrão do processo (ex.: o `publisher` do realtime na montagem de produção). */
export function configureLogicNodes(deps: LogicDeps): void {
  processDeps = { ...processDeps, ...deps }
}

export function registerLogicNodes(registry: NodeRegistry, deps?: LogicDeps): NodeRegistry {
  // Sem deps explícitas, lê as do processo na execução (configuráveis depois do registro).
  const handlers = deps ? logicHandlers(deps) : lazyHandlers()
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler)
  return registry
}

function lazyHandlers(): ReturnType<typeof logicHandlers> {
  const types = ['condition', 'distributor', 'connection_flow', 'smart_interval'] as const
  return Object.fromEntries(types.map((t) => [t, { execute: (ctx: Parameters<ReturnType<typeof logicHandlers>[typeof t]['execute']>[0]) => logicHandlers(processDeps)[t].execute(ctx) }])) as ReturnType<typeof logicHandlers>
}

export { LogicNodeError, logicHandlers, type LogicDeps } from './handlers'
export * from './rules'

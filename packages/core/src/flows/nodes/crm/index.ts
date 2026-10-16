// Nós de CRM (T63): etiquetas, chat, departamento, kanban, manipulador, venda aprovada e agente de IA.
// `registerCrmNodes` troca o stub do grupo `crm` em `nodes/index.ts`; `configureCrmNodes` define as deps do processo.
import type { NodeRegistry } from '../../engine/registry'
import { crmHandlers, type CrmDeps } from './handlers'

let processDeps: CrmDeps = {}

/** Deps do registry padrão do processo (ex.: o `publisher` do realtime na montagem de produção). */
export function configureCrmNodes(deps: CrmDeps): void {
  processDeps = { ...processDeps, ...deps }
}

export function registerCrmNodes(registry: NodeRegistry, deps?: CrmDeps): NodeRegistry {
  const handlers = deps ? crmHandlers(deps) : undefined
  for (const type of Object.keys(crmHandlers()) as Array<keyof ReturnType<typeof crmHandlers>>)
    registry.register(type, handlers ? handlers[type] : { execute: (ctx) => crmHandlers(processDeps)[type].execute(ctx) })
  return registry
}

export { CrmNodeError, FLOW_LABEL_COLOR, crmHandlers, type CrmDeps } from './handlers'
export * from './rules'

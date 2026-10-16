// Nós externos (T42): Integração HTTP (com proteção SSRF) e Bloco de IA (provedor medido, `feature = 'flow_ai'`).
// `registerExternalNodes` troca o stub do grupo `external` em `nodes/index.ts`; `configureExternalNodes` define as deps
// do processo (LLM por empresa, chave por integração e UsageGuard na montagem de produção).
import type { NodeRegistry } from '../../engine/registry'
import { externalHandlers, type ExternalDeps } from './handlers'

let processDeps: ExternalDeps = {}

export function configureExternalNodes(deps: ExternalDeps): void {
  processDeps = { ...processDeps, ...deps }
}

export function registerExternalNodes(registry: NodeRegistry, deps?: ExternalDeps): NodeRegistry {
  const handlers = deps ? externalHandlers(deps) : undefined
  for (const type of ['integration', 'ai'] as const)
    registry.register(type, handlers ? handlers[type] : { execute: (ctx) => externalHandlers(processDeps)[type].execute(ctx) })
  return registry
}

export { ExternalNodeError, FLOW_AI_FEATURE, externalHandlers, type ExternalDeps } from './handlers'
export * from './http'

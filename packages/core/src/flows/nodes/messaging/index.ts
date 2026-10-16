// Nós de mensagem (T51): mensagem (texto, mídia, arquivo, figurinha, contato, atraso, modelo interno), notificação
// e Pix. `registerMessagingNodes` troca o stub do grupo `messages` em `nodes/index.ts`.
import type { NodeRegistry } from '../../engine/registry'
import { messagingHandlers, type MessagingDeps } from './handlers'

export function registerMessagingNodes(registry: NodeRegistry, deps: MessagingDeps = {}): NodeRegistry {
  const handlers = messagingHandlers(deps)
  registry.register('message', handlers.message)
  registry.register('notification', handlers.notification)
  registry.register('pix', handlers.pix)
  return registry
}

export {
  applyGlobals,
  contactVcard,
  delaySeconds,
  MessagingConfigError,
  messagingHandlers,
  mimeOf,
  runMessageAction,
  type MessagingDeps,
  type Outgoing,
  type SentMessage,
} from './handlers'
export { DRY_RUN_SESSION, MessagingTargetError, defaultGlobals, defaultLoadTemplate, defaultResolveTarget, type SendTarget } from './data'
export { PIX_KEY_TYPES, crc16ccitt, normalizePixKey, pixAmount, pixEmv, pixMessage, type PixEmvInput, type PixKeyType } from './pix'

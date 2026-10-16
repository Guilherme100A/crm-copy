// Nós interativos (T62): menu (interactive_menu / menu legado), carrossel e Aguarda Resposta, todos como texto.
// `registerInteractiveNodes` troca o stub do grupo `interactive` em `nodes/index.ts`.
import type { NodeRegistry } from '../../engine/registry'
import { interactiveHandlers, type InteractiveDeps } from './handlers'

export function registerInteractiveNodes(registry: NodeRegistry, deps: InteractiveDeps = {}): NodeRegistry {
  for (const [type, handler] of Object.entries(interactiveHandlers(deps))) registry.register(type, handler)
  return registry
}

export { DEFAULT_MENU_TIMEOUT_MS, interactiveHandlers, type InteractiveDeps } from './handlers'
export { matchOption, menuText, normalizeAnswer, replyOptions, type MenuOption } from './menu'

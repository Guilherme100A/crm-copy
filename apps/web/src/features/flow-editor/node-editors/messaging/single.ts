// Nós com uma ação principal única (Pix, Notificação, menus, carrossel, Aguardar resposta): `ensureAction` completa
// o nó novo (criado vazio pela paleta) com a config padrão, sem mexer nas ações que já existem.
import type { FlowAction } from '@crm/shared/flows'
import { newAction } from './rules'

type Config = Record<string, unknown>

/** Garante a ação `type` (a primeira encontrada fica; senão entra uma com `config()` na posição `at`). */
export function ensureAction(actions: FlowAction[], type: string | readonly string[], config: () => Config, at: 'start' | 'end' = 'start'): FlowAction[] {
  const types = typeof type === 'string' ? [type] : type
  if (actions.some((a) => types.includes(a.type))) return actions
  const created = newAction(types[0]!, config())
  return at === 'start' ? [created, ...actions] : [...actions, created]
}

export const findAction = (actions: readonly FlowAction[], type: string | readonly string[]) => {
  const types = typeof type === 'string' ? [type] : type
  return actions.find((a) => types.includes(a.type))
}

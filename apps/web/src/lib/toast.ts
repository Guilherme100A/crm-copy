// Gerenciador global de toasts (Base UI): pode ser chamado fora do React (guards do router, cliente HTTP).
import { Toast } from '@base-ui/react/toast'

export const toastManager = Toast.createToastManager()

/** `type` vira o `data-testid` do toast (ex.: `shell-permission-denied`). */
export function notify(type: string, title: string, description?: string): string {
  return toastManager.add({ type, title, ...(description ? { description } : {}) })
}

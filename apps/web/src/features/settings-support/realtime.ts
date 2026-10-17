// Handlers `support_access.*` (16 §7). Registrados ao importar este módulo: o shell o importa de forma ESTÁTICA,
// porque o SSE só escuta os tipos registrados quando abre (docs/licoes.md, T53).
import { onRealtime } from '@/lib/realtime'
import { applySupportEvent, SUPPORT_EVENT_TYPES } from './queue'

let registered = false

export function registerSupportRealtime(): void {
  if (registered) return
  registered = true
  for (const type of SUPPORT_EVENT_TYPES) onRealtime(type, applySupportEvent)
}

registerSupportRealtime()

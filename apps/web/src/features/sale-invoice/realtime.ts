// `sale.updated` (T112/T113) no cache do status da NF/UTMify. Registrado no carregamento do slot do histórico
// (`sale-history-slot.tsx`, importado de forma eager pelo histórico); idempotente. Se o SSE já estava aberto sem este
// tipo (lição T53), o status `pending` ainda é reconsultado por intervalo (`PENDING_POLL_MS`).
import { onRealtime } from '@/lib/realtime'
import { applySaleUpdated } from './logic'

let registered = false

export function registerSaleInvoiceRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('sale.updated', (e, qc) => applySaleUpdated(qc, e.data))
}

// Liga a fila de mensagens (T14) ao SessionManager (T13) — ai-manager apps/worker/src/queue/attach.ts:
// - estado → PAUSED pausa a fila da sessão; saída de PAUSED a retoma;
// - conexão aberta inicia o Worker da sessão e liga os receipts do transporte (→ handleReceipt + antiban);
// - o transporte só é entregue à fila enquanto a sessão está conectada.
import type { MessageQueue, SessionManager, WaTransport } from '@crm/wa-engine'

export interface AttachQueueOptions {
  logger?: { error(obj: object, msg?: string): void }
}

/** Devolve a função que desfaz a ligação. Chame antes de conectar as sessões. */
export function attachQueueToSessions(manager: SessionManager, queue: MessageQueue, opts: AttachQueueOptions = {}): () => void {
  const wired = new WeakSet<WaTransport>()
  const fail = (sessionId: string, what: string) => (err: unknown) =>
    opts.logger?.error({ session_id: sessionId, err: err instanceof Error ? err.message : String(err) }, what)

  queue.setTransportProvider((sessionId) => (manager.isConnected(sessionId) ? manager.getTransport(sessionId) : undefined))

  const onState = ({ sessionId, from, to }: { sessionId: string; from: string; to: string }) => {
    if (to === 'PAUSED') void queue.pause(sessionId).catch(fail(sessionId, 'queue pause failed'))
    else if (from === 'PAUSED') void queue.resume(sessionId).catch(fail(sessionId, 'queue resume failed'))
  }

  const onConnected = ({ sessionId, transport }: { sessionId: string; transport: WaTransport }) => {
    if (!wired.has(transport)) {
      wired.add(transport)
      // handleReceipt também avisa o antiban (`antiban` da MessageQueue, T14).
      transport.on('receipt', (r) => void queue.handleReceipt(sessionId, r).catch(fail(sessionId, 'receipt handling failed')))
    }
    void queue.startSession(sessionId).catch(fail(sessionId, 'queue worker start failed'))
  }

  manager.on('state', onState)
  manager.on('connected', onConnected)
  return () => {
    manager.off('state', onState)
    manager.off('connected', onConnected)
    queue.setTransportProvider(undefined)
  }
}

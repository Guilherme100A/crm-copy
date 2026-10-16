// Ganchos do ciclo de vida do chat (T120): quem precisa reagir a um chat resolvido (gatilho "atendimento finalizado"
// da T61) se inscreve aqui, sem a rota de chats conhecer os fluxos. Chamados depois do commit, em ordem; a falha de
// um ouvinte é entregue a `onError` e não desfaz a resolução nem impede os demais.

export interface ChatResolvedEvent {
  companyId: string
  chatId: string
  /** Quem resolveu (`null` = sistema). */
  actorUserId: string | null
}

type Listener = (e: ChatResolvedEvent) => void | Promise<void>
type ErrorSink = (err: unknown, e: ChatResolvedEvent) => void

const listeners = new Set<{ fn: Listener; onError?: ErrorSink }>()

/** Inscreve um ouvinte de "chat resolvido". Devolve a função que cancela. */
export function onChatResolved(fn: Listener, onError?: ErrorSink): () => void {
  const entry = onError ? { fn, onError } : { fn }
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

export async function emitChatResolved(e: ChatResolvedEvent): Promise<void> {
  for (const entry of [...listeners]) {
    try {
      await entry.fn(e)
    } catch (err) {
      entry.onError?.(err, e)
    }
  }
}

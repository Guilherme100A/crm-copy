import type { TransportEvent, TransportEvents, TransportListener } from './types'

/** Emissor tipado compartilhado pelos transportes. Erros de listeners não derrubam o emissor. */
export class TransportEmitter {
  private readonly listeners = new Map<TransportEvent, Set<(payload: never) => void>>()

  on<E extends TransportEvent>(event: E, cb: TransportListener<E>): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb as (payload: never) => void)
  }

  off<E extends TransportEvent>(event: E, cb: TransportListener<E>): void {
    this.listeners.get(event)?.delete(cb as (payload: never) => void)
  }

  removeAllListeners(event?: TransportEvent): void {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
  }

  listenerCount(event: TransportEvent): number {
    return this.listeners.get(event)?.size ?? 0
  }

  protected emit<E extends TransportEvent>(event: E, payload: TransportEvents[E]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        ;(cb as TransportListener<E>)(payload)
      } catch (err) {
        this.onListenerError(err, event)
      }
    }
  }

  /** Sobrescreva para logar; por padrão o erro é ignorado para não quebrar o loop de eventos. */
  protected onListenerError(_err: unknown, _event: TransportEvent | 'internal'): void {}
}

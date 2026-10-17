// Realtime no cliente (SPEC 3.7; spec 21 "Realtime"): uma conexão SSE por aba em `/api/events?company_id=`, com o
// cookie da sessão. Reabre ao voltar `online` e quando a aba fica visível de novo; o navegador ainda reconecta
// sozinho com `Last-Event-ID`. Cada evento é despachado para o cache do TanStack Query pelos handlers registrados
// por tipo (`onRealtime('chat.updated', …)`); módulos registram os seus.
import { useEffect } from 'react'
import { apiUrl } from './base'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

export interface RealtimeEnvelope<D = unknown> {
  id: string
  type: string
  company_id: string
  at: string
  data: D
}

export type RealtimeHandler = (event: RealtimeEnvelope, queryClient: QueryClient) => void

const handlers = new Map<string, Set<RealtimeHandler>>()

/** Registra um handler para o tipo (`<domínio>.<ação>`); `*` recebe todos. Devolve a função que remove. */
export function onRealtime(type: string, handler: RealtimeHandler): () => void {
  let set = handlers.get(type)
  if (!set) handlers.set(type, (set = new Set()))
  set.add(handler)
  return () => set.delete(handler)
}

/** Tipos com handler registrado (cada um vira um `addEventListener`). */
export const registeredTypes = () => [...handlers.keys()].filter((t) => t !== '*')

export function dispatchRealtime(event: RealtimeEnvelope, queryClient: QueryClient): void {
  for (const h of [...(handlers.get(event.type) ?? []), ...(handlers.get('*') ?? [])]) {
    try {
      h(event, queryClient)
    } catch {
      // um handler com erro não derruba os outros nem a conexão
    }
  }
}

/** Forma mínima do EventSource (o do navegador serve; testes injetam um fake). */
export interface EventSourceLike {
  readyState: number
  addEventListener(type: string, listener: (e: MessageEvent) => void): void
  close(): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

const CLOSED = 2

export interface RealtimeConnectionOptions {
  companyId: string
  queryClient: QueryClient
  createEventSource?: EventSourceFactory
  /** Tipos ouvidos; padrão: os registrados no momento da abertura (+ `ping` e `resync`). */
  types?: () => string[]
}

/** Conexão SSE da empresa ativa. `ensure()` reabre se estiver fechada (rede voltou, aba visível). */
export class RealtimeConnection {
  private source: EventSourceLike | null = null
  private closed = false

  constructor(private readonly opts: RealtimeConnectionOptions) {}

  get url(): string {
    return apiUrl(`/api/events?company_id=${encodeURIComponent(this.opts.companyId)}`)
  }

  open(): void {
    if (this.closed) return
    const create = this.opts.createEventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike)
    const source = create(this.url)
    this.source = source
    const types = new Set([...(this.opts.types?.() ?? registeredTypes())])
    for (const type of types) {
      source.addEventListener(type, (e) => {
        try {
          const data = JSON.parse(e.data) as RealtimeEnvelope | RealtimeEnvelope['data']
          const event: RealtimeEnvelope =
            data && typeof data === 'object' && 'type' in data && 'data' in data
              ? (data as RealtimeEnvelope)
              : { id: e.lastEventId, type, company_id: this.opts.companyId, at: new Date().toISOString(), data }
          dispatchRealtime(event, this.opts.queryClient)
        } catch {
          // evento malformado: ignora
        }
      })
    }
    // Sem histórico para o Last-Event-ID: o servidor pede resync e o cliente recarrega tudo.
    source.addEventListener('resync', () => void this.opts.queryClient.invalidateQueries())
  }

  /** Reabre se o navegador desistiu (readyState CLOSED) ou se nunca abriu. */
  ensure(): void {
    if (this.closed) return
    if (!this.source || this.source.readyState === CLOSED) {
      this.source?.close()
      this.open()
    }
  }

  close(): void {
    this.closed = true
    this.source?.close()
    this.source = null
  }
}

/** Liga o realtime da empresa ativa enquanto o componente estiver montado (o shell monta uma vez). */
export function useRealtime(companyId: string | null | undefined): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!companyId || typeof EventSource === 'undefined') return
    const conn = new RealtimeConnection({ companyId, queryClient })
    conn.open()
    const onOnline = () => conn.ensure()
    const onVisible = () => {
      if (document.visibilityState === 'visible') conn.ensure()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      conn.close()
    }
  }, [companyId, queryClient])
}

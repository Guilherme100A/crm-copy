// Outbox de eventos (T21, AI-MANAGER-MAP §13.4/§13.5 A1): tudo que o CRM precisa saber do WhatsApp vira WaEvent v1
// no Redis Stream `wsm:events` (XADD MAXLEN ~100000, campo `event`), consumido pelo grupo `crm` (T09).
// - Ordem: uma cadeia por sessão; o evento só entra no buffer depois dos anteriores da mesma sessão (inclusive
//   o download eager da mídia).
// - Redis fora do ar não derruba a sessão: os eventos ficam no buffer (FIFO) e o publicador tenta de novo.
import { parseWaEvent, WA_EVENT_VERSION, WA_EVENTS_STREAM, type WaEvent } from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { ContactSync } from '../contacts'
import type { MediaService } from '../media'
import type { MessageStatus } from '../queue/states'
import { toQrDataUrl } from '../session/qr'
import type { SessionState } from '../session/states'
import type { DisconnectKind, HistoryBatch, IncomingMessage, PresenceUpdate, WaTransport } from '../transport'
import { inboundEvent, presenceEvent, toWaMessage } from './convert'

export const DEFAULT_OUTBOX_MAXLEN = 100_000
export const DEFAULT_OUTBOX_RETRY_MS = 1000
export const DEFAULT_OUTBOX_BUFFER_LIMIT = 10_000
/** Campo da entrada do stream (o consumidor da T09 lê `event`). */
export const OUTBOX_EVENT_FIELD = 'event'

/** Parte do SessionManager (T13) que o outbox escuta. */
export interface OutboxManager {
  on(event: 'connected', cb: (ctx: { sessionId: string; transport: WaTransport }) => void): unknown
  on(event: 'disconnected', cb: (ctx: { sessionId: string; reason: DisconnectKind | 'local'; statusCode?: number }) => void): unknown
  on(event: 'state', cb: (ev: { sessionId: string; from: SessionState; to: SessionState }) => void): unknown
  on(event: 'qr', cb: (ev: { sessionId: string; qr: string }) => void): unknown
  on(event: 'pairing-code', cb: (ev: { sessionId: string; code: string }) => void): unknown
  off(event: string, cb: (...args: never[]) => void): unknown
}

/** Parte da MessageQueue (T14) usada para `message.status`. */
export interface OutboxQueue {
  on(event: 'status', cb: (ev: { messageId: string; sessionId: string; from: MessageStatus | null; to: MessageStatus }) => void): unknown
  off(event: 'status', cb: (ev: { messageId: string; sessionId: string; from: MessageStatus | null; to: MessageStatus }) => void): unknown
  get(id: string): Promise<{ transportMessageId: string | null; lastError: string | null }>
}

/** Só o XADD é usado: ioredis `Redis` ou um fake com `xadd(...args)` nos testes. */
export type OutboxRedis = Pick<Redis, 'xadd'> | { xadd(...args: (string | number)[]): Promise<unknown> }

type XaddFn = (...args: (string | number)[]) => Promise<unknown>

export interface OutboxLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface EventOutboxOptions {
  stream?: string
  maxLen?: number
  /** Download/gravação da mídia recebida. Sem ele a mídia sai `pending`. */
  media?: MediaService
  /** Espera entre tentativas quando o Redis falha. */
  retryMs?: number
  /** Máximo de eventos em espera; acima disso os mais antigos são descartados (com log). */
  bufferLimit?: number
  logger?: OutboxLogger
  now?: () => Date
}

export interface EventOutbox {
  /** Remove todos os listeners (manager, fila e transportes). Eventos já no buffer continuam sendo publicados. */
  detach(): void
  /** Espera publicar tudo o que já foi capturado (inclusive o que está nas cadeias por sessão). */
  flush(): Promise<void>
  /** Eventos no buffer, ainda não confirmados pelo Redis. */
  readonly pending: number
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function attachEventOutbox(
  manager: OutboxManager,
  queue: OutboxQueue | undefined,
  redis: OutboxRedis,
  opts: EventOutboxOptions = {},
): EventOutbox {
  const stream = opts.stream ?? WA_EVENTS_STREAM
  const maxLen = opts.maxLen ?? DEFAULT_OUTBOX_MAXLEN
  const retryMs = opts.retryMs ?? DEFAULT_OUTBOX_RETRY_MS
  const bufferLimit = opts.bufferLimit ?? DEFAULT_OUTBOX_BUFFER_LIMIT
  const now = opts.now ?? (() => new Date())
  const log = opts.logger

  // ---------------------------------------------------------------- publicação (buffer FIFO + retry)
  const buffer: string[] = []
  let draining: Promise<void> | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let detached = false
  const idleWaiters: (() => void)[] = []

  const enqueueEvent = (event: WaEvent) => {
    let json: string
    try {
      json = JSON.stringify(parseWaEvent(event))
    } catch (err) {
      log?.error({ type: event.type, session_id: event.session_id, err: errorMessage(err) }, 'WaEvent inválido descartado')
      return
    }
    buffer.push(json)
    if (buffer.length > bufferLimit) {
      const dropped = buffer.splice(0, buffer.length - bufferLimit)
      log?.error({ dropped: dropped.length }, 'buffer do outbox cheio: eventos mais antigos descartados')
    }
    drain()
  }

  const drain = () => {
    if (draining || retryTimer) return
    draining = (async () => {
      while (buffer.length > 0) {
        try {
          await (redis.xadd as XaddFn).call(redis, stream, 'MAXLEN', '~', maxLen, '*', OUTBOX_EVENT_FIELD, buffer[0]!)
          buffer.shift()
        } catch (err) {
          log?.warn({ pending: buffer.length, err: errorMessage(err) }, 'Redis indisponível: eventos do outbox em espera')
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            drain()
          }, retryMs)
          retryTimer.unref?.()
          return
        }
      }
      for (const wake of idleWaiters.splice(0)) wake()
    })().finally(() => {
      draining = undefined
    })
  }

  // ---------------------------------------------------------------- ordem por sessão
  const chains = new Map<string, Promise<void>>()
  const inSession = (sessionId: string, produce: () => Promise<WaEvent[] | WaEvent | undefined> | WaEvent[] | WaEvent | undefined) => {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const out = await produce()
        for (const e of Array.isArray(out) ? out : out ? [out] : []) enqueueEvent(e)
      })
      .catch((err) => log?.error({ session_id: sessionId, err: errorMessage(err) }, 'falha ao montar evento do outbox'))
    chains.set(sessionId, next)
    void next.then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
  }
  const at = () => now().toISOString()
  const envelope = (sessionId: string) => ({ v: WA_EVENT_VERSION, session_id: sessionId, at: at() }) as const

  const contacts = new ContactSync((sessionId, build) => inSession(sessionId, () => build(at())))

  // ---------------------------------------------------------------- transporte da sessão
  const wired = new Map<string, { transport: WaTransport; unwire: () => void }>()

  const wire = (sessionId: string, transport: WaTransport) => {
    const current = wired.get(sessionId)
    if (current?.transport === transport) return
    current?.unwire()
    const onMessage = (msg: IncomingMessage) =>
      inSession(sessionId, async () => inboundEvent(sessionId, at(), msg, await opts.media?.describe(sessionId, msg) ?? pendingMedia(sessionId, msg)))
    const onPresence = (update: PresenceUpdate) => inSession(sessionId, () => presenceEvent(sessionId, at(), update))
    const onHistory = (batch: HistoryBatch) =>
      inSession(sessionId, async () => {
        const messages = []
        for (const m of batch.messages) {
          const historical = { ...m, historical: true as const }
          messages.push(toWaMessage(historical, (await opts.media?.describe(sessionId, historical)) ?? pendingMedia(sessionId, historical)))
        }
        const event: WaEvent = { ...envelope(sessionId), type: 'history.batch', messages }
        if (batch.sync_type) event.sync_type = batch.sync_type
        if (batch.is_latest !== undefined) event.is_latest = batch.is_latest
        if (batch.progress !== undefined) event.progress = batch.progress
        return event
      })
    transport.on('message', onMessage)
    transport.on('presence', onPresence)
    transport.on('history', onHistory)
    // Contatos e mapeamentos do lote vêm depois do `history.batch` (mesma cadeia).
    const onHistoryContacts = (batch: HistoryBatch) => contacts.publishBatch(sessionId, batch.contacts, batch.lid_mappings)
    transport.on('history', onHistoryContacts)
    const detachContacts = contacts.attach(sessionId, transport)
    wired.set(sessionId, {
      transport,
      unwire: () => {
        transport.off('message', onMessage)
        transport.off('presence', onPresence)
        transport.off('history', onHistory)
        transport.off('history', onHistoryContacts)
        detachContacts()
      },
    })
  }

  // ---------------------------------------------------------------- manager e fila
  const onConnected = (ctx: { sessionId: string; transport: WaTransport }) => {
    wire(ctx.sessionId, ctx.transport)
    inSession(ctx.sessionId, () => ({ ...envelope(ctx.sessionId), type: 'session.connection', state: 'open' }) as WaEvent)
  }
  const onDisconnected = (ctx: { sessionId: string; reason: DisconnectKind | 'local'; statusCode?: number }) =>
    inSession(ctx.sessionId, () => {
      const event: WaEvent = { ...envelope(ctx.sessionId), type: 'session.connection', state: 'close' }
      if (ctx.reason !== 'local') event.reason = ctx.reason
      if (ctx.statusCode !== undefined) event.status_code = ctx.statusCode
      return event
    })
  const onState = (ev: { sessionId: string; from: SessionState; to: SessionState }) =>
    inSession(ev.sessionId, () => ({ ...envelope(ev.sessionId), type: 'session.state', from: ev.from, to: ev.to }) as WaEvent)
  const onQr = (ev: { sessionId: string; qr: string }) =>
    inSession(ev.sessionId, async () => ({ ...envelope(ev.sessionId), type: 'session.qr', qr: await toQrDataUrl(ev.qr) }) as WaEvent)
  const onPairing = (ev: { sessionId: string; code: string }) =>
    inSession(ev.sessionId, () => ({ ...envelope(ev.sessionId), type: 'session.pairing_code', code: ev.code }) as WaEvent)
  const onStatus = (ev: { messageId: string; sessionId: string; from: MessageStatus | null; to: MessageStatus }) =>
    inSession(ev.sessionId, async () => {
      const view = await queue!.get(ev.messageId).catch(() => undefined)
      const event: WaEvent = {
        ...envelope(ev.sessionId),
        type: 'message.status',
        message_id: ev.messageId,
        transport_message_id: view?.transportMessageId ?? null,
        status: ev.to,
      }
      if (ev.to === 'failed' && view?.lastError) event.error = view.lastError
      return event
    })

  manager.on('connected', onConnected)
  manager.on('disconnected', onDisconnected)
  manager.on('state', onState)
  manager.on('qr', onQr)
  manager.on('pairing-code', onPairing)
  queue?.on('status', onStatus)

  return {
    detach() {
      if (detached) return
      detached = true
      manager.off('connected', onConnected as never)
      manager.off('disconnected', onDisconnected as never)
      manager.off('state', onState as never)
      manager.off('qr', onQr as never)
      manager.off('pairing-code', onPairing as never)
      queue?.off('status', onStatus)
      for (const w of wired.values()) w.unwire()
      wired.clear()
    },
    async flush() {
      // Espera as cadeias por sessão (que alimentam o buffer) e depois o esvaziamento do buffer.
      for (;;) {
        const pendingChains = [...chains.values()]
        if (pendingChains.length === 0) break
        await Promise.all(pendingChains)
      }
      if (buffer.length === 0 && !draining) return
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
        drain()
      })
    },
    get pending() {
      return buffer.length
    },
  }
}

/** Sem MediaService: a mídia é descrita como `pending` (download sob demanda). */
function pendingMedia(sessionId: string, msg: IncomingMessage) {
  if (!msg.media) return undefined
  const m = msg.media
  return {
    session_id: sessionId,
    message_id: msg.id,
    mime: m.mime,
    size: m.size,
    sha256: m.sha256,
    key: null,
    status: 'pending' as const,
    ...(m.file_name ? { file_name: m.file_name } : {}),
  }
}

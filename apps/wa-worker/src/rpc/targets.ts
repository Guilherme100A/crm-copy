// Alvos do RPC interno (lista FECHADA de métodos; espelha WaGateway da `@crm/wa-port` e o bridge do ai-manager).
// Todo envio passa pelo SendPipeline do engine (gates → fila → antiban → transporte). Reação e "apagar para todos"
// rodam os gates e usam o método próprio do transporte (o deliver da fila só envia conteúdo de mensagem).
import type { BlobStore } from '@crm/node-kit'
import {
  phoneToJid,
  TransportNotConnectedError,
  type ConsentService,
  type ConsentSource,
  type CreateSessionInput,
  type ListMessagesFilter,
  type MediaService,
  type MessageQueue,
  type MessageView,
  type SendPipeline,
  type SendRequest,
  type SessionManager,
  type WaTransport,
} from '@crm/wa-engine'
import type { MediaHandle, PresenceKind } from '@crm/wa-port'
import type { ClientMessageDedupe } from './dedupe'
import { RpcError } from './errors'

export type RpcHandler = (args: unknown[]) => Promise<unknown>
export type RpcHandlers = Record<string, Record<string, RpcHandler>>

export interface WaWorkerTargetsDeps {
  manager: SessionManager
  queue: MessageQueue
  /** Pipeline completo (gates → enqueue). */
  pipeline: SendPipeline
  /** Só os gates (enqueue no-op): reação e apagar para todos. */
  gates: SendPipeline
  consent: ConsentService
  health: { getHealth(sessionId: string): Promise<unknown> }
  media: MediaService
  blobStore: Pick<BlobStore, 'get' | 'head'>
  dedupe: ClientMessageDedupe
}

const str = (v: unknown, field = 'id'): string => {
  if (typeof v !== 'string' || !v) throw new RpcError('VALIDATION_ERROR', `${field} is required`)
  return v
}
const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RpcError('VALIDATION_ERROR', `${field} must be an object`)
  return v as Record<string, unknown>
}
const PRESENCE: readonly PresenceKind[] = ['composing', 'recording', 'paused']

/** SendRequest da porta → SendRequest do engine (campos conhecidos; `quoted`/`viewOnce` ainda não aplicados). */
function toSendRequest(raw: Record<string, unknown>): SendRequest {
  const req: SendRequest = { sessionId: str(raw.sessionId, 'sessionId'), phone: str(raw.phone, 'phone'), content: raw.content as SendRequest['content'] }
  if (typeof raw.actor === 'string') req.actor = raw.actor
  if (typeof raw.contactId === 'string' || raw.contactId === null) req.contactId = raw.contactId as string | null
  return req
}

const withClientId = (view: MessageView, clientMessageId: unknown): MessageView & { clientMessageId?: string } =>
  typeof clientMessageId === 'string' && clientMessageId ? { ...view, clientMessageId } : view

export function createRpcHandlers(d: WaWorkerTargetsDeps): RpcHandlers {
  const transportOf = (sessionId: string): WaTransport => {
    const t = d.manager.isConnected(sessionId) ? d.manager.getTransport(sessionId) : undefined
    if (!t) throw new TransportNotConnectedError(`sessão ${sessionId} não está conectada`)
    return t
  }
  const now = () => new Date().toISOString()
  /** Visão de um envio que não passa pela fila (reação/apagar): já `sent`. */
  const directView = (sessionId: string, phone: string, content: unknown, transportMessageId: string): MessageView => ({
    id: transportMessageId,
    sessionId,
    contactId: null,
    phone,
    content,
    status: 'sent',
    attempts: 1,
    lastError: null,
    transportMessageId,
    sentAt: now(),
    deliveredAt: null,
    readAt: null,
    createdAt: now(),
    updatedAt: now(),
  })

  return {
    sessions: {
      create: ([input]) => d.manager.create(obj(input, 'input') as unknown as CreateSessionInput),
      list: () => d.manager.list(),
      get: ([id]) => d.manager.get(str(id)),
      startQr: ([id]) => d.manager.startQr(str(id)),
      getQr: ([id]) => d.manager.getQr(str(id)),
      requestPairingCode: ([id, phone]) => d.manager.requestPairingCode(str(id), typeof phone === 'string' && phone ? phone : undefined),
      pause: ([id]) => d.manager.pause(str(id)),
      resume: ([id]) => d.manager.resume(str(id)),
      restart: ([id]) => d.manager.restart(str(id)),
      logout: ([id]) => d.manager.logout(str(id)),
      // Conexão e banco primeiro; a fila da sessão sai depois (as mensagens já caíram em cascata).
      remove: async ([id]) => {
        const result = await d.manager.remove(str(id))
        await d.queue.removeSession(str(id)).catch(() => undefined)
        return result
      },
      fetchGroups: ([id]) => transportOf(str(id)).fetchGroups(),
    },
    messages: {
      enqueue: async ([raw]) => {
        const input = obj(raw, 'request')
        const req = toSendRequest(input)
        const clientMessageId = typeof input.clientMessageId === 'string' && input.clientMessageId ? input.clientMessageId : undefined
        const view = await d.dedupe.run(req.sessionId, clientMessageId, () => d.pipeline.send(req), (id) => d.queue.get(id))
        return withClientId(view, clientMessageId)
      },
      sendGroup: async ([raw]) => {
        const input = obj(raw, 'request')
        const sessionId = str(input.sessionId, 'sessionId')
        const clientMessageId = typeof input.clientMessageId === 'string' && input.clientMessageId ? input.clientMessageId : undefined
        const send = () =>
          d.pipeline.sendGroup({ sessionId, groupId: str(input.groupId, 'groupId'), content: input.content as SendRequest['content'], actor: String(input.actor ?? '') })
        return withClientId(await d.dedupe.run(sessionId, clientMessageId, send, (id) => d.queue.get(id)), clientMessageId)
      },
      react: async ([raw]) => {
        const input = obj(raw, 'request')
        const sessionId = str(input.sessionId, 'sessionId')
        const phone = str(input.phone, 'phone')
        const content = { react: { messageId: str(input.messageId, 'messageId'), emoji: String(input.emoji ?? '') } }
        await d.gates.runGates({ sessionId, phone, content: content as never, ...(typeof input.actor === 'string' ? { actor: input.actor } : {}) })
        const jid = phoneToJid(phone)
        const res = await transportOf(sessionId).react(jid, { remoteJid: jid, id: content.react.messageId, fromMe: false }, content.react.emoji)
        return directView(sessionId, phone, content, res.messageId)
      },
      deleteForEveryone: async ([raw]) => {
        const input = obj(raw, 'request')
        const sessionId = str(input.sessionId, 'sessionId')
        const phone = str(input.phone, 'phone')
        const content = { delete: { messageId: str(input.messageId, 'messageId') } }
        await d.gates.runGates({ sessionId, phone, content: content as never, ...(typeof input.actor === 'string' ? { actor: input.actor } : {}) })
        const jid = phoneToJid(phone)
        const res = await transportOf(sessionId).deleteForEveryone(jid, { remoteJid: jid, id: content.delete.messageId, fromMe: true })
        return directView(sessionId, phone, content, res.messageId)
      },
      get: ([id]) => d.queue.get(str(id)),
      list: ([filter]) => d.queue.list((filter && typeof filter === 'object' ? filter : {}) as ListMessagesFilter),
      events: ([id]) => d.queue.events(str(id)),
      cancel: ([id]) => d.queue.cancel(str(id)),
      /** Recibo de leitura: keys `{ remoteJid: chatJid, id, fromMe: false }` (não existe "ler a conversa toda"). */
      markRead: async ([sessionId, chatJid, ids]) => {
        if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !x)) throw new RpcError('VALIDATION_ERROR', 'messageIds must be a list of ids')
        const jid = str(chatJid, 'chatJid')
        if (ids.length === 0) return null
        await transportOf(str(sessionId, 'sessionId')).markRead((ids as string[]).map((id) => ({ remoteJid: jid, id, fromMe: false })))
        return null
      },
    },
    media: {
      /** Bytes da mídia recebida (base64). Já gravada (`ready`): lê do BlobStore; senão baixa agora (lazy). */
      download: async ([sessionId, ref]) => {
        const sid = str(sessionId, 'sessionId')
        const handle = obj(ref, 'ref') as Partial<MediaHandle>
        const messageId = str(handle.message_id, 'message_id')
        if (handle.key) {
          const data = await d.blobStore.get(handle.key)
          const info = data ? await d.blobStore.head(handle.key) : null
          if (data) return { mime: info?.mime ?? handle.mime ?? 'application/octet-stream', size: data.byteLength, sha256: info?.sha256 ?? handle.sha256 ?? null, key: handle.key, data: data.toString('base64') }
        }
        const fetched = await d.media.fetch(sid, messageId, { mime: handle.mime ?? 'application/octet-stream', ...(handle.file_name ? { file_name: handle.file_name } : {}) })
        return { mime: fetched.handle.mime, size: fetched.handle.size, sha256: fetched.handle.sha256, key: fetched.handle.key, data: Buffer.from(fetched.bytes).toString('base64') }
      },
    },
    presence: {
      update: async ([sessionId, to, kind]) => {
        if (!PRESENCE.includes(kind as PresenceKind)) throw new RpcError('VALIDATION_ERROR', 'kind must be composing, recording or paused')
        const target = str(to, 'to')
        await transportOf(str(sessionId, 'sessionId')).sendPresence(target.includes('@') ? target : phoneToJid(target), kind as PresenceKind)
        return null
      },
    },
    contacts: {
      recordConsent: async ([raw]) => {
        const input = obj(raw, 'input')
        const opts = typeof input.name === 'string' ? { name: input.name } : {}
        await d.consent.recordConsent(str(input.phone, 'phone'), str(input.source, 'source') as ConsentSource, opts)
        return null
      },
      optOut: async ([raw]) => {
        await d.consent.optOut(str(obj(raw, 'input').phone, 'phone'))
        return null
      },
      /** Agenda da sessão no formato `WaContactSummary` da porta. */
      list: async ([sessionId]) =>
        (await transportOf(str(sessionId, 'sessionId')).listContacts()).map((c) => ({
          jid: c.jid,
          phone: c.phone ?? null,
          lid: c.lid ?? null,
          name: c.name ?? null,
          pushName: c.push_name ?? null,
        })),
    },
    profile: {
      /** O transporte só conhece o número da conta; nome/recado/foto ficam para um transporte com suporte. */
      get: async ([sessionId]) => {
        const t = transportOf(str(sessionId, 'sessionId'))
        return { name: null, status: null, pictureUrl: null, phone: t.ownPhone() ?? null }
      },
      setName: async () => {
        throw new RpcError('NOT_SUPPORTED', 'profile.setName não suportado pelo transporte')
      },
      setStatus: async () => {
        throw new RpcError('NOT_SUPPORTED', 'profile.setStatus não suportado pelo transporte')
      },
      setPicture: async () => {
        throw new RpcError('NOT_SUPPORTED', 'profile.setPicture não suportado pelo transporte')
      },
    },
    health: {
      getHealth: ([id]) => d.health.getHealth(str(id)),
    },
  }
}

/** Só métodos PRÓPRIOS da lista fechada (nunca `constructor`, `__proto__`, `toString`…). */
export function resolveHandler(handlers: RpcHandlers, target: unknown, method: unknown): RpcHandler | undefined {
  if (typeof target !== 'string' || typeof method !== 'string') return undefined
  if (!Object.hasOwn(handlers, target)) return undefined
  const group = handlers[target]!
  return Object.hasOwn(group, method) ? group[method] : undefined
}

// Servidor RPC simulado do worker do ai-manager (SPEC T98), só para teste: `node:http` em 127.0.0.1, porta 0, estado
// em memória. Reproduz o protocolo de apps/worker/src/boot/internal-server.ts (Bearer INTERNAL_TOKEN; lista fechada
// de `target.method`; `UNKNOWN_METHOD` em HTTP 400; erro de domínio serializado em `{ error }` com HTTP 200) e o
// controle `/internal/fake/*` do FakeTransport. Sem `additive`, só existem os alvos de HOJE (o `messages.enqueue` é
// a fila crua, sem gates). Com `additive`, também os alvos propostos A3/A7/A8 e o outbox A1 (WaEvent v1 no stream).
// Não "melhora" o ai-manager: o que não existe lá responde `UNKNOWN_METHOD`.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  parseWaEvent,
  SENDABLE_STATES,
  WA_EVENT_VERSION,
  WA_EVENTS_STREAM,
  type GroupSummary,
  type MessageView,
  type SessionState,
  type SessionView,
  type WaEvent,
} from '@crm/wa-port'
import { STREAM_EVENT_FIELD } from '../../../stream'

export type AiManagerAdditiveTarget = 'send' | 'media' | 'presence' | 'contacts' | 'events'

export interface AiManagerSimulatorOptions {
  token: string
  /** Alvos aditivos simulados: `true` = todos (A1, A3, A7, A8). Default: nenhum (o ai-manager de hoje). */
  additive?: boolean | Partial<Record<AiManagerAdditiveTarget, boolean>>
  /** A1: onde o outbox publica (`XADD <stream> * event <json>`). Sem `redis`, o outbox fica mudo. */
  redis?: { xadd(key: string, ...args: string[]): Promise<unknown> }
  stream?: string
  /** Grupos que toda sessão conectada enxerga (`sessions.fetchGroups`). */
  groups?: GroupSummary[]
}

export interface SimulatedCall {
  target: string
  method: string
  args: unknown[]
}

export interface AiManagerSimulator {
  url: string
  /** Toda chamada que chegou ao `POST /internal/rpc` (inclusive as recusadas com UNKNOWN_METHOD). */
  readonly calls: SimulatedCall[]
  /** Alvos `target.method` que este simulador expõe. */
  readonly targets: string[]
  /** BlobStore da mídia (`media.download` lê por `handle.key`). Compatível com o harness de contrato. */
  blobStore: { put(data: Uint8Array, mime: string): Promise<{ key: string; size: number; sha256: string | null }> }
  /** Presenças recebidas por `presence.update`. */
  readonly presences: Array<{ sessionId: string; to: string; kind: string }>
  close(): Promise<void>
}

/** Erro como o `serializeError` do ai-manager o deixa: nome, mensagem e campos de mapeamento. */
class SimError extends Error {
  constructor(
    name: string,
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = name
  }
}

const SEND_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_CONNECTED: 409,
  CONTACT_NOT_ALLOWED: 403,
}
const rejected = (code: string, message: string, gate?: string) =>
  new SimError('SendRejectedError', message, { code, status: SEND_STATUS[code], ...(gate ? { gate } : {}) })
const sessionNotFound = (id: string) =>
  new SimError('SessionError', `session ${id} not found`, { code: 'SESSION_NOT_FOUND' })
const validation = (message: string) => new SimError('ValidationError', message, { code: 'VALIDATION_ERROR' })
const notConnected = () => new SimError('TransportNotConnectedError', 'transport is not connected')

const E164 = /^\+[1-9]\d{7,14}$/
const GROUP_JID = /^[^\s@]+@g\.us$/
const PRESENCE = ['composing', 'recording', 'paused']
const CONNECTED: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED']

interface SimSession {
  view: SessionView
  /** startQr criou o transporte (o controle fake só responde depois disso, como no ai-manager). */
  transport: boolean
  resumeTo: SessionState
}

interface Contact {
  consent: boolean
  optOut: boolean
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v) throw validation(`${field} is required`)
  return v
}
const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw validation(`${field} must be an object`)
  return v as Record<string, unknown>
}

function enabledTargets(additive: AiManagerSimulatorOptions['additive']): Record<AiManagerAdditiveTarget, boolean> {
  const all = additive === true
  const pick = typeof additive === 'object' ? additive : {}
  return {
    send: all || !!pick.send,
    media: all || !!pick.media,
    presence: all || !!pick.presence,
    contacts: all || !!pick.contacts,
    events: all || !!pick.events,
  }
}

export async function startAiManagerSimulator(opts: AiManagerSimulatorOptions): Promise<AiManagerSimulator> {
  const on = enabledTargets(opts.additive)
  const stream = opts.stream ?? WA_EVENTS_STREAM
  const sessions = new Map<string, SimSession>()
  const messages = new Map<string, MessageView>()
  const contacts = new Map<string, Contact>()
  const idempotency = new Map<string, string>()
  const blobs = new Map<string, { data: Uint8Array; mime: string }>()
  const calls: SimulatedCall[] = []
  const presences: AiManagerSimulator['presences'] = []
  const groups = opts.groups ?? [
    { id: '120363000000000001@g.us', name: 'Grupo simulado', participants: 3, announce: false, isAdmin: true },
  ]
  const now = () => new Date().toISOString()

  // ---- A1: outbox de eventos --------------------------------------------------------------------------------
  const publish = async (event: WaEvent) => {
    if (!on.events || !opts.redis) return
    await opts.redis.xadd(stream, '*', STREAM_EVENT_FIELD, JSON.stringify(parseWaEvent(event)))
  }

  const sessionOf = (id: unknown): SimSession => {
    const s = sessions.get(String(id))
    if (!s) throw sessionNotFound(String(id))
    return s
  }
  const setStatus = async (s: SimSession, to: SessionState) => {
    const from = s.view.status
    s.view = {
      ...s.view,
      status: to,
      state: to,
      updatedAt: now(),
      ...(to === 'WARMING' || to === 'STABLE' ? { lastConnectedAt: now() } : {}),
    }
    if (from !== to)
      await publish({ v: WA_EVENT_VERSION, type: 'session.state', session_id: s.view.id, at: now(), from, to })
  }
  const connected = (s: SimSession) => s.transport && CONNECTED.includes(s.view.status)

  const newMessage = (
    sessionId: string,
    phone: string,
    content: unknown,
    contactId: string | null,
    clientMessageId?: string,
  ): MessageView => {
    const at = now()
    const m: MessageView = {
      id: randomUUID(),
      sessionId,
      contactId,
      phone,
      content,
      status: 'queued',
      attempts: 0,
      lastError: null,
      transportMessageId: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      createdAt: at,
      updatedAt: at,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    }
    messages.set(m.id, m)
    return m
  }

  // ---- A8: SendPipeline (gates na ordem do ai-manager; sem limites de aquecimento/taxa) --------------------
  const pipelineSend = (raw: unknown): MessageView => {
    const req = obj(raw, 'request')
    const sessionId = String(req.sessionId ?? '')
    const phone = String(req.phone ?? '')
    const groupId = typeof req.groupId === 'string' ? req.groupId : undefined
    const clientMessageId =
      typeof req.clientMessageId === 'string' && req.clientMessageId ? req.clientMessageId : undefined
    if (typeof req.actor !== 'string' || !req.actor.trim())
      throw rejected('UNAUTHORIZED', 'authenticated actor required', 'auth')
    const s = sessions.get(sessionId)
    if (!s) throw rejected('SESSION_NOT_FOUND', `session ${sessionId} not found`, 'sessionExists')
    // Idempotência por (sessionId, clientMessageId) antes dos demais gates: o reenvio devolve a mesma mensagem.
    const idemKey = clientMessageId ? `${sessionId}:${clientMessageId}` : undefined
    const existing = idemKey ? idempotency.get(idemKey) : undefined
    if (existing) return messages.get(existing)!
    if (!SENDABLE_STATES.includes(s.view.status) || !s.transport)
      throw rejected('SESSION_NOT_CONNECTED', `session ${sessionId} is ${s.view.status}`, 'connected')
    if (groupId) {
      if (phone !== groupId || !GROUP_JID.test(groupId))
        throw rejected('VALIDATION_ERROR', 'invalid group recipient', 'contactAllowed')
      const group = groups.find((g) => g.id === groupId)
      if (!group || (group.announce && !group.isAdmin))
        throw rejected('CONTACT_NOT_ALLOWED', 'not a member or group only allows admins to send', 'contactAllowed')
    } else {
      const c = contacts.get(phone)
      const reason = !c ? 'contact_not_found' : c.optOut ? 'opt_out' : !c.consent ? 'no_consent' : undefined
      if (reason) throw rejected('CONTACT_NOT_ALLOWED', `contact not allowed: ${reason}`, 'contactAllowed')
    }
    const m = newMessage(
      sessionId,
      phone,
      req.content,
      typeof req.contactId === 'string' ? req.contactId : null,
      clientMessageId,
    )
    if (idemKey) idempotency.set(idemKey, m.id)
    return m
  }

  type Handler = (args: unknown[]) => unknown | Promise<unknown>
  const unavailable = (what: string) => () => {
    throw new Error(`${what} not simulated`)
  }

  // Alvos de HOJE (bridgeHandlers do ai-manager).
  const handlers: Record<string, Record<string, Handler>> = {
    sessions: {
      getConversation: unavailable('conversation'),
      configureConversation: unavailable('conversation'),
      tickConversation: unavailable('conversation'),
      getGroupAutomation: unavailable('group automation'),
      configureGroupAutomation: unavailable('group automation'),
      tickGroupAutomation: unavailable('group automation'),
      runGroupInvite: unavailable('runGroupInvite'),
      addGroupParticipant: unavailable('addGroupParticipant'),
      create: ([raw]) => {
        const input = obj(raw, 'input')
        const name = str(input.name, 'name')
        const phone = input.phone === undefined || input.phone === null ? null : String(input.phone)
        if (phone !== null && !E164.test(phone))
          throw new SimError('SessionError', 'invalid phone', { code: 'VALIDATION_ERROR' })
        const at = now()
        const view: SessionView = {
          id: randomUUID(),
          name,
          phone,
          status: 'NEW',
          state: 'NEW',
          proxyId: typeof input.proxyId === 'string' ? input.proxyId : null,
          note: typeof input.note === 'string' ? input.note : null,
          requiresRestart: false,
          warmupStartedAt: null,
          lastConnectedAt: null,
          createdAt: at,
          updatedAt: at,
        }
        sessions.set(view.id, { view, transport: false, resumeTo: 'WARMING' })
        return view
      },
      list: () => [...sessions.values()].map((s) => s.view),
      get: ([id]) => sessionOf(id).view,
      startQr: ([id]) => {
        const s = sessionOf(id)
        s.transport = true
        return s.view
      },
      getQr: ([id]) => {
        const s = sessionOf(id)
        return s.transport && s.view.status === 'NEW'
          ? { qr: 'data:image/png;base64,c2lt', generatedAt: now() }
          : { qr: null, generatedAt: null }
      },
      requestPairingCode: ([id, phone]) => {
        const s = sessionOf(id)
        if (!s.view.phone && (phone === undefined || phone === null))
          throw new SimError('SessionError', 'phone is required for pairing code', { code: 'VALIDATION_ERROR' })
        s.transport = true
        return { code: 'SIMU-LADO' }
      },
      pause: async ([id]) => {
        const s = sessionOf(id)
        if (!CONNECTED.includes(s.view.status) || s.view.status === 'PAUSED')
          throw new SimError('InvalidTransitionError', `cannot pause from ${s.view.status}`, {
            from: s.view.status,
            to: 'PAUSED',
          })
        s.resumeTo = s.view.status
        await setStatus(s, 'PAUSED')
        return s.view
      },
      resume: async ([id]) => {
        const s = sessionOf(id)
        if (s.view.status !== 'PAUSED')
          throw new SimError('InvalidTransitionError', `cannot resume from ${s.view.status}`, {
            from: s.view.status,
            to: s.resumeTo,
          })
        await setStatus(s, s.resumeTo)
        return s.view
      },
      restart: ([id]) => {
        const s = sessionOf(id)
        s.view = { ...s.view, requiresRestart: false, updatedAt: now() }
        return s.view
      },
      logout: async ([id]) => {
        const s = sessionOf(id)
        s.transport = false
        await setStatus(s, 'DISCONNECTED')
        return s.view
      },
      remove: ([id]) => {
        const s = sessionOf(id)
        sessions.delete(s.view.id)
        for (const [mid, m] of messages) if (m.sessionId === s.view.id) messages.delete(mid)
        return { deletedProxyId: null }
      },
      fetchGroups: ([id]) => {
        const s = sessions.get(String(id))
        if (!s || !connected(s)) throw notConnected()
        return groups
      },
    },
    messages: {
      get: ([id]) => {
        const m = messages.get(String(id))
        if (!m)
          throw new SimError('MessageNotFoundError', `message ${String(id)} not found`, {
            code: 'MESSAGE_NOT_FOUND',
            messageId: String(id),
          })
        return m
      },
      list: ([filter]) => {
        const f = (filter ?? {}) as { sessionId?: string; status?: string }
        return [...messages.values()].filter(
          (m) => (!f.sessionId || m.sessionId === f.sessionId) && (!f.status || m.status === f.status),
        )
      },
      events: () => [],
      cancel: ([id]) => {
        const m = messages.get(String(id))
        if (!m)
          throw new SimError('MessageNotFoundError', `message ${String(id)} not found`, {
            code: 'MESSAGE_NOT_FOUND',
            messageId: String(id),
          })
        if (m.status !== 'queued' && m.status !== 'retrying')
          throw new SimError('MessageTransitionError', `cannot cancel from ${m.status}`, {
            from: m.status,
            to: 'cancelled',
            messageId: m.id,
          })
        const cancelled: MessageView = { ...m, status: 'cancelled', updatedAt: now() }
        messages.set(m.id, cancelled)
        return cancelled
      },
      // A fila crua do ai-manager: grava `queued` sem passar por gate nenhum.
      enqueue: ([raw]) => {
        const input = obj(raw, 'input')
        return newMessage(
          String(input.sessionId),
          String(input.phone),
          input.content,
          typeof input.contactId === 'string' ? input.contactId : null,
        )
      },
    },
    health: { getHealth: ([id]) => ({ sessionId: String(id), score: 100 }) },
  }

  // ---- Alvos aditivos ----------------------------------------------------------------------------------------
  if (on.send) {
    handlers.messages!.send = ([req]) => pipelineSend(req)
    handlers.messages!.sendGroup = ([raw]) => {
      const req = obj(raw, 'request')
      if (typeof req.groupId !== 'string' || !GROUP_JID.test(req.groupId))
        throw rejected('VALIDATION_ERROR', 'invalid group id')
      return pipelineSend({ ...req, phone: req.groupId })
    }
  }
  if (on.media) {
    handlers.media = {
      download: ([sessionId, ref]) => {
        sessionOf(str(sessionId, 'sessionId'))
        const handle = obj(ref, 'ref')
        str(handle.message_id, 'message_id')
        const blob = typeof handle.key === 'string' ? blobs.get(handle.key) : undefined
        if (!blob) throw new SimError('MediaError', 'media not found', { code: 'MEDIA_NOT_FOUND' })
        return {
          mime: blob.mime,
          size: blob.data.byteLength,
          sha256: null,
          key: handle.key,
          data: Buffer.from(blob.data).toString('base64'),
        }
      },
    }
  }
  if (on.presence) {
    handlers.presence = {
      update: ([sessionId, to, kind]) => {
        if (!PRESENCE.includes(String(kind))) throw validation('kind must be composing, recording or paused')
        const s = sessionOf(str(sessionId, 'sessionId'))
        const target = str(to, 'to')
        if (!connected(s)) throw notConnected()
        presences.push({ sessionId: s.view.id, to: target, kind: String(kind) })
        return null
      },
    }
  }
  if (on.contacts) {
    handlers.contacts = {
      recordConsent: ([raw]) => {
        const input = obj(raw, 'input')
        const phone = str(input.phone, 'phone')
        if (!E164.test(phone)) throw validation('phone must be E.164')
        str(input.source, 'source')
        const c = contacts.get(phone)
        contacts.set(phone, { consent: true, optOut: c?.optOut ?? false })
        return null
      },
      optOut: ([raw]) => {
        const phone = str(obj(raw, 'input').phone, 'phone')
        if (!E164.test(phone)) throw validation('phone must be E.164')
        contacts.set(phone, { consent: contacts.get(phone)?.consent ?? false, optOut: true })
        return null
      },
      // Agenda da sessão no formato WaContactSummary.
      list: ([sessionId]) => {
        const s = sessionOf(str(sessionId, 'sessionId'))
        if (!connected(s)) throw notConnected()
        return [
          {
            jid: '5511900000001@s.whatsapp.net',
            phone: '+5511900000001',
            lid: null,
            name: 'Contato simulado',
            pushName: null,
          },
        ]
      },
    }
  }

  const targets = Object.entries(handlers).flatMap(([t, ms]) => Object.keys(ms).map((m) => `${t}.${m}`))

  // ---- HTTP ----------------------------------------------------------------------------------------------
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const serialize = (err: unknown) => {
    if (err instanceof SimError) return { name: err.name, message: err.message, ...err.fields }
    if (err instanceof Error) return { name: err.name, message: err.message }
    return { name: 'Error', message: String(err) }
  }
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  }

  const fakeRoute = async (method: string, path: string, body: Record<string, unknown>): Promise<[number, unknown]> => {
    const m = /^\/internal\/fake\/sessions\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (!m) return [404, { error: { code: 'NOT_FOUND', message: `route not found: ${method} ${path}` } }]
    const s = sessions.get(decodeURIComponent(m[1]!))
    if (!s || !s.transport)
      return [
        404,
        { error: { name: 'Error', code: 'FAKE_TRANSPORT_NOT_FOUND', message: 'no fake transport for session' } },
      ]
    const action = `${method} ${m[2]}`
    if (action === 'GET state') return [200, { status: s.view.status }]
    if (action === 'POST qr') return [200, { ok: true }]
    if (action === 'POST open') {
      await setStatus(s, 'WARMING')
      await publish({
        v: WA_EVENT_VERSION,
        type: 'session.connection',
        session_id: s.view.id,
        at: now(),
        state: 'open',
      })
      return [200, { ok: true }]
    }
    if (action === 'POST receive') {
      if (typeof body.from !== 'string' || !body.from)
        return [400, { error: { name: 'SyntaxError', message: 'from is required' } }]
      const id = typeof body.id === 'string' && body.id ? body.id : `SIM-${randomUUID().slice(0, 12)}`
      await publish({
        v: WA_EVENT_VERSION,
        type: 'message.inbound',
        session_id: s.view.id,
        at: now(),
        message: {
          id,
          from: body.from,
          from_me: false,
          timestamp: Date.now(),
          type: 'conversation',
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
        },
      })
      return [200, { id }]
    }
    return [404, { error: { code: 'NOT_FOUND', message: `route not found: ${method} ${path}` } }]
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
      if (!path.startsWith('/internal/'))
        return send(res, 404, { error: { code: 'NOT_FOUND', message: `route not found: ${req.method} ${path}` } })
      if (!auth || auth[1]!.trim() !== opts.token)
        return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid internal token' } })
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch {
        return send(res, 400, { error: { name: 'SyntaxError', message: 'malformed JSON' } })
      }
      if (path.startsWith('/internal/fake/')) {
        const [status, out] = await fakeRoute(req.method ?? 'GET', path, body)
        return send(res, status, out)
      }
      if (path !== '/internal/rpc' || req.method !== 'POST')
        return send(res, 404, { error: { code: 'NOT_FOUND', message: `route not found: ${req.method} ${path}` } })
      const target = String(body.target)
      const method = String(body.method)
      const args = Array.isArray(body.args) ? (body.args as unknown[]) : []
      calls.push({ target, method, args })
      const fn =
        Object.hasOwn(handlers, target) && Object.hasOwn(handlers[target]!, method)
          ? handlers[target]![method]
          : undefined
      if (!fn)
        return send(res, 400, {
          error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: `unknown method ${target}.${method}` },
        })
      try {
        const result = await fn(args)
        return send(res, 200, { result: result ?? null })
      } catch (err) {
        return send(res, 200, { error: serialize(err) })
      }
    })().catch((err: unknown) => send(res, 500, { error: serialize(err) }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    targets,
    presences,
    blobStore: {
      async put(data, mime) {
        const key = `sim/${randomUUID()}`
        blobs.set(key, { data: new Uint8Array(data), mime })
        return { key, size: data.byteLength, sha256: null }
      },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

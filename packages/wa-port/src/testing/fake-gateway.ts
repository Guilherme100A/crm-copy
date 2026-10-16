// FakeWaGateway (SPEC 3.10): WaGateway em memória para testes e E2E. Simula os gates do SendPipeline do
// ai-manager (auth → sessionExists → connected → contactAllowed) e registra tudo o que o CRM pediu.
import {
  CANCELLABLE_STATUSES,
  defaultCapabilities,
  SENDABLE_STATES,
  type CreateSessionInput,
  type DeleteForEveryoneRequest,
  type GroupSummary,
  type MessageStatus,
  type MessageView,
  type OptOutInput,
  type PresenceKind,
  type ReactRequest,
  type RecordConsentInput,
  type SendGroupRequest,
  type SendRequest,
  type SessionState,
  type SessionView,
  type WaCapabilities,
  type WaContactSummary,
  type WaEventListener,
  type WaGateway,
  type WaProfile,
  type WaProfileControl,
  type WaSessionsControl,
} from '../gateway'
import { parseWaEvent, WA_EVENT_VERSION, type MediaHandle, type WaEvent } from '../events'
import { SendRejectedError, WaGatewayError, type SendRejectionCode } from '../errors'

/** Bytes devolvidos por `downloadMedia` quando nenhuma mídia foi registrada para a mensagem. */
export const FAKE_MEDIA_FIXTURE: Uint8Array = new TextEncoder().encode('fake-media')
/** Código devolvido por `requestPairingCode`. */
export const FAKE_PAIRING_CODE = 'FAKE1234'
/** QR devolvido por `startQr`/`getQr` (data URL PNG 1×1). */
export const FAKE_QR_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** Um envio registrado: a requisição como chegou + a mensagem `queued` devolvida. */
export type FakeSentMessage = SendRequest & { messageId: string; message: MessageView }

export interface FakeSessionSeed {
  id?: string
  name?: string
  phone?: string | null
  /** Default `STABLE` (pronta para enviar). */
  state?: SessionState
}

export interface FakeWaGatewayOptions {
  capabilities?: Partial<WaCapabilities>
  /** Sessões iniciais. */
  sessions?: FakeSessionSeed[]
  /** Bytes padrão de `downloadMedia`. Default FAKE_MEDIA_FIXTURE. */
  mediaFixture?: Uint8Array
  /** Exigir consentimento registrado (como o gate do ai-manager). Default false: só o opt-out bloqueia. */
  requireConsent?: boolean
  /**
   * Sessão `NEW` (recém-criada, sem QR) conecta sozinha (`WARMING`, emitindo `session.state`) no primeiro envio,
   * para testes que não simulam o pareamento. PAUSED/DISCONNECTED continuam rejeitando. Default true.
   */
  autoConnect?: boolean
  /** Validar cada evento com parseWaEvent em `emit`. Default true. */
  validateEvents?: boolean
  now?: () => Date
}

interface PendingFailure {
  code: SendRejectionCode
  message?: string
  details?: Record<string, unknown>
}

const GROUP_JID = /^[^\s@]+@g\.us$/

export class FakeWaGateway implements WaGateway {
  readonly capabilities: WaCapabilities
  readonly sessions: WaSessionsControl
  readonly profile: WaProfileControl

  /** Todo envio aceito (send, sendGroup, react, deleteForEveryone), em ordem. */
  readonly sent: FakeSentMessage[] = []
  /** Todo evento entregue por `emit`, em ordem. */
  readonly emitted: WaEvent[] = []
  readonly consents: RecordConsentInput[] = []
  readonly optOuts: OptOutInput[] = []
  readonly presences: { sessionId: string; to: string; kind: PresenceKind }[] = []
  readonly cancelled: string[] = []

  private readonly sessionMap = new Map<string, SessionView>()
  private readonly qrs = new Map<string, { qr: string; generatedAt: string }>()
  private readonly messages = new Map<string, MessageView>()
  private readonly groups = new Map<string, GroupSummary[]>()
  private readonly contacts = new Map<string, WaContactSummary[]>()
  private readonly media = new Map<string, Uint8Array>()
  private readonly profiles = new Map<string, WaProfile>()
  private readonly consented = new Set<string>()
  private readonly optedOut = new Set<string>()
  private readonly listeners = new Set<WaEventListener>()
  private readonly failures: PendingFailure[] = []
  private readonly mediaFixture: Uint8Array
  private readonly requireConsent: boolean
  private readonly validateEvents: boolean
  private readonly autoConnect: boolean
  private readonly now: () => Date
  private seq = 0

  constructor(opts: FakeWaGatewayOptions = {}) {
    this.capabilities = { ...defaultCapabilities(), ...opts.capabilities }
    this.mediaFixture = opts.mediaFixture ?? FAKE_MEDIA_FIXTURE
    this.requireConsent = opts.requireConsent ?? false
    this.validateEvents = opts.validateEvents ?? true
    this.autoConnect = opts.autoConnect ?? true
    this.now = opts.now ?? (() => new Date())
    for (const seed of opts.sessions ?? []) this.addSession(seed)
    this.sessions = this.createSessionsControl()
    this.profile = this.createProfileControl()
  }

  // ------------------------------------------------------------ controles de teste

  /** Faz o próximo envio (send/sendGroup/react/deleteForEveryone) rejeitar com o código dado. Acumula em fila. */
  failNext(code: SendRejectionCode, message?: string, details?: Record<string, unknown>): this {
    const failure: PendingFailure = { code }
    if (message !== undefined) failure.message = message
    if (details !== undefined) failure.details = details
    this.failures.push(failure)
    return this
  }

  /** Entrega o evento a todos os assinantes (em ordem de assinatura), aguardando cada um. */
  async emit(event: WaEvent): Promise<void> {
    const value = this.validateEvents ? parseWaEvent(event) : event
    this.emitted.push(value)
    for (const listener of [...this.listeners]) await listener(value)
  }

  /** Cria uma sessão simulada sem passar pelo QR. Default: `STABLE`. */
  addSession(seed: FakeSessionSeed = {}): SessionView {
    const at = this.iso()
    const state = seed.state ?? 'STABLE'
    const view: SessionView = {
      id: seed.id ?? this.nextId('session'),
      name: seed.name ?? 'Fake session',
      phone: seed.phone ?? null,
      status: state,
      state,
      proxyId: null,
      note: null,
      requiresRestart: false,
      warmupStartedAt: state === 'NEW' || state === 'DISCONNECTED' ? null : at,
      lastConnectedAt: state === 'NEW' || state === 'DISCONNECTED' ? null : at,
      createdAt: at,
      updatedAt: at,
    }
    this.sessionMap.set(view.id, view)
    return { ...view }
  }

  /** Muda o estado da sessão e emite `session.state` (e `session.connection` ao abrir/fechar). */
  async setSessionState(sessionId: string, to: SessionState): Promise<SessionView> {
    const session = this.requireSession(sessionId)
    const from = session.status
    if (from === to) return { ...session }
    this.applyState(session, to)
    await this.emit({ v: WA_EVENT_VERSION, type: 'session.state', session_id: sessionId, at: this.iso(), from, to })
    const wasOpen = from !== 'NEW' && from !== 'DISCONNECTED'
    const isOpen = to !== 'NEW' && to !== 'DISCONNECTED'
    if (wasOpen !== isOpen) {
      await this.emit({ v: WA_EVENT_VERSION, type: 'session.connection', session_id: sessionId, at: this.iso(), state: isOpen ? 'open' : 'close' })
    }
    return { ...session }
  }

  /** Conecta a sessão (default `WARMING`, como após o primeiro QR). */
  connect(sessionId: string, state: SessionState = 'WARMING'): Promise<SessionView> {
    return this.setSessionState(sessionId, state)
  }

  /** Avança o status de uma mensagem e emite `message.status`. */
  async setMessageStatus(messageId: string, status: MessageStatus, opts: { transportMessageId?: string; error?: string } = {}): Promise<MessageView> {
    const message = this.requireMessage(messageId)
    const at = this.iso()
    message.status = status
    message.updatedAt = at
    if (opts.transportMessageId !== undefined) message.transportMessageId = opts.transportMessageId
    if (status === 'sent' && !message.transportMessageId) message.transportMessageId = this.nextId('wamid')
    if (status === 'sent') message.sentAt ??= at
    if (status === 'delivered') message.deliveredAt ??= at
    if (status === 'read') message.readAt ??= at
    if (opts.error !== undefined) message.lastError = opts.error
    const event: WaEvent = {
      v: WA_EVENT_VERSION,
      type: 'message.status',
      session_id: message.sessionId,
      at,
      message_id: message.id,
      transport_message_id: message.transportMessageId,
      status,
    }
    if (opts.error !== undefined) event.error = opts.error
    await this.emit(event)
    return { ...message }
  }

  setGroups(sessionId: string, groups: GroupSummary[]): this {
    this.groups.set(sessionId, groups.map((g) => ({ ...g })))
    return this
  }

  setContacts(sessionId: string, contacts: WaContactSummary[]): this {
    this.contacts.set(sessionId, contacts.map((c) => ({ ...c })))
    return this
  }

  /** Bytes que `downloadMedia` devolve para a mensagem. */
  setMedia(messageId: string, bytes: Uint8Array): this {
    this.media.set(messageId, bytes)
    return this
  }

  isOptedOut(phone: string): boolean {
    return this.optedOut.has(phone)
  }

  hasConsent(phone: string): boolean {
    return this.consented.has(phone)
  }

  getMessage(messageId: string): MessageView | undefined {
    const message = this.messages.get(messageId)
    return message ? { ...message } : undefined
  }

  listenerCount(): number {
    return this.listeners.size
  }

  /** Limpa registros, falhas pendentes e estado (mantém assinantes). */
  reset(): void {
    this.sent.length = 0
    this.emitted.length = 0
    this.consents.length = 0
    this.optOuts.length = 0
    this.presences.length = 0
    this.cancelled.length = 0
    this.failures.length = 0
    for (const map of [this.sessionMap, this.qrs, this.messages, this.groups, this.contacts, this.media, this.profiles]) map.clear()
    this.consented.clear()
    this.optedOut.clear()
  }

  // ------------------------------------------------------------ WaGateway

  subscribe(listener: WaEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Alias de `subscribe`. */
  onEvent(listener: WaEventListener): () => void {
    return this.subscribe(listener)
  }

  /** Alias de `subscribe`. */
  on(listener: WaEventListener): () => void {
    return this.subscribe(listener)
  }

  async send(req: SendRequest): Promise<MessageView> {
    this.throwPendingFailure()
    if (!req.actor || !req.actor.trim()) throw new SendRejectedError('UNAUTHORIZED', 'authenticated actor required')
    const session = this.sessionMap.get(req.sessionId)
    if (!session) throw new SendRejectedError('SESSION_NOT_FOUND', `session ${req.sessionId} not found`)
    if (this.autoConnect && session.status === 'NEW') await this.setSessionState(session.id, 'WARMING')
    if (!SENDABLE_STATES.includes(session.status)) {
      throw new SendRejectedError('SESSION_NOT_CONNECTED', `session ${req.sessionId} is ${session.status}`, { state: session.status })
    }
    if (req.groupId) {
      if (req.phone !== req.groupId || !GROUP_JID.test(req.groupId) || req.contactId) throw new SendRejectedError('VALIDATION_ERROR', 'invalid group recipient')
      const group = this.groups.get(req.sessionId)?.find((g) => g.id === req.groupId)
      if (!group || (group.announce && !group.isAdmin)) throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'not a member or group only allows admins to send')
    } else {
      if (this.optedOut.has(req.phone)) throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'contact not allowed: opted_out', { reason: 'opted_out' })
      if (this.requireConsent && !this.consented.has(req.phone)) {
        throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'contact not allowed: no_consent', { reason: 'no_consent' })
      }
    }
    const at = this.iso()
    const message: MessageView = {
      id: this.nextId('msg'),
      sessionId: req.sessionId,
      contactId: req.contactId ?? null,
      phone: req.phone,
      content: structuredClone(req.content),
      status: 'queued',
      attempts: 0,
      lastError: null,
      transportMessageId: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      createdAt: at,
      updatedAt: at,
    }
    this.messages.set(message.id, message)
    this.sent.push({ ...structuredClone(req), messageId: message.id, message: { ...message } })
    return { ...message }
  }

  async sendGroup(req: SendGroupRequest): Promise<MessageView> {
    if (!GROUP_JID.test(req.groupId)) {
      this.throwPendingFailure()
      throw new SendRejectedError('VALIDATION_ERROR', 'invalid group id')
    }
    return this.send({ ...req, phone: req.groupId })
  }

  async react(req: ReactRequest): Promise<MessageView> {
    return this.send({ sessionId: req.sessionId, phone: req.phone, actor: req.actor, content: { react: { messageId: req.messageId, emoji: req.emoji } } })
  }

  async deleteForEveryone(req: DeleteForEveryoneRequest): Promise<MessageView> {
    return this.send({ sessionId: req.sessionId, phone: req.phone, actor: req.actor, content: { delete: { messageId: req.messageId } } })
  }

  async cancel(messageId: string): Promise<MessageView> {
    const message = this.requireMessage(messageId)
    if (!CANCELLABLE_STATUSES.includes(message.status)) {
      throw new WaGatewayError('INVALID_TRANSITION', `invalid message transition: ${message.status} → cancelled`, { from: message.status, to: 'cancelled' })
    }
    message.status = 'cancelled'
    message.updatedAt = this.iso()
    this.cancelled.push(messageId)
    return { ...message }
  }

  async fetchGroups(sessionId: string): Promise<GroupSummary[]> {
    this.requireSession(sessionId)
    return (this.groups.get(sessionId) ?? []).map((g) => ({ ...g }))
  }

  async downloadMedia(sessionId: string, ref: MediaHandle): Promise<Uint8Array> {
    this.requireSession(sessionId)
    if (ref.session_id !== sessionId) throw new WaGatewayError('MEDIA_NOT_FOUND', `media of message ${ref.message_id} does not belong to session ${sessionId}`)
    return new Uint8Array(this.media.get(ref.message_id) ?? this.mediaFixture)
  }

  async presence(sessionId: string, to: string, kind: PresenceKind): Promise<void> {
    this.requireSession(sessionId)
    this.presences.push({ sessionId, to, kind })
  }

  async listContacts(sessionId: string): Promise<WaContactSummary[]> {
    this.requireSession(sessionId)
    return (this.contacts.get(sessionId) ?? []).map((c) => ({ ...c }))
  }

  /** Registra o consentimento. Só um consentimento `manual` reverte um opt-out (SPEC T33-07). */
  async recordConsent(input: RecordConsentInput): Promise<void> {
    this.consents.push({ ...input })
    this.consented.add(input.phone)
    if (input.source === 'manual') this.optedOut.delete(input.phone)
  }

  async optOut(input: OptOutInput): Promise<void> {
    this.optOuts.push({ ...input })
    this.optedOut.add(input.phone)
  }

  // ------------------------------------------------------------ internos

  private createSessionsControl(): WaSessionsControl {
    const view = (s: SessionView) => ({ ...s })
    return {
      create: async (input: CreateSessionInput) => {
        if (input.proxy && input.proxyId) throw new SendRejectedError('VALIDATION_ERROR', 'use either proxy or proxyId, not both')
        const session = this.addSession({ name: input.name, phone: input.phone ?? null, state: 'NEW' })
        const stored = this.requireSession(session.id)
        stored.note = input.note ?? null
        stored.proxyId = input.proxyId ?? (input.proxy ? this.nextId('proxy') : null)
        return view(stored)
      },
      list: async () => [...this.sessionMap.values()].map(view),
      get: async (id: string) => view(this.requireSession(id)),
      startQr: async (id: string) => {
        const session = this.requireSession(id)
        const generatedAt = this.iso()
        this.qrs.set(id, { qr: FAKE_QR_DATA_URL, generatedAt })
        await this.emit({ v: WA_EVENT_VERSION, type: 'session.qr', session_id: id, at: generatedAt, qr: FAKE_QR_DATA_URL })
        return view(session)
      },
      getQr: async (id: string) => {
        this.requireSession(id)
        const qr = this.qrs.get(id)
        return { qr: qr?.qr ?? null, generatedAt: qr?.generatedAt ?? null }
      },
      requestPairingCode: async (id: string, phone?: string) => {
        const session = this.requireSession(id)
        const target = phone ?? session.phone
        if (!target) throw new SendRejectedError('VALIDATION_ERROR', 'pairing code requires a phone number')
        if (phone) session.phone = phone
        await this.emit({ v: WA_EVENT_VERSION, type: 'session.pairing_code', session_id: id, at: this.iso(), code: FAKE_PAIRING_CODE })
        return { code: FAKE_PAIRING_CODE }
      },
      pause: async (id: string) => {
        const session = this.requireSession(id)
        if (!['WARMING', 'STABLE', 'DEGRADED'].includes(session.status)) {
          throw new WaGatewayError('INVALID_TRANSITION', `invalid session transition: ${session.status} → PAUSED`)
        }
        return this.setSessionState(id, 'PAUSED')
      },
      resume: async (id: string) => {
        const session = this.requireSession(id)
        if (session.status !== 'PAUSED') throw new WaGatewayError('INVALID_TRANSITION', `invalid session transition: ${session.status} → resume`)
        return this.setSessionState(id, 'WARMING')
      },
      restart: async (id: string) => view(this.requireSession(id)),
      logout: async (id: string) => {
        this.requireSession(id)
        this.qrs.delete(id)
        return this.setSessionState(id, 'DISCONNECTED')
      },
      remove: async (id: string) => {
        const session = this.requireSession(id)
        this.sessionMap.delete(id)
        this.qrs.delete(id)
        return { deletedProxyId: session.proxyId }
      },
    }
  }

  private createProfileControl(): WaProfileControl {
    const profileOf = (sessionId: string): WaProfile => {
      this.requireSession(sessionId)
      let profile = this.profiles.get(sessionId)
      if (!profile) {
        profile = { name: null, status: null, pictureUrl: null }
        this.profiles.set(sessionId, profile)
      }
      return profile
    }
    return {
      get: async (sessionId) => ({ ...profileOf(sessionId) }),
      setName: async (sessionId, name) => {
        profileOf(sessionId).name = name
      },
      setStatus: async (sessionId, status) => {
        profileOf(sessionId).status = status
      },
      setPicture: async (sessionId, picture) => {
        profileOf(sessionId).pictureUrl = picture.url
      },
    }
  }

  private throwPendingFailure(): void {
    const failure = this.failures.shift()
    if (failure) throw new SendRejectedError(failure.code, failure.message ?? `fake rejection: ${failure.code}`, failure.details)
  }

  private applyState(session: SessionView, to: SessionState): void {
    const at = this.iso()
    session.status = to
    session.state = to
    session.updatedAt = at
    if (to === 'WARMING' || to === 'STABLE') {
      session.lastConnectedAt = at
      session.warmupStartedAt ??= at
    }
  }

  private requireSession(id: string): SessionView {
    const session = this.sessionMap.get(id)
    if (!session) throw new WaGatewayError('SESSION_NOT_FOUND', `session ${id} not found`)
    return session
  }

  private requireMessage(id: string): MessageView {
    const message = this.messages.get(id)
    if (!message) throw new WaGatewayError('MESSAGE_NOT_FOUND', `message ${id} not found`)
    return message
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `fake-${prefix}-${this.seq}-${globalThis.crypto.randomUUID().slice(0, 8)}`
  }

  private iso(): string {
    return this.now().toISOString()
  }
}

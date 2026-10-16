// BaileysTransport: adaptador do @whiskeysockets/baileys 7.0.0-rc14 para WaTransport (fork do ai-manager).
// O socket é criado por uma factory injetável, para testes sem rede (`BaileysSocketLike`).
import type { UserFacingSocketConfig } from '@whiskeysockets/baileys'
import { TransportEmitter } from './emitter'
import { browserForSession } from './fingerprint'
import {
  isLidJid,
  messageExpiration,
  normalizeJid,
  phoneFromUserJid,
  toIncomingMessage,
  toLidMapping,
  toWaContact,
  type RawContact,
  type RawMessage,
} from './message'
import { createProxyAgent } from './proxy-agent'
import {
  MediaUnavailableError,
  TransportNotConnectedError,
  type ConnectOptions,
  type DisconnectKind,
  type GroupParticipantResult,
  type GroupParticipantStatus,
  type GroupSummary,
  type HistoryBatch,
  type IncomingMessage,
  type LidMapping,
  type OutgoingContent,
  type PresenceState,
  type SendOptions,
  type WaContact,
  type WaMessageKey,
  type WaTransport,
} from './types'

/** Códigos do `DisconnectReason` do Baileys usados no mapeamento. */
export const BAILEYS_DISCONNECT = { loggedOut: 401, forbidden: 403, restartRequired: 515 } as const

/** Status de `proto.WebMessageInfo.Status` usados nos recibos. */
const MESSAGE_STATUS = { DELIVERY_ACK: 3, READ: 4, PLAYED: 5 } as const

/** Mimetype obrigatório da nota de voz (PTT). */
export const PTT_MIMETYPE = 'audio/ogg; codecs=opus'

/** 401 → loggedOut, 403 → forbidden, o resto (inclusive 515 restartRequired) → transient. */
export function mapDisconnectReason(statusCode: number | undefined): DisconnectKind {
  if (statusCode === BAILEYS_DISCONNECT.loggedOut) return 'loggedOut'
  if (statusCode === BAILEYS_DISCONNECT.forbidden) return 'forbidden'
  return 'transient'
}

/** statusCode de um erro Boom (`error.output.statusCode`) do Baileys. */
export function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const output = (error as { output?: { statusCode?: unknown } }).output
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined
}

type EventHandler = (payload: unknown) => void

export interface BinaryNodeLike {
  tag: string
  attrs: Record<string, string>
  content?: unknown
}

/** Ack de uma stanza no formato do WhatsApp Web (`<ack id to class [type] [participant]>`). */
export function ackFor(node: BinaryNodeLike): BinaryNodeLike {
  const attrs: Record<string, string> = { id: node.attrs.id ?? '', to: node.attrs.from ?? '', class: node.tag }
  if (node.attrs.type) attrs.type = node.attrs.type
  if (node.attrs.participant) attrs.participant = node.attrs.participant
  return { tag: 'ack', attrs }
}

/** Subconjunto do socket do Baileys usado pelo transporte (facilita mocks). Só `ev` e `sendMessage` são obrigatórios. */
export interface BaileysSocketLike {
  ev: { on(event: string, listener: EventHandler): unknown }
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    options?: { ephemeralExpiration?: number; quoted?: unknown },
  ): Promise<{ key?: WaMessageKey | null; message?: Record<string, unknown> | null } | undefined>
  end?(error: Error | undefined): void | Promise<void>
  logout?(msg?: string): Promise<void>
  requestPairingCode?(phoneNumber: string): Promise<string>
  groupFetchAllParticipating?(): Promise<Record<string, BaileysGroupLike>>
  groupParticipantsUpdate?(jid: string, participants: string[], action: 'add'): Promise<Array<{ status?: string; jid?: string }>>
  groupInviteCode?(jid: string): Promise<string | undefined>
  sendPresenceUpdate?(type: PresenceState, jid?: string): Promise<void>
  readMessages?(keys: WaMessageKey[]): Promise<void>
  updateMediaMessage?(message: unknown): Promise<unknown>
  fetchMessageHistory?(count: number, oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string }, oldestMsgTimestamp: number): Promise<string>
  addOrEditContact?(jid: string, contact: { fullName?: string | null; firstName?: string | null }): Promise<void>
  /** WebSocket do Baileys: emite `CB:<tag>` para cada stanza recebida. */
  ws?: { on(event: string, listener: (node: BinaryNodeLike) => void): unknown }
  sendNode?(node: BinaryNodeLike): Promise<void>
  user?: { id?: string; lid?: string } | null
}

export interface BaileysGroupLike {
  id: string
  subject?: string
  size?: number
  participants?: unknown[]
  announce?: boolean
  linkedParent?: string
}

interface GroupParticipantLike {
  id?: string
  lid?: string
  phoneNumber?: string
  admin?: 'admin' | 'superadmin' | null
  isAdmin?: boolean
  isSuperAdmin?: boolean
}

export type BaileysSocketConfig = UserFacingSocketConfig
export type BaileysSocketFactory = (config: BaileysSocketConfig) => BaileysSocketLike

/** Guarda, por conversa (JID), o tempo das mensagens temporárias em segundos (0 = desligado). */
export interface DisappearingStore {
  load(): Promise<Record<string, number>>
  save(jid: string, seconds: number): Promise<void>
}

/** Logger compatível com o `ILogger` do Baileys (pino 9 serve). */
export interface BaileysLogger {
  level: string
  child(obj: Record<string, unknown>): BaileysLogger
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const noop = () => undefined
export const silentLogger: BaileysLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

export interface BaileysTransportOptions {
  /** Factory do socket; padrão: `makeWASocket` do Baileys (carregado sob demanda, com `makeCacheableSignalKeyStore`). */
  makeSocket?: BaileysSocketFactory
  /** Opções extras do `makeWASocket`. `markOnlineOnConnect` é sempre `false`. */
  socketConfig?: Partial<Omit<BaileysSocketConfig, 'auth' | 'agent' | 'fetchAgent' | 'getMessage' | 'cachedGroupMetadata'>>
  logger?: BaileysLogger
  /** Store de mensagens (Postgres): usado no `getMessage` (retry de decifragem e enquetes) e no download de mídia antiga. */
  messageStore?: {
    get(key: WaMessageKey): Promise<RawMessage | undefined>
  }
  /** Persistência dos tempos de mensagens temporárias. Sem ela, só em memória. */
  disappearing?: DisappearingStore
  /** Baixa a mídia de uma WAMessage; padrão: `downloadMediaMessage` com `reuploadRequest`. */
  downloadMedia?: (raw: RawMessage, sock: BaileysSocketLike) => Promise<Uint8Array>
  /** Quantas mensagens (recebidas e enviadas) ficam em memória para `getMessage`/`downloadMedia`. */
  messageCacheSize?: number
  /** Validade da lista de grupos em cache (padrão GROUPS_CACHE_MS). */
  groupsCacheMs?: number
  now?: () => number
}

/** `groupFetchAllParticipating` dá rate-overlimit se chamado com frequência: a lista fica em cache. */
export const GROUPS_CACHE_MS = 5 * 60_000
/** Com a lista "velha" ou depois de um rate-overlimit, consulta de novo no máximo a cada 2 min. */
export const GROUPS_MIN_REFETCH_MS = 2 * 60_000
/** Intervalo mínimo entre duas conferências da mesma conversa no celular. */
export const CHAT_CHECK_INTERVAL = 6 * 3_600_000
/** Quanto esperar a resposta do celular numa conferência. */
export const CHAT_CHECK_WAIT = 8_000
export const MESSAGE_CACHE_SIZE = 2_000

interface ChatEphemeralLike {
  id?: string | null
  pnJid?: string | null
  lidJid?: string | null
  ephemeralExpiration?: number | null
}

interface BaileysModule {
  makeWASocket: BaileysSocketFactory
  makeCacheableSignalKeyStore: (store: unknown, logger?: unknown) => unknown
  downloadMediaMessage: (msg: unknown, type: 'buffer', options: object, ctx?: object) => Promise<Buffer>
}

const loadBaileys = async (): Promise<BaileysModule> => (await import('@whiskeysockets/baileys')) as unknown as BaileysModule

/**
 * Marca de key store que já tem cache em memória (T117). `Symbol.for` com a mesma chave no `auth-state` (T06),
 * que marca o store sem importar o transporte (sem ciclo).
 */
export const CACHEABLE_KEY_STORE = Symbol.for('crm.wa-engine.cacheable-key-store')

export function markCacheableKeyStore<T extends object>(keys: T): T {
  Object.defineProperty(keys, CACHEABLE_KEY_STORE, { value: true, enumerable: false, configurable: true })
  return keys
}

export function isCacheableKeyStore(keys: unknown): boolean {
  return typeof keys === 'object' && keys !== null && (keys as Record<symbol, unknown>)[CACHEABLE_KEY_STORE] === true
}

/** Um único cache por sessão: envolve com `wrap` (o `makeCacheableSignalKeyStore`) só se o store ainda não tem cache. */
export function withKeyCache<K extends object>(keys: K, wrap: (keys: K) => unknown): K {
  return isCacheableKeyStore(keys) ? keys : markCacheableKeyStore(wrap(keys) as K)
}

/** A conta (ids próprios) é admin/superadmin do grupo? */
export function isGroupAdmin(participants: unknown[] | undefined, ownIds: ReadonlySet<string>): boolean {
  if (!participants || ownIds.size === 0) return false
  return participants.some((raw) => {
    const p = raw as GroupParticipantLike
    const ids = [p.id, p.lid, p.phoneNumber].filter((v): v is string => typeof v === 'string').map(normalizeJid)
    if (!ids.some((id) => ownIds.has(id))) return false
    return p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true
  })
}

function toGroupSummary(g: BaileysGroupLike, ownIds: ReadonlySet<string> = new Set()): GroupSummary {
  const summary: GroupSummary = {
    id: g.id,
    name: g.subject ?? '',
    participants: g.size ?? g.participants?.length ?? 0,
    announce: g.announce === true,
    isAdmin: isGroupAdmin(g.participants, ownIds),
  }
  if (g.linkedParent) summary.communityId = g.linkedParent
  return summary
}

/** Código do Baileys por participante → status normalizado. */
export function mapParticipantStatus(code: number | undefined): GroupParticipantStatus {
  if (code === 200) return 'added'
  if (code === 409) return 'already_member'
  if (code === 403) return 'not_allowed'
  if (code === 404) return 'group_not_found'
  return 'failed'
}

/** Erro do grupo inteiro → status normalizado. */
export function mapGroupErrorStatus(code: number | undefined): GroupParticipantStatus {
  if (code === 404) return 'group_not_found'
  if (code === 401 || code === 403) return 'not_admin'
  return 'failed'
}

function numericData(err: unknown): number | undefined {
  const data = (err as { data?: unknown } | null)?.data
  if (typeof data === 'number') return data
  const n = Number((data as { code?: unknown } | null | undefined)?.code)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const mediaInput = (ref: { url: string } | { data: Uint8Array }) => ('data' in ref ? Buffer.from(ref.data) : { url: ref.url })

/** OutgoingContent → conteúdo do `sock.sendMessage`. PTT sempre com `audio/ogg; codecs=opus`. */
export function toBaileysContent(content: OutgoingContent): Record<string, unknown> {
  if ('text' in content) return { text: content.text }
  if ('image' in content) return { ...content, image: mediaInput(content.image) }
  if ('video' in content) return { ...content, video: mediaInput(content.video) }
  if ('audio' in content) {
    const out: Record<string, unknown> = { ...content, audio: mediaInput(content.audio) }
    if (content.ptt) out.mimetype = PTT_MIMETYPE
    return out
  }
  if ('document' in content) return { ...content, document: mediaInput(content.document) }
  return { sticker: mediaInput(content.sticker) }
}

/** Mapa com limite de tamanho (descarta o mais antigo). */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super()
  }

  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key)
    super.set(key, value)
    while (this.size > this.max) this.delete(this.keys().next().value as K)
    return this
  }
}

export class BaileysTransport extends TransportEmitter implements WaTransport {
  private sock: BaileysSocketLike | undefined
  private connected = false
  private readonly ephemeral = new Map<string, number>()
  private ephemeralLoad?: Promise<void>
  private readonly lastKey = new Map<string, { id: string; fromMe: boolean; at: number }>()
  private readonly checkedAt = new Map<string, number>()
  private readonly chatAnswer = new Map<string, () => void>()
  /** Mensagens recentes (recebidas e enviadas) por id: `getMessage` e `downloadMedia`. */
  private readonly messages: BoundedMap<string, RawMessage>
  private readonly contacts = new Map<string, WaContact>()
  /** Metadados de grupo para o `cachedGroupMetadata` (evita `groupMetadata` a cada envio em grupo). */
  private readonly groupMeta = new Map<string, BaileysGroupLike>()
  private groupsCache: { at: number; groups: GroupSummary[]; stale: boolean; force: boolean; retryAfter: number } | undefined
  private groupsInFlight: Promise<GroupSummary[]> | undefined

  constructor(private readonly options: BaileysTransportOptions = {}) {
    super()
    this.messages = new BoundedMap(options.messageCacheSize ?? MESSAGE_CACHE_SIZE)
  }

  get isConnected(): boolean {
    return this.connected
  }

  private get logger(): BaileysLogger {
    return this.options.logger ?? silentLogger
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now()
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.sock) await this.close()
    this.ephemeralLoad ??= (async () => {
      const saved = (await this.options.disappearing?.load()) ?? {}
      for (const [jid, seconds] of Object.entries(saved)) if (seconds > 0 && !this.ephemeral.has(jid)) this.ephemeral.set(jid, seconds)
    })().catch((err) => {
      this.ephemeralLoad = undefined
      this.onListenerError(err, 'internal')
    })

    let factory = this.options.makeSocket
    let auth = opts.auth
    if (!factory) {
      const mod = await loadBaileys()
      factory = mod.makeWASocket
      // Cache em memória na frente do key store do Postgres (STACK C.2), sem reaplicar se o auth state já tem (T06).
      auth = { creds: opts.auth.creds, keys: withKeyCache(opts.auth.keys, (k) => mod.makeCacheableSignalKeyStore(k, this.logger)) }
    }

    const config = {
      logger: this.logger,
      ...this.options.socketConfig,
      auth,
      browser: opts.browser ?? browserForSession(opts.sessionId),
      // README: com `true` o celular para de receber notificações enquanto o CRM está conectado.
      markOnlineOnConnect: false,
      getMessage: async (key: WaMessageKey) => (await this.findMessage(key))?.message ?? undefined,
      cachedGroupMetadata: async (jid: string) => this.groupMeta.get(jid),
    } as BaileysSocketConfig
    if (opts.proxyUrl) {
      const agent = createProxyAgent(opts.proxyUrl)
      config.agent = agent
      config.fetchAgent = agent
    }

    const sock = factory(config)
    this.sock = sock
    this.connected = false
    this.invalidateGroups()
    let pairingRequested = false

    // Eventos de um socket substituído/encerrado são ignorados.
    const guard =
      <T>(fn: (payload: T) => void | Promise<void>): EventHandler =>
      (payload) => {
        if (this.sock !== sock) return
        void Promise.resolve()
          .then(() => fn(payload as T))
          .catch((err) => this.onListenerError(err, 'internal'))
      }

    sock.ev.on(
      'connection.update',
      guard<{ connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }>(async (u) => {
        if (u.qr) {
          if (opts.pairingPhone && !opts.auth.creds.registered) {
            if (!pairingRequested && sock.requestPairingCode) {
              pairingRequested = true
              const code = await sock.requestPairingCode(opts.pairingPhone.replace(/\D/g, ''))
              if (this.sock === sock) this.emit('pairing-code', code)
            }
          } else this.emit('qr', u.qr)
        }
        if (u.connection === 'open') {
          this.connected = true
          this.emit('connection', { state: 'open' })
        } else if (u.connection === 'close') {
          this.connected = false
          this.sock = undefined
          const statusCode = disconnectStatusCode(u.lastDisconnect?.error)
          const reason = mapDisconnectReason(statusCode)
          this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
        }
      }),
    )

    if (opts.saveCreds) {
      const save = opts.saveCreds
      sock.ev.on('creds.update', guard(() => save()))
    }

    sock.ev.on(
      'messages.upsert',
      guard<{ messages?: RawMessage[]; type?: string }>((u) => {
        const historical = u.type !== 'notify'
        for (const raw of u.messages ?? []) {
          if (raw.key?.id && raw.message) this.messages.set(raw.key.id, raw)
          const at = this.timestampOf(raw)
          this.rememberKey(raw.key?.remoteJidAlt, raw.key?.id, raw.key?.fromMe === true, at)
          this.rememberKey(raw.key?.remoteJid, raw.key?.id, raw.key?.fromMe === true, at)
          const expiration = messageExpiration(raw.message)
          if (expiration) this.rememberEphemeral([raw.key?.remoteJid, raw.key?.remoteJidAlt], expiration)
          // notify = ao vivo (entra na inbox, dispara automações); append = sincronizada: só gravar.
          const msg = toIncomingMessage(raw, { historical, now: () => this.clock() })
          if (msg) this.emit('message', msg)
        }
      }),
    )

    sock.ev.on(
      'messages.update',
      guard<Array<{ key?: WaMessageKey; update?: { status?: number | null } }>>((updates) => {
        for (const { key, update } of updates ?? []) {
          if (!key?.id || !key.fromMe) continue
          const s = update?.status
          if (s === MESSAGE_STATUS.DELIVERY_ACK) this.emit('receipt', { messageId: key.id, status: 'delivered' })
          else if (s === MESSAGE_STATUS.READ || s === MESSAGE_STATUS.PLAYED) this.emit('receipt', { messageId: key.id, status: 'read' })
        }
      }),
    )

    // O servidor entrega stanzas <status> e espera ack; o rc14 não as confirma e a conexão cai (stream:error 500)
    // a cada ~50 min. Confirmamos como o WhatsApp Web faz (ack de stanza, não de mensagem).
    sock.ws?.on(
      'CB:status',
      guard<BinaryNodeLike>(async (node) => {
        if (node.attrs?.id && node.attrs.from) await sock.sendNode?.(ackFor(node))
      }),
    )

    sock.ev.on('chats.upsert', guard<ChatEphemeralLike[]>((chats) => this.rememberChats(chats)))
    sock.ev.on('chats.update', guard<ChatEphemeralLike[]>((chats) => this.rememberChats(chats)))

    sock.ev.on(
      'messaging-history.set',
      guard<{
        chats?: ChatEphemeralLike[]
        contacts?: RawContact[]
        messages?: RawMessage[]
        lidPnMappings?: Array<{ lid?: string; pn?: string }>
        isLatest?: boolean
        progress?: number | null
        syncType?: number | string | null
      }>((h) => {
        this.rememberChats(h.chats)
        const messages: IncomingMessage[] = []
        for (const raw of h.messages ?? []) {
          if (raw.key?.id && raw.message) this.messages.set(raw.key.id, raw)
          const msg = toIncomingMessage(raw, { historical: true, now: () => this.clock() })
          if (msg) messages.push(msg)
        }
        const contacts = (h.contacts ?? []).map((c) => this.rememberContact(c)).filter((c): c is WaContact => !!c)
        const lidMappings = (h.lidPnMappings ?? []).map(toLidMapping).filter((m): m is LidMapping => !!m)
        const out: HistoryBatch = { messages, contacts, lid_mappings: lidMappings }
        if (h.syncType !== undefined && h.syncType !== null) out.sync_type = String(h.syncType)
        if (h.isLatest !== undefined) out.is_latest = h.isLatest
        if (h.progress !== undefined) out.progress = h.progress
        this.emit('history', out)
      }),
    )

    for (const event of ['contacts.upsert', 'contacts.update'])
      sock.ev.on(
        event,
        guard<RawContact[]>((list) => {
          for (const raw of list ?? []) {
            const contact = this.rememberContact(raw)
            if (contact) this.emit('contact', contact)
          }
        }),
      )

    sock.ev.on(
      'lid-mapping.update',
      guard<{ lid?: string; pn?: string }>((m) => {
        const mapping = toLidMapping(m)
        if (mapping) this.emit('lid-mapping', mapping)
      }),
    )

    sock.ev.on(
      'presence.update',
      guard<{ id?: string; presences?: Record<string, { lastKnownPresence?: PresenceState; lastSeen?: number }> }>((p) => {
        if (!p?.id) return
        for (const [participant, data] of Object.entries(p.presences ?? {})) {
          if (!data?.lastKnownPresence) continue
          const update: { jid: string; participant?: string; presence: PresenceState; last_seen?: number | null } = {
            jid: p.id,
            presence: data.lastKnownPresence,
          }
          if (participant !== p.id) update.participant = participant
          if (data.lastSeen !== undefined) update.last_seen = data.lastSeen
          this.emit('presence', update)
        }
      }),
    )

    // Mudança de grupo avisada pelo WhatsApp: a lista e os metadados em cache deixam de valer.
    sock.ev.on('groups.upsert', guard<BaileysGroupLike[]>((groups) => {
      for (const g of groups ?? []) if (g?.id) this.groupMeta.set(g.id, g)
      this.invalidateGroups()
    }))
    sock.ev.on('groups.update', guard<Array<{ id?: string }>>((groups) => {
      for (const g of groups ?? []) if (g?.id) this.groupMeta.delete(g.id)
      this.invalidateGroups()
    }))
    sock.ev.on('group-participants.update', guard<{ id?: string }>((u) => {
      if (u?.id) this.groupMeta.delete(u.id)
      this.invalidateGroups()
    }))
  }

  private timestampOf(raw: RawMessage): number {
    const ts = raw.messageTimestamp
    const seconds = typeof ts === 'number' ? ts : ts ? ts.toNumber() : undefined
    return seconds !== undefined ? seconds * 1000 : this.clock()
  }

  private rememberContact(raw: RawContact | null | undefined): WaContact | undefined {
    const contact = toWaContact(raw)
    if (!contact) return undefined
    // contacts.update traz só os campos que mudaram: vazio não apaga o que já se sabe.
    const merged: WaContact = { ...this.contacts.get(contact.jid), jid: contact.jid, phone: null }
    for (const [k, v] of Object.entries(contact)) if (v != null) (merged as Record<string, unknown>)[k] = v
    merged.phone = contact.phone ?? this.contacts.get(contact.jid)?.phone ?? null
    this.contacts.set(contact.jid, merged)
    return merged
  }

  private async findMessage(key: WaMessageKey): Promise<RawMessage | undefined> {
    if (key.id) {
      const cached = this.messages.get(key.id)
      if (cached) return cached
    }
    return this.options.messageStore?.get(key)
  }

  private rememberEphemeral(jids: Array<string | null | undefined>, seconds: number | null | undefined) {
    const value = seconds && seconds > 0 ? seconds : 0
    for (const raw of jids) {
      if (!raw) continue
      const jid = normalizeJid(raw)
      if ((this.ephemeral.get(jid) ?? 0) === value) continue
      if (value) this.ephemeral.set(jid, value)
      else this.ephemeral.delete(jid)
      void this.options.disappearing?.save(jid, value).catch((err) => this.onListenerError(err, 'internal'))
    }
  }

  private rememberChats(chats: ChatEphemeralLike[] | undefined) {
    // Só conversas que trazem o campo: ausência não significa que as temporárias estão desligadas.
    for (const chat of chats ?? []) {
      if (chat && 'ephemeralExpiration' in chat) this.rememberEphemeral([chat.id, chat.pnJid, chat.lidJid], chat.ephemeralExpiration)
      for (const jid of [chat?.id, chat?.pnJid, chat?.lidJid]) if (jid) this.chatAnswer.get(normalizeJid(jid))?.()
    }
  }

  private rememberKey(jid: string | null | undefined, id: string | null | undefined, fromMe: boolean, at: number) {
    if (!jid || !id || !(jid.endsWith('@s.whatsapp.net') || isLidJid(jid))) return
    this.lastKey.set(normalizeJid(jid), { id, fromMe, at })
  }

  private requireSocket(): BaileysSocketLike {
    if (!this.sock || !this.connected) throw new TransportNotConnectedError()
    return this.sock
  }

  private async rawSend(to: string, content: Record<string, unknown>, quoted?: SendOptions['quoted']): Promise<{ messageId: string }> {
    const sock = this.requireSocket()
    await this.ephemeralLoad
    const options: { ephemeralExpiration?: number; quoted?: unknown } = {}
    // Em conversa com temporárias, envia com o mesmo tempo (senão o WhatsApp avisa "Esta mensagem não desaparecerá").
    const ephemeralExpiration = this.ephemeral.get(normalizeJid(to))
    if (ephemeralExpiration) options.ephemeralExpiration = ephemeralExpiration
    if (quoted) {
      const known = await this.findMessage(quoted.key)
      options.quoted = { key: quoted.key, message: quoted.message ?? known?.message ?? { conversation: '' } }
    }
    const result = Object.keys(options).length ? await sock.sendMessage(to, content, options) : await sock.sendMessage(to, content)
    const messageId = result?.key?.id
    if (!messageId) throw new Error('Baileys não devolveu o ID da mensagem enviada')
    // Guarda o enviado para o `getMessage` (retry de decifragem do outro lado).
    if (result.message) this.messages.set(messageId, { key: result.key, message: result.message })
    this.rememberKey(to, messageId, true, this.clock())
    return { messageId }
  }

  async sendMessage(to: string, content: OutgoingContent, opts: SendOptions = {}): Promise<{ messageId: string }> {
    return this.rawSend(to, toBaileysContent(content), opts.quoted)
  }

  async react(to: string, key: WaMessageKey, text: string): Promise<{ messageId: string }> {
    return this.rawSend(to, { react: { text, key } })
  }

  async deleteForEveryone(to: string, key: WaMessageKey): Promise<{ messageId: string }> {
    return this.rawSend(to, { delete: key })
  }

  async markRead(keys: WaMessageKey[]): Promise<void> {
    const sock = this.requireSocket()
    if (!sock.readMessages) throw new Error('readMessages indisponível neste socket')
    if (keys.length) await sock.readMessages(keys)
  }

  async sendPresence(to: string, presence: PresenceState): Promise<void> {
    await this.requireSocket().sendPresenceUpdate?.(presence, to)
  }

  async sendTyping(to: string, typing: boolean): Promise<void> {
    await this.sendPresence(to, typing ? 'composing' : 'paused')
  }

  async downloadMedia(messageId: string): Promise<Uint8Array> {
    const sock = this.requireSocket()
    const raw = await this.findMessage({ id: messageId })
    if (!raw?.message || !toIncomingMessage(raw)?.media) throw new MediaUnavailableError(messageId)
    if (this.options.downloadMedia) return this.options.downloadMedia(raw, sock)
    const mod = await loadBaileys()
    const ctx = { logger: this.logger, reuploadRequest: (m: unknown) => (sock.updateMediaMessage ? sock.updateMediaMessage(m) : Promise.resolve(m)) }
    const buf = await mod.downloadMediaMessage(raw, 'buffer', {}, ctx)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async listContacts(): Promise<WaContact[]> {
    return [...this.contacts.values()].map((c) => ({ ...c }))
  }

  /**
   * Conversa com tempo de temporárias desconhecido: pede ao celular 1 mensagem de histórico (ancorada na última vista);
   * a resposta traz a configuração e é aprendida em messaging-history.set. No máximo 1 vez por CHAT_CHECK_INTERVAL.
   */
  async syncChatSettings(to: string): Promise<void> {
    try {
      await this.ephemeralLoad
      const jid = normalizeJid(to)
      const sock = this.sock
      if (this.ephemeral.has(jid) || !sock?.fetchMessageHistory || !this.connected) return
      if (this.clock() - (this.checkedAt.get(jid) ?? 0) < CHAT_CHECK_INTERVAL) return
      const anchor = this.lastKey.get(jid)
      if (!anchor) return
      this.checkedAt.set(jid, this.clock())
      const answered = new Promise<void>((resolve) => {
        this.chatAnswer.set(jid, resolve)
      })
      await sock.fetchMessageHistory(1, { remoteJid: jid, fromMe: anchor.fromMe, id: anchor.id }, anchor.at)
      await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, CHAT_CHECK_WAIT).unref?.())])
      this.chatAnswer.delete(jid)
    } catch (err) {
      this.onListenerError(err, 'internal')
    }
  }

  async saveContact(jid: string, name: string): Promise<void> {
    const sock = this.requireSocket()
    await sock.addOrEditContact?.(jid, { fullName: name })
  }

  ownPhone(): string | undefined {
    return phoneFromUserJid(this.connected ? this.sock?.user?.id : undefined)
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    const sock = this.requireSocket()
    if (!sock.groupFetchAllParticipating) throw new Error('groupFetchAllParticipating indisponível neste socket')
    const fetchAll = sock.groupFetchAllParticipating.bind(sock)
    const now = this.clock()
    const ttl = this.options.groupsCacheMs ?? GROUPS_CACHE_MS
    const c = this.groupsCache
    if (c && !c.force) {
      const age = now - c.at
      const usable = now < c.retryAfter || (c.stale ? age < GROUPS_MIN_REFETCH_MS : age < ttl)
      if (usable) return c.groups.map((g) => ({ ...g }))
    }
    this.groupsInFlight ??= (async () => {
      try {
        const groups = await fetchAll()
        const own = new Set([sock.user?.id, sock.user?.lid].filter((v): v is string => typeof v === 'string').map(normalizeJid))
        for (const g of Object.values(groups)) this.groupMeta.set(g.id, g)
        const list = Object.values(groups).map((g) => toGroupSummary(g, own))
        this.groupsCache = { at: this.clock(), groups: list, stale: false, force: false, retryAfter: 0 }
        return list
      } catch (err) {
        // Limite do WhatsApp: a última lista boa vale mais que derrubar quem pediu.
        const cached = this.groupsCache
        if (cached && /rate-overlimit/i.test(err instanceof Error ? err.message : String(err))) {
          cached.force = false
          cached.retryAfter = this.clock() + GROUPS_MIN_REFETCH_MS
          return cached.groups
        }
        throw err
      } finally {
        this.groupsInFlight = undefined
      }
    })()
    return (await this.groupsInFlight).map((g) => ({ ...g }))
  }

  private invalidateGroups(force = false): void {
    if (!this.groupsCache) return
    this.groupsCache.stale = true
    if (force) this.groupsCache.force = true
  }

  async groupInviteCode(groupId: string): Promise<string> {
    const sock = this.requireSocket()
    if (!sock.groupInviteCode) throw new Error('groupInviteCode indisponível neste socket')
    const code = await sock.groupInviteCode(groupId)
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('código de convite inválido')
    return code
  }

  /** Adiciona UM participante (`groupParticipantsUpdate(..., 'add')`). Erros do grupo viram status. */
  async addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]> {
    const sock = this.requireSocket()
    if (!sock.groupParticipantsUpdate) throw new Error('groupParticipantsUpdate indisponível neste socket')
    let res: Array<{ status?: string; jid?: string }>
    try {
      res = await sock.groupParticipantsUpdate(groupId, [jid], 'add')
      this.invalidateGroups(true)
    } catch (err) {
      const code = disconnectStatusCode(err) ?? numericData(err)
      const out: GroupParticipantResult = { jid, status: mapGroupErrorStatus(code) }
      if (code !== undefined) out.code = code
      return [out]
    }
    if (!res?.length) return [{ jid, status: 'failed' }]
    return res.map((r) => {
      const code = r.status !== undefined && /^\d+$/.test(r.status) ? Number(r.status) : undefined
      const out: GroupParticipantResult = { jid: r.jid ?? jid, status: mapParticipantStatus(code) }
      if (code !== undefined) out.code = code
      return out
    })
  }

  /** Desloga o dispositivo; o Baileys emite `connection` close com reason `loggedOut`. */
  async logout(): Promise<void> {
    const sock = this.sock
    if (!sock) throw new TransportNotConnectedError()
    await sock.logout?.()
  }

  /** Encerra o socket localmente, sem deslogar e sem emitir eventos. */
  async close(): Promise<void> {
    const sock = this.sock
    this.sock = undefined
    this.connected = false
    if (sock) await sock.end?.(undefined)
  }
}

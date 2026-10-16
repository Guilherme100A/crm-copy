// Contrato WaGateway (SPEC 3.8 / AI-MANAGER-MAP §13.3): a única porta entre o CRM e o WhatsApp.
// Os tipos de comando (SendRequest, MessageView, SessionView, GroupSummary, OutgoingContent, estados) têm a forma
// exata dos tipos de @wsm/core (camelCase), para que o adapter do ai-manager seja fino. Os tipos que viajam no
// stream `wsm:events` (IncomingMessage, MediaHandle, CtwaInfo) seguem o fio em snake_case e moram em events.ts.
import type { MediaHandle, WaEvent } from './events'

export type { CtwaInfo, IncomingMessage, MediaHandle } from './events'

// ---------------------------------------------------------------- estados

/** Estados da sessão (ai-manager `SESSION_STATUSES`). */
export const SESSION_STATES = ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'] as const
export type SessionState = (typeof SESSION_STATES)[number]

/** Estados com a conta autenticada e conexão esperada. */
export const CONNECTED_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED']
/** Estados que permitem envio; fora deles o pipeline rejeita com SESSION_NOT_CONNECTED. */
export const SENDABLE_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']

/** Estados da mensagem (ai-manager `MESSAGE_STATUSES`). */
export const MESSAGE_STATUSES = ['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'retrying', 'cancelled'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/** Estados em que a mensagem ainda pode ser cancelada (nunca chegou ao transporte com sucesso). */
export const CANCELLABLE_STATUSES: readonly MessageStatus[] = ['queued', 'retrying']

/** Motivo normalizado de desconexão (ai-manager `DisconnectKind`). */
export const DISCONNECT_KINDS = ['loggedOut', 'forbidden', 'transient'] as const
export type DisconnectKind = (typeof DISCONNECT_KINDS)[number]

/** Origem do consentimento registrado pelo CRM (SPEC 1.4 nº 3). */
export const CONSENT_SOURCES = ['inbound', 'manual', 'import', 'webhook', 'sale'] as const
export type ConsentSource = (typeof CONSENT_SOURCES)[number]

export const PRESENCE_KINDS = ['composing', 'recording', 'paused'] as const
export type PresenceKind = (typeof PRESENCE_KINDS)[number]

// ---------------------------------------------------------------- conteúdo de saída

export interface MediaRef {
  url: string
}

export interface VCardContact {
  /** Nome exibido no cartão. */
  displayName: string
  /** vCard 3.0 completo (`BEGIN:VCARD … END:VCARD`). */
  vcard: string
}

export interface LocationContent {
  latitude: number
  longitude: number
  name?: string
  address?: string
}

/**
 * Conteúdo enviável (ai-manager `OutgoingContent` + contato, localização, reação e apagar).
 * Menus, botões, listas, carrossel e Pix são enviados como texto (SPEC 3.8).
 */
export type OutgoingContent =
  | { text: string }
  | { image: MediaRef; caption?: string; mimetype?: string }
  | { video: MediaRef; caption?: string; mimetype?: string }
  | { audio: MediaRef; mimetype?: string; ptt?: boolean }
  | { document: MediaRef; mimetype: string; fileName?: string; caption?: string }
  /** Figurinha nativa do WhatsApp (arquivo .webp). */
  | { sticker: MediaRef }
  | { contact: VCardContact }
  | { location: LocationContent }
  /** Reação a uma mensagem (id do WhatsApp). `emoji: ''` remove a reação. */
  | { react: { messageId: string; emoji: string } }
  /** Apagar para todos uma mensagem enviada por esta sessão (id do WhatsApp). */
  | { delete: { messageId: string } }

export const OUTGOING_CONTENT_KINDS = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'contact', 'location', 'react', 'delete'] as const
export type OutgoingContentKind = (typeof OUTGOING_CONTENT_KINDS)[number]

/** Tipo do conteúdo (a primeira chave conhecida do objeto). */
export function contentKind(content: OutgoingContent): OutgoingContentKind {
  const kind = OUTGOING_CONTENT_KINDS.find((k) => Object.hasOwn(content, k))
  if (!kind) throw new TypeError('unknown outgoing content')
  return kind
}

// ---------------------------------------------------------------- requisições e views

export interface SendRequest {
  sessionId: string
  /** Telefone E.164 do destinatário. */
  phone: string
  /** Preenchido apenas por sendGroup: destino explícito de grupo. */
  groupId?: string
  content: OutgoingContent
  /** Quem pediu o envio (`crm:<userId>`). Sem actor, o gate auth rejeita. */
  actor?: string
  contactId?: string | null
  /** Idempotência ponta a ponta (T49): o mesmo (sessionId, clientMessageId) devolve a mensagem já enfileirada. */
  clientMessageId?: string
  /** Resposta citada: id da mensagem original no WhatsApp. */
  quoted?: string
  /** Mídia de visualização única. */
  viewOnce?: boolean
}

export interface SendGroupRequest {
  sessionId: string
  /** JID do grupo (`…@g.us`). */
  groupId: string
  content: OutgoingContent
  actor: string
  clientMessageId?: string
  quoted?: string
  viewOnce?: boolean
}

export interface ReactRequest {
  sessionId: string
  /** Telefone E.164 (ou JID de grupo) da conversa onde está a mensagem. */
  phone: string
  /** Id da mensagem no WhatsApp. */
  messageId: string
  /** `''` remove a reação. */
  emoji: string
  actor: string
}

export interface DeleteForEveryoneRequest {
  sessionId: string
  phone: string
  /** Id da mensagem no WhatsApp (enviada por esta sessão). */
  messageId: string
  actor: string
}

export interface MessageView {
  id: string
  sessionId: string
  contactId: string | null
  phone: string
  content: unknown
  status: MessageStatus
  attempts: number
  /** Último erro de envio. */
  lastError: string | null
  transportMessageId: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
  updatedAt: string
  /** `clientMessageId` do pedido, quando informado (acréscimo do CRM; ausente no ai-manager). */
  clientMessageId?: string | null
}

export interface SessionView {
  id: string
  name: string
  /** Null até a sessão conectar pela primeira vez (cadastro por QR sem número). */
  phone: string | null
  status: SessionState
  /** Alias de `status`. */
  state: SessionState
  proxyId: string | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InlineProxyInput {
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string | null
  password?: string | null
}

export interface CreateSessionInput {
  name: string
  /** Opcional no QR: preenchido com o número da conta ao conectar. Obrigatório para pairing code. */
  phone?: string | null
  proxyId?: string | null
  note?: string | null
  /** Proxy informado junto com a sessão. Exclusivo com proxyId. */
  proxy?: InlineProxyInput | null
}

/** Controle de sessões (ai-manager `SessionsControl`). */
export interface WaSessionsControl {
  create(input: CreateSessionInput): Promise<SessionView>
  list(): Promise<SessionView[]>
  get(id: string): Promise<SessionView>
  startQr(id: string): Promise<SessionView>
  /** QR como data URL PNG. */
  getQr(id: string): Promise<{ qr: string | null; generatedAt: string | null }>
  requestPairingCode(id: string, phone?: string): Promise<{ code: string }>
  pause(id: string): Promise<SessionView>
  resume(id: string): Promise<SessionView>
  restart(id: string): Promise<SessionView>
  logout(id: string): Promise<SessionView>
  /** Exclui a sessão (desvincula o aparelho, apaga histórico e fila). */
  remove(id: string): Promise<{ deletedProxyId: string | null }>
}

export interface GroupSummary {
  id: string
  name: string
  /** Quantidade de participantes. */
  participants: number
  /** Somente admins enviam mensagens. */
  announce: boolean
  /** Grupo pertencente a uma comunidade (JID da comunidade). */
  communityId?: string
  /** A conta desta sessão é admin (ou superadmin) do grupo. */
  isAdmin?: boolean
}

/** Contato da agenda do WhatsApp (importação de contatos, T67). */
export interface WaContactSummary {
  /** JID como o WhatsApp entrega (PN ou LID). Nunca usar como chave do CRM. */
  jid: string
  /** E.164, quando conhecido. */
  phone: string | null
  /** LID (`…@lid`), quando conhecido. */
  lid: string | null
  name: string | null
  pushName: string | null
}

export interface RecordConsentInput {
  /** Telefone E.164. */
  phone: string
  source: ConsentSource
  actor?: string
  name?: string | null
}

export interface OptOutInput {
  phone: string
  reason?: string
  actor?: string
}

export interface WaProfile {
  name: string | null
  status: string | null
  pictureUrl: string | null
}

/** Perfil da conta conectada (opcional por capacidade). */
export interface WaProfileControl {
  get(sessionId: string): Promise<WaProfile>
  setName?(sessionId: string, name: string): Promise<void>
  setStatus?(sessionId: string, status: string): Promise<void>
  setPicture?(sessionId: string, picture: MediaRef): Promise<void>
}

/** Recursos que dependem do backend; o CRM degrada (envia como texto, esconde a ação) quando `false`. */
export interface WaCapabilities {
  nativeButtons: boolean
  nativeCarousel: boolean
  calls: boolean
  labelsSync: boolean
  businessProfile: boolean
}

/** Todas as capacidades desligadas (padrão do Baileys sem recursos nativos). */
export function defaultCapabilities(): WaCapabilities {
  return { nativeButtons: false, nativeCarousel: false, calls: false, labelsSync: false, businessProfile: false }
}

export type WaEventListener = (event: WaEvent) => void | Promise<void>

/** Bytes da mídia: stream (Web Streams) ou buffer (Buffer é um Uint8Array). */
export type MediaBody = ReadableStream<Uint8Array> | Uint8Array

export interface WaGateway {
  readonly capabilities: WaCapabilities
  sessions: WaSessionsControl
  /** = SendPipeline.send (gates → fila → antiban). Resolve com a mensagem `queued`; rejeita com SendRejectedError. */
  send(req: SendRequest): Promise<MessageView>
  sendGroup(req: SendGroupRequest): Promise<MessageView>
  /** Cancela uma mensagem ainda na fila (`queued`/`retrying`). */
  cancel(messageId: string): Promise<MessageView>
  fetchGroups(sessionId: string): Promise<GroupSummary[]>
  downloadMedia(sessionId: string, ref: MediaHandle): Promise<MediaBody>
  /** "digitando…"/"gravando…"/parar, para um telefone E.164 ou JID. Falhar não impede o envio. */
  presence(sessionId: string, to: string, kind: PresenceKind): Promise<void>
  /** Reação: passa pelo pipeline como `{ react }`. */
  react(req: ReactRequest): Promise<MessageView>
  /** Apagar para todos: passa pelo pipeline como `{ delete }`. */
  deleteForEveryone(req: DeleteForEveryoneRequest): Promise<MessageView>
  listContacts(sessionId: string): Promise<WaContactSummary[]>
  /** Registra consentimento no engine para o gate `contactAllowed` aceitar envios. */
  recordConsent(input: RecordConsentInput): Promise<void>
  /** Opt-out: bloqueia todo envio para o telefone (gate `contactAllowed`). */
  optOut(input: OptOutInput): Promise<void>
  /**
   * Recibo de leitura (azul) das mensagens recebidas no chat (ids do WhatsApp). Opcional: o perfil ai-manager
   * pode não ter (T46); sem ele o CRM só grava a leitura localmente.
   */
  markRead?(sessionId: string, chatJid: string, messageIds: string[]): Promise<void>
  profile?: WaProfileControl
  /** Assina os eventos WaEvent v1. Devolve a função que cancela a assinatura. */
  subscribe(listener: WaEventListener): () => void
}

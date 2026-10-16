// Contrato de transporte (SPEC T07): isola o Baileys 7.0.0-rc14 atrás de uma interface testável.
// Base: WaTransport do ai-manager (AI-MANAGER-MAP §2) + os acréscimos do CRM (mídia, presença, reação, leitura,
// contatos, LID, histórico). Mensagens e contatos saem em snake_case, na forma do WaEvent v1 (`@crm/wa-port`).
import type { AuthenticationState } from '@whiskeysockets/baileys'
import type { CtwaInfo, DisconnectKind, WaContact } from '@crm/wa-port'

export type { AuthenticationState, CtwaInfo, DisconnectKind, WaContact }

/** Aparelho anunciado ao WhatsApp: [SO, navegador, versão]; fixo por sessão. */
export type BrowserDescription = [string, string, string]

export interface ConnectOptions {
  sessionId: string
  auth: AuthenticationState
  /** http://, https:// ou socks5://. */
  proxyUrl?: string
  /** Se definido e a sessão ainda não estiver registrada, pede código de pareamento em vez de QR. */
  pairingPhone?: string
  /** Chamado em `creds.update`; persiste o auth state. */
  saveCreds?: () => Promise<void> | void
  /** Padrão: `browserForSession(sessionId)`. */
  browser?: BrowserDescription
}

export interface ConnectionUpdate {
  state: 'open' | 'close'
  reason?: DisconnectKind
  statusCode?: number
}

/** Key de mensagem do WhatsApp, repassada inteira em reação, exclusão, citação e leitura. */
export interface WaMessageKey {
  remoteJid?: string | null
  fromMe?: boolean | null
  id?: string | null
  participant?: string | null
  remoteJidAlt?: string | null
  participantAlt?: string | null
  addressingMode?: string | null
}

export type IncomingMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

/** Descritor da mídia recebida (os bytes vêm por `downloadMedia(id)`). */
export interface IncomingMedia {
  kind: IncomingMediaKind
  mime: string
  /** Bytes declarados pelo remetente. */
  size: number | null
  /** SHA-256 do arquivo (hex). */
  sha256: string | null
  file_name?: string
  /** Nota de voz. */
  ptt?: boolean
  /** Duração (áudio/vídeo). */
  seconds?: number
}

/**
 * Mensagem recebida: `IncomingMessage` do ai-manager em snake_case (`fromAlt` → `alt_jid`, `fromMe` → `from_me`,
 * `pushName` → `push_name`) + `media`, `quoted_id`, `ad` e `historical`.
 */
export interface IncomingMessage {
  id: string
  /** JID do chat (contato ou grupo). */
  from: string
  /** JID alternativo (`key.remoteJidAlt`): telefone quando o chat usa LID, e vice-versa. */
  alt_jid?: string
  /** Autor dentro de um grupo. */
  participant?: string
  participant_alt?: string
  from_me: boolean
  /** Epoch em milissegundos. */
  timestamp: number
  push_name?: string
  /** Texto (conversa, legenda ou texto estendido). */
  text?: string
  /** Tipo do conteúdo (ex.: `conversation`, `imageMessage`), já sem invólucros (ephemeral/viewOnce). */
  type: string
  media?: IncomingMedia
  /** Id da mensagem citada (`contextInfo.stanzaId`). */
  quoted_id?: string
  /** Anúncio Click-to-WhatsApp (`contextInfo.externalAdReply`). */
  ad?: CtwaInfo
  /** `true` = sincronizada (histórico ou enviada de outro aparelho): gravar, sem disparar automações. */
  historical?: true
  /** Key original, para reagir, citar, apagar ou marcar como lida. */
  key: WaMessageKey
}

export interface ReceiptUpdate {
  messageId: string
  status: 'delivered' | 'read'
}

/** Par LID ↔ telefone (`lid-mapping.update`). `lid` e `pn` são JIDs; `phone` é o E.164 do `pn`. */
export interface LidMapping {
  lid: string
  pn: string
  phone?: string
}

export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'

export interface PresenceUpdate {
  jid: string
  participant?: string
  presence: PresenceState
  last_seen?: number | null
}

export interface HistoryBatch {
  messages: IncomingMessage[]
  contacts: WaContact[]
  lid_mappings: LidMapping[]
  sync_type?: string
  is_latest?: boolean
  progress?: number | null
}

export type MediaRef = { url: string } | { data: Uint8Array }

export type OutgoingContent =
  | { text: string }
  | { image: MediaRef; caption?: string; mimetype?: string }
  | { video: MediaRef; caption?: string; mimetype?: string }
  /** `ptt: true` (nota de voz) sempre sai com `audio/ogg; codecs=opus`. */
  | { audio: MediaRef; mimetype?: string; ptt?: boolean; seconds?: number }
  | { document: MediaRef; mimetype: string; fileName?: string; caption?: string }
  | { sticker: MediaRef }

export interface SendOptions {
  /** Resposta citada: key da mensagem original (+ conteúdo, se conhecido). */
  quoted?: { key: WaMessageKey; message?: Record<string, unknown> | null }
}

export interface GroupSummary {
  id: string
  name: string
  participants: number
  /** Somente admins enviam mensagens. */
  announce: boolean
  communityId?: string
  /** A conta desta sessão é admin do grupo. */
  isAdmin?: boolean
}

export type GroupParticipantStatus = 'added' | 'already_member' | 'not_admin' | 'group_not_found' | 'not_allowed' | 'failed'

export interface GroupParticipantResult {
  jid: string
  status: GroupParticipantStatus
  code?: number
}

export interface TransportEvents {
  qr: string
  'pairing-code': string
  connection: ConnectionUpdate
  message: IncomingMessage
  receipt: ReceiptUpdate
  contact: WaContact
  'lid-mapping': LidMapping
  presence: PresenceUpdate
  history: HistoryBatch
}

export type TransportEvent = keyof TransportEvents
export type TransportListener<E extends TransportEvent> = (payload: TransportEvents[E]) => void

export interface WaTransport {
  connect(opts: ConnectOptions): Promise<void>
  on<E extends TransportEvent>(event: E, cb: TransportListener<E>): void
  off<E extends TransportEvent>(event: E, cb: TransportListener<E>): void
  sendMessage(to: string, content: OutgoingContent, opts?: SendOptions): Promise<{ messageId: string }>
  /** Reação com a key original completa; `text: ''` remove a reação. */
  react(to: string, key: WaMessageKey, text: string): Promise<{ messageId: string }>
  /** Apaga para todos (só mensagens próprias, dentro do prazo do WhatsApp). */
  deleteForEveryone(to: string, key: WaMessageKey): Promise<{ messageId: string }>
  /** Marca como lidas (por key; não existe "ler a conversa toda"). */
  markRead(keys: WaMessageKey[]): Promise<void>
  /** Presença para o JID (digitando, gravando, pausado, online/offline). */
  sendPresence(to: string, presence: PresenceState): Promise<void>
  /** Atalho do ai-manager: `composing` / `paused`. */
  sendTyping(to: string, typing: boolean): Promise<void>
  /** Bytes da mídia de uma mensagem recebida. Lança `MediaUnavailableError` se a mensagem não é conhecida ou não tem mídia. */
  downloadMedia(messageId: string): Promise<Uint8Array>
  /** Contatos conhecidos pela sessão (contacts.upsert/update e histórico). */
  listContacts(): Promise<WaContact[]>
  /** Garante que o transporte conhece o tempo das mensagens temporárias da conversa. Não lança. */
  syncChatSettings?(to: string): Promise<void>
  saveContact?(jid: string, name: string): Promise<void>
  fetchGroups(): Promise<GroupSummary[]>
  /** Adiciona UM participante (ação manual do admin). Só lança TransportNotConnectedError. */
  addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]>
  groupInviteCode?(groupId: string): Promise<string>
  /** Número (E.164) da conta autenticada, quando conectada. */
  ownPhone(): string | undefined
  logout(): Promise<void>
  close(): Promise<void>
}

export class TransportNotConnectedError extends Error {
  readonly code = 'TRANSPORT_NOT_CONNECTED'
  constructor(message = 'transporte não está conectado') {
    super(message)
    this.name = 'TransportNotConnectedError'
  }
}

export class MediaUnavailableError extends Error {
  readonly code = 'MEDIA_UNAVAILABLE'
  constructor(readonly messageId: string, message = 'mídia indisponível para a mensagem') {
    super(message)
    this.name = 'MediaUnavailableError'
  }
}

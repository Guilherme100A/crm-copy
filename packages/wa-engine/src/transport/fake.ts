// FakeTransport: transporte em memória para testes (SPEC 3.10 "Fakes oficiais"). Nunca abre rede.
import { TransportEmitter } from './emitter'
import { phoneFromUserJid } from './message'
import {
  MediaUnavailableError,
  TransportNotConnectedError,
  type ConnectOptions,
  type DisconnectKind,
  type GroupParticipantResult,
  type GroupSummary,
  type HistoryBatch,
  type IncomingMessage,
  type LidMapping,
  type OutgoingContent,
  type PresenceState,
  type PresenceUpdate,
  type SendOptions,
  type WaContact,
  type WaMessageKey,
  type WaTransport,
} from './types'

export interface FakeSentMessage {
  messageId: string
  to: string
  content: OutgoingContent
  options?: SendOptions
  at: Date
}

/** Grupo simulado: `members` (JIDs) permite simular "já é membro". */
export type FakeGroup = GroupSummary & { members?: string[] }

export type FakeIncomingInput = Partial<IncomingMessage> & { from: string }

export class FakeTransport extends TransportEmitter implements WaTransport {
  /** Envios bem-sucedidos (`sendMessage`), em ordem. */
  readonly sent: FakeSentMessage[] = []
  readonly reactions: Array<{ messageId: string; to: string; key: WaMessageKey; text: string }> = []
  readonly deletions: Array<{ messageId: string; to: string; key: WaMessageKey }> = []
  readonly reads: WaMessageKey[][] = []
  readonly presences: Array<{ to: string; presence: PresenceState }> = []
  readonly savedContacts: Array<{ jid: string; name: string }> = []
  readonly connectCalls: ConnectOptions[] = []
  readonly groupAdds: Array<{ groupId: string; jid: string }> = []
  /** Bytes devolvidos por `downloadMedia`, por id de mensagem. */
  readonly media = new Map<string, Uint8Array>()
  groups: FakeGroup[] = []
  /** Número da conta "autenticada"; devolvido por `ownPhone()` enquanto conectado. */
  phone: string | undefined

  connected = false
  loggedOut = false
  closed = false

  private readonly contacts = new Map<string, WaContact>()
  private readonly sendFailures: Error[] = []
  private readonly groupAddFailures: Error[] = []
  private seq = 0

  get lastConnect(): ConnectOptions | undefined {
    return this.connectCalls.at(-1)
  }

  async connect(opts: ConnectOptions): Promise<void> {
    this.connectCalls.push(opts)
    this.closed = false
    this.loggedOut = false
  }

  // ---- helpers de simulação -------------------------------------------------

  emitQr(qr = `fake-qr-${++this.seq}`): void {
    this.emit('qr', qr)
  }

  emitPairingCode(code = 'FAKE1234'): void {
    this.emit('pairing-code', code)
  }

  /** Simula conexão aberta. */
  open(): void {
    this.connected = true
    this.emit('connection', { state: 'open' })
  }

  /**
   * Com `reason`: simula queda vinda do WhatsApp (emite `connection` close).
   * Sem argumentos: é o `close()` da interface (encerramento local, sem evento).
   */
  async close(reason?: DisconnectKind, statusCode?: number): Promise<void> {
    this.connected = false
    if (reason === undefined) {
      this.closed = true
      return
    }
    if (reason === 'loggedOut') this.loggedOut = true
    this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
  }

  /** Simula mensagem recebida; campos ausentes recebem defaults. `media` com `data` fica disponível no `downloadMedia`. */
  receive(msg: FakeIncomingInput & { data?: Uint8Array }): IncomingMessage {
    const { data, ...rest } = msg
    const id = rest.id ?? `FAKE-IN-${++this.seq}`
    const full: IncomingMessage = {
      id,
      from_me: false,
      timestamp: Date.now(),
      type: 'conversation',
      key: { remoteJid: rest.from, fromMe: rest.from_me ?? false, id, ...(rest.participant ? { participant: rest.participant } : {}) },
      ...rest,
    }
    if (data) this.media.set(id, data)
    this.emit('message', full)
    return full
  }

  receipt(messageId: string, status: 'delivered' | 'read'): void {
    this.emit('receipt', { messageId, status })
  }

  /** O próximo envio (`sendMessage`, `react`, `deleteForEveryone`) rejeita com `err`. */
  failNextSend(err: Error = new Error('fake send failure')): void {
    this.sendFailures.push(err)
  }

  /** Simula `lid-mapping.update`; `pn` aceita JID (`…@s.whatsapp.net`) ou E.164. */
  emitLidMapping(lid: string, pn: string): LidMapping {
    const pnJid = pn.includes('@') ? pn : `${pn.replace(/\D/g, '')}@s.whatsapp.net`
    const mapping: LidMapping = { lid, pn: pnJid }
    const phone = phoneFromUserJid(pnJid)
    if (phone) mapping.phone = phone
    this.emit('lid-mapping', mapping)
    return mapping
  }

  /** Simula `contacts.upsert`; o contato passa a aparecer em `listContacts()`. */
  emitContact(contact: Partial<WaContact> & { jid: string }): WaContact {
    const full: WaContact = { phone: phoneFromUserJid(contact.jid) ?? null, ...contact }
    this.contacts.set(full.jid, { ...this.contacts.get(full.jid), ...full })
    this.emit('contact', full)
    return full
  }

  emitPresence(update: PresenceUpdate): void {
    this.emit('presence', update)
  }

  emitHistory(batch: Partial<HistoryBatch>): HistoryBatch {
    const full: HistoryBatch = {
      contacts: [],
      lid_mappings: [],
      ...batch,
      messages: (batch.messages ?? []).map((m) => ({ ...m, historical: true as const })),
    }
    this.emit('history', full)
    return full
  }

  setGroups(groups: FakeGroup[]): void {
    this.groups = groups
  }

  failNextGroupAdd(err: Error = new Error('fake group add failure')): void {
    this.groupAddFailures.push(err)
  }

  // ---- WaTransport ------------------------------------------------------------

  private nextSend(): string {
    const failure = this.sendFailures.shift()
    if (failure) throw failure
    if (!this.connected) throw new TransportNotConnectedError()
    return `FAKE-OUT-${++this.seq}`
  }

  async sendMessage(to: string, content: OutgoingContent, options?: SendOptions): Promise<{ messageId: string }> {
    const messageId = this.nextSend()
    this.sent.push(options ? { messageId, to, content, options, at: new Date() } : { messageId, to, content, at: new Date() })
    return { messageId }
  }

  async react(to: string, key: WaMessageKey, text: string): Promise<{ messageId: string }> {
    const messageId = this.nextSend()
    this.reactions.push({ messageId, to, key, text })
    return { messageId }
  }

  async deleteForEveryone(to: string, key: WaMessageKey): Promise<{ messageId: string }> {
    const messageId = this.nextSend()
    this.deletions.push({ messageId, to, key })
    return { messageId }
  }

  async markRead(keys: WaMessageKey[]): Promise<void> {
    if (!this.connected) throw new TransportNotConnectedError()
    this.reads.push(keys)
  }

  async sendPresence(to: string, presence: PresenceState): Promise<void> {
    if (!this.connected) throw new TransportNotConnectedError()
    this.presences.push({ to, presence })
  }

  async sendTyping(to: string, typing: boolean): Promise<void> {
    await this.sendPresence(to, typing ? 'composing' : 'paused')
  }

  async downloadMedia(messageId: string): Promise<Uint8Array> {
    if (!this.connected) throw new TransportNotConnectedError()
    const data = this.media.get(messageId)
    if (!data) throw new MediaUnavailableError(messageId)
    return data
  }

  async listContacts(): Promise<WaContact[]> {
    return [...this.contacts.values()].map((c) => ({ ...c }))
  }

  async saveContact(jid: string, name: string): Promise<void> {
    if (!this.connected) throw new TransportNotConnectedError()
    this.savedContacts.push({ jid, name })
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    if (!this.connected) throw new TransportNotConnectedError()
    return this.groups.map(({ members: _members, ...g }) => ({ ...g }))
  }

  async addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]> {
    if (!this.connected) throw new TransportNotConnectedError()
    this.groupAdds.push({ groupId, jid })
    const failure = this.groupAddFailures.shift()
    if (failure) throw failure
    const group = this.groups.find((g) => g.id === groupId)
    if (!group) return [{ jid, status: 'group_not_found', code: 404 }]
    if (!group.isAdmin) return [{ jid, status: 'not_admin', code: 403 }]
    if (group.members?.includes(jid)) return [{ jid, status: 'already_member', code: 409 }]
    group.members = [...(group.members ?? []), jid]
    group.participants += 1
    return [{ jid, status: 'added', code: 200 }]
  }

  ownPhone(): string | undefined {
    return this.connected ? this.phone : undefined
  }

  async logout(): Promise<void> {
    await this.close('loggedOut', 401)
  }
}

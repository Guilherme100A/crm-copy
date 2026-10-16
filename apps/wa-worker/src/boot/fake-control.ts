// Controle do FakeTransport (SÓ com WA_TRANSPORT=fake; padrão do ai-manager boot/fake-control.ts): o teste simula
// QR, conexão, quedas, mensagens recebidas, receipts e falhas de envio dentro do worker. Os envios bem-sucedidos
// vão também para um histórico no Redis com o `bootId`, para provar "sem duplicar" entre reinícios.
import { randomUUID } from 'node:crypto'
import { FakeTransport, type DisconnectKind, type FakeSentMessage, type TransportFactory } from '@crm/wa-engine'

export interface RedisList {
  rpush(key: string, ...values: string[]): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
}

export interface FakeSentRecord {
  messageId: string
  to: string
  content: unknown
  at: string
  bootId: string
}

export class FakeTransportNotFoundError extends Error {
  readonly code = 'FAKE_TRANSPORT_NOT_FOUND'
  constructor(sessionId: string) {
    super(`no fake transport for session ${sessionId} in this worker`)
    this.name = 'FakeTransportNotFoundError'
  }
}

export interface FakeControlOptions {
  redis: RedisList
  prefix?: string
  bootId?: string
  logger?: { error(obj: object, msg?: string): void }
}

export class FakeControl {
  readonly bootId: string
  private readonly created = new Map<string, FakeTransport[]>()
  private readonly prefix: string

  constructor(private readonly opts: FakeControlOptions) {
    this.bootId = opts.bootId ?? randomUUID()
    this.prefix = opts.prefix ?? 'wsm'
  }

  historyKey(sessionId: string): string {
    return `${this.prefix}:fake:sent:${sessionId}`
  }

  /** Factory do SessionManager: FakeTransport cujos envios bem-sucedidos vão para o histórico no Redis. */
  readonly factory: TransportFactory = (sessionId) => {
    const t = new FakeTransport()
    const sent = t.sent as FakeSentMessage[]
    const push = sent.push.bind(sent)
    sent.push = (...items: FakeSentMessage[]) => {
      for (const m of items) {
        const rec: FakeSentRecord = { messageId: m.messageId, to: m.to, content: m.content, at: m.at.toISOString(), bootId: this.bootId }
        void this.opts.redis
          .rpush(this.historyKey(sessionId), JSON.stringify(rec))
          .catch((err: unknown) => this.opts.logger?.error({ session_id: sessionId, err: String(err) }, 'fake history write failed'))
      }
      return push(...items)
    }
    this.created.set(sessionId, [...(this.created.get(sessionId) ?? []), t])
    return t
  }

  last(sessionId: string): FakeTransport | undefined {
    return this.created.get(sessionId)?.at(-1)
  }

  require(sessionId: string): FakeTransport {
    const t = this.last(sessionId)
    if (!t) throw new FakeTransportNotFoundError(sessionId)
    return t
  }

  state(sessionId: string) {
    const t = this.last(sessionId)
    if (!t) return { exists: false, bootId: this.bootId, connected: false, connectCalls: 0, transports: 0, sent: [], reads: [] }
    return {
      exists: true,
      bootId: this.bootId,
      connected: t.connected,
      connectCalls: t.connectCalls.length,
      transports: this.created.get(sessionId)?.length ?? 0,
      sent: t.sent.map((m) => ({ messageId: m.messageId, to: m.to, content: m.content, at: m.at.toISOString() })),
      // Uma entrada por markRead: chat e ids lidos.
      reads: t.reads.map((keys) => ({ chatJid: keys[0]?.remoteJid ?? null, ids: keys.map((k) => k.id) })),
    }
  }

  async history(sessionId: string): Promise<FakeSentRecord[]> {
    const raw = await this.opts.redis.lrange(this.historyKey(sessionId), 0, -1)
    return raw.map((r) => JSON.parse(r) as FakeSentRecord)
  }

  qr(sessionId: string, qr?: string): void {
    this.require(sessionId).emitQr(qr)
  }

  pairingCode(sessionId: string, code?: string): void {
    this.require(sessionId).emitPairingCode(code)
  }

  open(sessionId: string): void {
    this.require(sessionId).open()
  }

  async close(sessionId: string, reason: DisconnectKind, statusCode?: number): Promise<void> {
    await this.require(sessionId).close(reason, statusCode)
  }

  receive(sessionId: string, msg: { from: string; text?: string; fromMe?: boolean; type?: string }) {
    const input: Parameters<FakeTransport['receive']>[0] = { from: msg.from }
    if (msg.text !== undefined) input.text = msg.text
    if (msg.fromMe !== undefined) input.from_me = msg.fromMe
    if (msg.type !== undefined) input.type = msg.type
    return this.require(sessionId).receive(input)
  }

  receipt(sessionId: string, messageId: string, status: 'delivered' | 'read'): void {
    this.require(sessionId).receipt(messageId, status)
  }

  failNextSend(sessionId: string, opts: { message?: string; statusCode?: number } = {}): void {
    const err = new Error(opts.message ?? (opts.statusCode === 403 ? 'forbidden' : 'fake send failure'))
    if (opts.statusCode !== undefined) Object.assign(err, { statusCode: opts.statusCode, output: { statusCode: opts.statusCode } })
    this.require(sessionId).failNextSend(err)
  }
}

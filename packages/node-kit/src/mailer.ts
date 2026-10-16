// E-mail (SPEC T05, AC-T05-05): porta `Mailer` + `SmtpMailer` (nodemailer 10, transporte singleton com pool)
// + `MemoryMailer` (testes e harness E2E, `MAIL_TRANSPORT=memory`).
import { randomUUID } from 'node:crypto'
import { createTransport, type Transporter } from 'nodemailer'

export interface MailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

export interface MailMessage {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  /** Default: `MAIL_FROM` do mailer. */
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
  attachments?: MailAttachment[]
}

export interface SentMail {
  messageId: string
}

export interface Mailer {
  send(message: MailMessage): Promise<SentMail>
  /** Libera conexões (shutdown). */
  close(): Promise<void>
}

/** Mensagem guardada pelo `MemoryMailer`. */
export interface StoredMail extends MailMessage {
  from: string
  messageId: string
  sentAt: Date
}

export class MemoryMailer implements Mailer {
  readonly from: string
  private readonly store: StoredMail[] = []

  constructor(opts: { from?: string } = {}) {
    this.from = opts.from ?? (process.env.MAIL_FROM || 'no-reply@example.com')
  }

  /** Mensagens enviadas, na ordem. */
  get messages(): readonly StoredMail[] {
    return this.store
  }

  /** Alias de `messages`. */
  get sent(): readonly StoredMail[] {
    return this.store
  }

  async send(message: MailMessage): Promise<SentMail> {
    assertMessage(message)
    const messageId = `<${randomUUID()}@memory>`
    this.store.push({ ...message, from: message.from ?? this.from, messageId, sentAt: new Date() })
    return { messageId }
  }

  /** Última mensagem enviada (opcionalmente para um destinatário). */
  last(to?: string): StoredMail | undefined {
    for (let i = this.store.length - 1; i >= 0; i--) {
      const m = this.store[i]!
      if (to === undefined || toList(m.to).includes(to)) return m
    }
    return undefined
  }

  clear(): void {
    this.store.length = 0
  }

  async close(): Promise<void> {}
}

export interface SmtpMailerOptions {
  /** `smtp://user:pass@host:587` ou `smtps://…:465`. Default: `SMTP_URL`. */
  url?: string
  /** Default: `MAIL_FROM`. */
  from?: string
  maxConnections?: number
  maxMessages?: number
  /** Timeout de conexão/saudação/socket em ms. Default 10000. */
  timeoutMs?: number
}

/**
 * SMTP via nodemailer com **um** transporte de vida longa e `pool: true` (STACK Bloco E §6).
 * Nunca crie um transporte por e-mail; envio em massa sai pela fila `mail`.
 */
export class SmtpMailer implements Mailer {
  readonly from: string
  private readonly transport: Transporter

  constructor(opts: SmtpMailerOptions = {}) {
    const url = opts.url ?? process.env.SMTP_URL
    if (!url) throw new Error('SMTP_URL ausente (MAIL_TRANSPORT=smtp)')
    this.from = opts.from ?? (process.env.MAIL_FROM || 'no-reply@example.com')
    const t = opts.timeoutMs ?? 10_000
    this.transport = createTransport({
      url,
      pool: true,
      maxConnections: opts.maxConnections ?? 5,
      maxMessages: opts.maxMessages ?? 100,
      connectionTimeout: t,
      greetingTimeout: t,
      socketTimeout: t,
    })
  }

  /** Confere conexão e autenticação (chame no boot). */
  async verify(): Promise<void> {
    await this.transport.verify()
  }

  async send(message: MailMessage): Promise<SentMail> {
    assertMessage(message)
    const info = await this.transport.sendMail({ ...message, from: message.from ?? this.from })
    return { messageId: String(info.messageId) }
  }

  async close(): Promise<void> {
    this.transport.close()
  }
}

export type MailTransportKind = 'smtp' | 'memory'

export interface CreateMailerOptions extends SmtpMailerOptions {
  /** Default: `MAIL_TRANSPORT` ou `memory`. */
  transport?: MailTransportKind
}

/** Mailer conforme `MAIL_TRANSPORT` (`smtp|memory`). Crie um por processo (singleton). */
export function createMailer(opts: CreateMailerOptions = {}): Mailer {
  const kind = opts.transport ?? ((process.env.MAIL_TRANSPORT || 'memory') as MailTransportKind)
  if (kind === 'memory') return new MemoryMailer({ from: opts.from })
  if (kind === 'smtp') return new SmtpMailer(opts)
  throw new Error(`MAIL_TRANSPORT inválido: ${String(kind)} (use smtp|memory)`)
}

function toList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v]
}

function assertMessage(m: MailMessage): void {
  if (!m || toList(m.to).filter(Boolean).length === 0) throw new TypeError('e-mail sem destinatário')
  if (typeof m.subject !== 'string') throw new TypeError('e-mail sem assunto')
  if (m.html === undefined && m.text === undefined) throw new TypeError('e-mail sem corpo (html ou text)')
}

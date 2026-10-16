// SendPipeline (T20, fork do ai-manager core/send): todo envio passa pelos gates na ordem fixa
// auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue.
// O primeiro gate que falha interrompe a cadeia com o código/HTTP do SendRejectedError (@crm/wa-port).
import { GATE_ORDER, SendRejectedError, type GateName } from '@crm/wa-port'
import type { Database } from '../db'
import { canMessage, ConsentService, type ConsentContact } from './consent'
import type { EnqueueMessageInput, MessageView } from '../queue/store'
import { SessionLimitsService, type SessionLimitsView } from '../safety/limits'
import { SENDABLE_STATES } from '../session/states'
import { SessionStore, type SessionRow } from '../session/store'
import type { OutgoingContent, WaTransport } from '../transport'
import type { WarmupSchedule } from '../warmup'

// Mesma tabela e mesma classe da fronteira: o erro atravessa o RPC e chega à API com código e HTTP intactos.
export { GATE_ORDER, SEND_REJECTION_STATUS, SendRejectedError, type GateName, type SendRejectionCode } from '@crm/wa-port'

export interface SendRequest {
  sessionId: string
  /** Telefone E.164 do destinatário. */
  phone: string
  /** Preenchido apenas por sendGroup: destino explícito de grupo. */
  groupId?: string
  content: OutgoingContent
  /** Quem pediu o envio (autenticado). Sem actor, o gate auth rejeita. */
  actor?: string
  contactId?: string | null
}

/** Estado compartilhado entre os gates de um envio. */
export interface SendContext {
  session?: SessionRow
  transport?: WaTransport
  contact?: ConsentContact
  limits?: SessionLimitsView
  message?: MessageView
}

export type Gate = (req: SendRequest, ctx: SendContext) => Promise<void>

/** Produtor da fila (MessageQueue do T08). */
export interface SendQueue {
  enqueue(input: EnqueueMessageInput): Promise<MessageView>
}

export interface SendPipelineOptions {
  db: Database
  /** Fila do T08 (obrigatória para o gate enqueue default). */
  queue?: SendQueue
  /** Consentimento/opt-out (default: ConsentService sobre public.contacts). */
  consent?: ConsentService
  /** Transporte vivo da sessão (SessionManager.getTransport). Sem ele, `connected` só olha o estado. */
  getTransport?: (sessionId: string) => WaTransport | undefined
  limits?: SessionLimitsService
  now?: () => Date
  schedule?: Partial<WarmupSchedule>
  /** Substitui gates específicos (os demais usam o default). */
  gates?: Partial<Record<GateName, Gate>>
}

export class SendPipeline {
  readonly gates: Readonly<Record<GateName, Gate>>
  readonly limits: SessionLimitsService
  private readonly sessions: SessionStore
  readonly consent: ConsentService

  constructor(private readonly opts: SendPipelineOptions) {
    this.sessions = new SessionStore(opts.db)
    this.consent = opts.consent ?? new ConsentService(opts.db)
    const limitOpts: ConstructorParameters<typeof SessionLimitsService>[1] = {}
    if (opts.now) limitOpts.now = opts.now
    if (opts.schedule) limitOpts.schedule = opts.schedule
    this.limits = opts.limits ?? new SessionLimitsService(opts.db, limitOpts)
    this.gates = { ...this.defaultGates(), ...stripUndefined(opts.gates ?? {}) }
  }

  /** Roda todos os gates em ordem; devolve o contexto. Primeira rejeição interrompe (lança SendRejectedError). */
  async runGates(req: SendRequest, ctx: SendContext = {}): Promise<SendContext> {
    for (const name of GATE_ORDER) {
      try {
        await this.gates[name](req, ctx)
      } catch (err) {
        if (err instanceof SendRejectedError) err.gate ??= name
        throw err
      }
    }
    return ctx
  }

  /**
   * Envia (enfileira) passando por todos os gates. Resolve com a mensagem `queued` produzida pelo gate enqueue
   * (um gate enqueue substituído que não preenche `ctx.message` resolve com undefined).
   */
  async send(req: SendRequest): Promise<MessageView> {
    const ctx = await this.runGates(req)
    return ctx.message as MessageView
  }

  async sendGroup(req: { sessionId: string; groupId: string; content: OutgoingContent; actor: string }): Promise<MessageView> {
    if (!/^[^\s@]+@g\.us$/.test(req.groupId)) throw new SendRejectedError('VALIDATION_ERROR', 'invalid group id')
    return this.send({ ...req, phone: req.groupId })
  }

  private defaultGates(): Record<GateName, Gate> {
    return {
      auth: async (req) => {
        if (!req.actor || !req.actor.trim()) throw new SendRejectedError('UNAUTHORIZED', 'authenticated actor required')
      },
      sessionExists: async (req, ctx) => {
        const session = await this.sessions.find(req.sessionId)
        if (!session) throw new SendRejectedError('SESSION_NOT_FOUND', `session ${req.sessionId} not found`)
        ctx.session = session
      },
      connected: async (req, ctx) => {
        const session = ctx.session ?? (await this.sessions.get(req.sessionId))
        if (!SENDABLE_STATES.includes(session.status)) {
          throw new SendRejectedError('SESSION_NOT_CONNECTED', `session ${req.sessionId} is ${session.status}`, { state: session.status })
        }
        if (this.opts.getTransport) {
          const transport = this.opts.getTransport(req.sessionId)
          if (!transport) throw new SendRejectedError('SESSION_NOT_CONNECTED', `session ${req.sessionId} has no open connection`, { state: session.status })
          ctx.transport = transport
        }
      },
      contactAllowed: async (req, ctx) => {
        if (req.groupId) {
          if (req.phone !== req.groupId || !/^[^\s@]+@g\.us$/.test(req.groupId) || req.contactId) {
            throw new SendRejectedError('VALIDATION_ERROR', 'invalid group recipient')
          }
          const transport = ctx.transport ?? this.opts.getTransport?.(req.sessionId)
          if (!transport) throw new SendRejectedError('SESSION_NOT_CONNECTED', 'group transport unavailable')
          const group = (await transport.fetchGroups()).find((g) => g.id === req.groupId)
          if (!group || (group.announce && !group.isAdmin)) throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'not a member or group only allows admins to send')
          return
        }
        const contact = await this.consent.find(req.phone)
        const verdict = canMessage(contact)
        if (!verdict.ok) throw new SendRejectedError('CONTACT_NOT_ALLOWED', `contact not allowed: ${verdict.reason}`, { reason: verdict.reason })
        ctx.contact = contact!
      },
      warmupLimit: async (req, ctx) => {
        const session = ctx.session ?? (await this.sessions.get(req.sessionId))
        const limits = (ctx.limits ??= await this.limits.view(session))
        const limit = limits.effective.warmupDailyLimit
        if (limit === null || !limits.warmup.dayStartedAt) return
        const sent = await this.limits.countOutbound(req.sessionId, new Date(new Date(limits.warmup.dayStartedAt).getTime() - 1))
        if (sent >= limit) {
          throw new SendRejectedError('WARMUP_LIMIT', `warm-up daily limit reached (${sent}/${limit}, day ${limits.warmup.day})`, {
            limit,
            sent,
            day: limits.warmup.day,
          })
        }
      },
      rateLimit: async (req, ctx) => {
        const session = ctx.session ?? (await this.sessions.get(req.sessionId))
        const limits = (ctx.limits ??= await this.limits.view(session))
        const now = this.limits.nowDate().getTime()
        const windows = [
          { window: 'minute', ms: 60_000, limit: limits.effective.perMinute },
          { window: 'hour', ms: 3_600_000, limit: limits.effective.perHour },
          { window: 'day', ms: 86_400_000, limit: limits.effective.perDay },
        ] as const
        for (const w of windows) {
          const sent = await this.limits.countOutbound(req.sessionId, new Date(now - w.ms))
          if (sent >= w.limit) {
            throw new SendRejectedError('RATE_LIMIT', `rate limit reached: ${sent}/${w.limit} per ${w.window}`, { window: w.window, limit: w.limit, sent })
          }
        }
      },
      enqueue: async (req, ctx) => {
        if (!this.opts.queue) throw new Error('message queue not configured')
        const input: EnqueueMessageInput = { sessionId: req.sessionId, phone: req.phone, content: req.content }
        const contactId = req.contactId ?? ctx.contact?.id
        if (contactId) input.contactId = contactId
        ctx.message = await this.opts.queue.enqueue(input)
      },
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

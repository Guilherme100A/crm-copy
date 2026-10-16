// Processador dos webhooks de entrada (T81; 09 §3.2, §3.3, §5): um job `inbound-webhooks` por request aceito.
// Ordem (09 §5): amostra para quem escuta → dedupe (mesmo corpo em 10 min = `duplicate_payload`) → resolve_customer
// (cria ou atualiza por telefone/e-mail; conflito de unicidade = falha) → identity_fields → custom_fields →
// resolve_connection (fixa ou por variável, 8 últimos dígitos; ambígua/inexistente não dispara) → tags → kanban →
// condições (antes de cancelar o fluxo atual) → trigger_flow (cancela o fluxo do lead e inicia o novo).
// Cada passo grava `{ step, status: ok|failed|skipped, reason? }`; o request termina `processed|failed|skipped` com
// `error`, `reason` e `processed_at`.
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { connections, contacts, inboundWebhookRequests, inboundWebhooks, kanbanCards, labels, type Database, type InboundWebhookStep } from '@crm/db'
import type { WaGateway } from '@crm/wa-port'
import type { RealtimePublisher } from '../realtime/publisher'
import { ContactsError } from '../contacts/errors'
import { normalizeContactEmail, normalizeContactPhone } from '../contacts/normalize'
import { ContactsService, type ContactDto } from '../contacts/service'
import { inboundWebhookConfigSchema, type InboundWebhookConfig } from '../inbound-webhooks/config'
import { inboundWebhookJobId, type InboundWebhookJobData } from '../inbound-webhooks/service'
import { createKanbanCard, KanbanService, systemActor } from '../kanban/service'
import { ensureChat } from '../mass-dispatch-runner/starter'
import { conditionsMet, digitsOf, renderVars, resolveSegments } from './mapping'
import { SampleListeners, type SampleRedis } from './samples'

/** Janela do dedupe por corpo idêntico (09 §5). */
export const INBOUND_DEDUPE_WINDOW_MS = 10 * 60_000
/** Request `pending` mais velho que isto é reenfileirado pela varredura (enqueue que falhou na recepção). */
export const INBOUND_SWEEP_AFTER_MS = 60_000

export const INBOUND_STEPS = ['resolve_customer', 'identity_fields', 'custom_fields', 'resolve_connection', 'tags', 'kanban', 'trigger_flow'] as const
export type InboundStepName = (typeof INBOUND_STEPS)[number]

export interface InboundProcessResult {
  status: 'processed' | 'failed' | 'skipped' | 'noop'
  steps: InboundWebhookStep[]
  error: string | null
  reason: string | null
}

export interface InboundWebhookProcessorOptions {
  db: Database
  /** Inicia o fluxo (FlowEngine; no worker, com `enqueue` do flow-step). */
  engine?: { startRun(ctx: { companyId: string }, input: { flowId: string; contactId: string; chatId?: string | null; trigger?: Record<string, unknown> | null; vars?: Record<string, unknown> }): Promise<unknown> }
  /** Cancela o fluxo em andamento do lead antes de disparar. */
  control?: { cancelForContact(ctx: { companyId: string }, contactId: string): Promise<unknown> }
  /** Realtime (`webhook.sample_received` para quem escuta; `contact.updated` etc. dos serviços). */
  publisher?: Pick<RealtimePublisher, 'publish'>
  /** Ouvintes da escuta de amostra (Redis). Sem ele, não publica amostras. */
  redis?: SampleRedis
  /**
   * Fronteira WhatsApp do processo: o contato criado pelo webhook tem o consentimento (`webhook`, SPEC 10.1 nº 1)
   * repassado ao gateway, senão o gate de envio recusa a mensagem do fluxo (`contact_not_found`).
   */
  waGateway?: Pick<WaGateway, 'recordConsent'>
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void }
}

type Req = typeof inboundWebhookRequests.$inferSelect
type Hook = typeof inboundWebhooks.$inferSelect
type ConnRow = { id: string; phoneNumber: string | null; connectionState: string | null }

class StepFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** Reasons que não explicam nada sobre o request (não sobem para `reason`). */
const QUIET_REASONS = new Set(['not_configured', 'unchanged'])

export class InboundWebhookProcessor {
  constructor(private readonly opts: InboundWebhookProcessorOptions) {}

  /**
   * Contato novo do webhook: consentimento com origem `webhook` no CRM (a T26 grava `manual` na criação) e no gateway.
   * O ContactsService fica sem gateway de propósito, para não repassar um consentimento `manual`.
   */
  private async recordWebhookConsent(companyId: string, contact: ContactDto): Promise<void> {
    await this.db.update(contacts).set({ consent: true, consentSource: 'webhook' }).where(and(eq(contacts.companyId, companyId), eq(contacts.id, contact.id)))
    if (contact.phone_e164) await this.opts.waGateway?.recordConsent({ phone: contact.phone_e164, source: 'webhook', name: contact.name || null })
  }

  private get db() {
    return this.opts.db
  }

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  /** Processa um request (idempotente: só `pending` é processado). */
  async process(data: InboundWebhookJobData): Promise<InboundProcessResult> {
    const [req] = await this.db
      .select()
      .from(inboundWebhookRequests)
      .where(and(eq(inboundWebhookRequests.id, data.requestId), eq(inboundWebhookRequests.companyId, data.companyId)))
      .limit(1)
    if (!req || req.processingStatus !== 'pending') return { status: 'noop', steps: req?.steps ?? [], error: req?.error ?? null, reason: req?.reason ?? null }
    const [hook] = await this.db.select().from(inboundWebhooks).where(eq(inboundWebhooks.id, req.webhookId)).limit(1)
    if (!hook) return { status: 'noop', steps: [], error: null, reason: null }

    await this.publishSample(hook, req)

    if (!hook.active) return this.finish(req, { status: 'skipped', steps: [], error: 'webhook_inactive', reason: 'webhook_inactive' })
    if (await this.isDuplicate(req)) return this.finish(req, { status: 'skipped', steps: [], error: 'duplicate_payload', reason: 'duplicate_payload' })

    const parsed = inboundWebhookConfigSchema.safeParse(hook.config ?? {})
    const config: InboundWebhookConfig = parsed.success ? parsed.data : {}
    let body: unknown
    try {
      body = req.rawBody ? JSON.parse(req.rawBody) : {}
    } catch {
      body = {}
    }
    try {
      return await this.finish(req, await this.run(hook, req, config, body))
    } catch (err) {
      this.opts.logger?.warn({ err, requestId: req.id }, 'inbound-webhooks: falha inesperada')
      return this.finish(req, { status: 'failed', steps: [{ step: 'error', status: 'failed', reason: err instanceof Error ? err.message.slice(0, 200) : 'generic' }], error: 'processing_error', reason: 'processing_error' })
    }
  }

  /** Reenfileira os `pending` mais velhos que `olderThanMs` (o enqueue da recepção falhou). Mesmo jobId: sem duplicar. */
  async sweepPending(opts: { olderThanMs?: number; limit?: number }, enqueue: (data: InboundWebhookJobData, opts: { jobId: string }) => Promise<void>): Promise<number> {
    const before = new Date(this.now().getTime() - (opts.olderThanMs ?? INBOUND_SWEEP_AFTER_MS))
    const rows = await this.db
      .select({ id: inboundWebhookRequests.id, webhookId: inboundWebhookRequests.webhookId, companyId: inboundWebhookRequests.companyId })
      .from(inboundWebhookRequests)
      .where(and(eq(inboundWebhookRequests.processingStatus, 'pending'), lt(inboundWebhookRequests.createdAt, before)))
      .orderBy(asc(inboundWebhookRequests.seq))
      .limit(opts.limit ?? 100)
    for (const r of rows) await enqueue({ requestId: r.id, webhookId: r.webhookId, companyId: r.companyId }, { jobId: inboundWebhookJobId(r.id) })
    return rows.length
  }

  // ------------------------------------------------------------------ passos

  private async run(hook: Hook, req: Req, config: InboundWebhookConfig, body: unknown): Promise<Omit<InboundProcessResult, 'status'> & { status: 'processed' | 'failed' }> {
    const steps: InboundWebhookStep[] = []
    const ok = (step: InboundStepName) => steps.push({ step, status: 'ok' })
    const skip = (step: InboundStepName, reason: string) => steps.push({ step, status: 'skipped', reason })
    const failStep = (step: InboundStepName, reason: string) => steps.push({ step, status: 'failed', reason })
    const skipRest = (from: InboundStepName, reason: string) => {
      for (const s of INBOUND_STEPS.slice(INBOUND_STEPS.indexOf(from))) skip(s, reason)
    }
    const contactsSvc = new ContactsService({ db: this.db })

    // 1. resolve_customer
    const name = resolveSegments(body, config.field_paths?.full_name)
    const phoneRaw = resolveSegments(body, config.field_paths?.phone)
    const emailRaw = resolveSegments(body, config.field_paths?.email)
    if (!name || !phoneRaw) {
      failStep('resolve_customer', 'missing_required_fields')
      skipRest('identity_fields', 'customer_not_resolved')
      return { status: 'failed', steps, error: 'missing_required_fields', reason: 'missing_required_fields' }
    }
    let contact: ContactDto
    let created = false
    let phase: 'resolve_customer' | 'identity_fields' = 'resolve_customer'
    try {
      const phone = normalizeContactPhone(phoneRaw)
      const email = emailRaw ? normalizeContactEmail(emailRaw) : null
      const found = await this.findContact(hook.companyId, phone, email)
      // E-mail é único por contato no produto de referência (09 §3.3 `unique_constraint`): e-mail de OUTRO contato falha.
      if (email) {
        const owner = await this.emailOwner(hook.companyId, email)
        if (owner && found && owner !== found) throw new ContactsError('conflict', 'E-mail já usado por outro contato', { id: owner, field: 'email' })
      }
      if (found) contact = await contactsSvc.get(hook.companyId, found)
      else {
        contact = await contactsSvc.create(hook.companyId, { name, phone, email }, {}, 'webhook')
        created = true
        await this.recordWebhookConsent(hook.companyId, contact)
      }
      ok('resolve_customer')
      phase = 'identity_fields'
      // 2. identity_fields (contato existente: nome, telefone e e-mail do payload)
      if (created) skip('identity_fields', 'unchanged')
      else {
        const patch: { name?: string; phone?: string; email?: string } = {}
        if (contact.name !== name) patch.name = name
        if (contact.phone_e164 !== phone) patch.phone = phone
        if (email && contact.email !== email) patch.email = email
        if (Object.keys(patch).length) {
          contact = await contactsSvc.update(hook.companyId, contact.id, patch)
          ok('identity_fields')
        } else skip('identity_fields', 'unchanged')
      }
    } catch (err) {
      const reason = err instanceof ContactsError ? (err.code === 'conflict' ? 'unique_constraint' : err.code === 'validation' ? 'invalid_customer_data' : err.code) : 'generic'
      // Conflito na criação (resolve_customer) ou na atualização da identidade (e-mail/telefone de outro contato).
      failStep(phase, reason)
      skipRest(phase === 'resolve_customer' ? 'identity_fields' : 'custom_fields', 'customer_not_resolved')
      return { status: 'failed', steps, error: 'step_failed', reason }
    }

    // 3. custom_fields
    const values: Record<string, unknown> = {}
    for (const m of config.custom_field_mappings ?? []) {
      const v = resolveSegments(body, m.segments)
      if (m.field_key?.trim() && v) values[m.field_key.trim().toLowerCase()] = v
    }
    if (!Object.keys(values).length) skip('custom_fields', 'not_configured')
    else {
      try {
        contact = await contactsSvc.update(hook.companyId, contact.id, { customFields: { ...contact.custom_fields, ...values } })
        ok('custom_fields')
      } catch (err) {
        failStep('custom_fields', err instanceof ContactsError ? `invalid_custom_fields` : 'generic')
      }
    }

    // 4. resolve_connection
    const conn = await this.resolveConnection(hook, config, body)
    let connection: ConnRow | null = null
    let connBlock: string | null = null
    if ('reason' in conn) {
      skip('resolve_connection', conn.reason)
      connBlock = conn.reason
    } else {
      connection = conn.connection
      ok('resolve_connection')
      if (connection.connectionState !== 'open') connBlock = 'skipped_due_to_disconnected_connection'
    }
    let chatId: string | null = null
    const chat = async () => (chatId ??= await ensureChat(this.db, hook.companyId, connection!.id, contact.id))

    // 5. tags
    const addTags = (config.add_tags ?? []).map((t) => t.trim()).filter(Boolean)
    const removeTags = (config.remove_tags ?? []).map((t) => t.trim()).filter(Boolean)
    if (!addTags.length && !removeTags.length) skip('tags', 'not_configured')
    else if (connBlock) skip('tags', connBlock)
    else {
      const wanted = [...new Set([...addTags, ...removeTags].map((t) => t.toLowerCase()))]
      const rows = await this.db
        .select({ id: labels.id, name: labels.name })
        .from(labels)
        .where(and(eq(labels.companyId, hook.companyId), inArray(sql`lower(${labels.name})`, wanted)))
      const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]))
      const missing = [...addTags, ...removeTags].filter((t) => !byName.has(t.toLowerCase()))
      const current = new Set(contact.labels.map((l) => l.id))
      for (const t of addTags) if (byName.has(t.toLowerCase())) current.add(byName.get(t.toLowerCase())!)
      for (const t of removeTags) if (byName.has(t.toLowerCase())) current.delete(byName.get(t.toLowerCase())!)
      const changed = current.size !== contact.labels.length || contact.labels.some((l) => !current.has(l.id))
      if (changed) contact = await contactsSvc.update(hook.companyId, contact.id, { labelIds: [...current] })
      if (missing.length) failStep('tags', `labels_not_found:${[...new Set(missing)].join(',')}`)
      else ok('tags')
    }

    // 6. kanban
    const actions = config.kanban_actions ?? []
    if (!actions.length) skip('kanban', 'not_configured')
    else if (connBlock) skip('kanban', connBlock)
    else {
      try {
        const kanban = new KanbanService({ db: this.db, ...(this.opts.publisher ? { publisher: this.opts.publisher as RealtimePublisher } : {}) })
        const chatIdNow = await chat()
        for (const a of actions) {
          if (a.action === 'create_kanban_card') {
            if (!a.crm_column_id) throw new StepFailure('kanban_apply_failed:column_required')
            const raw = a.value === null || a.value === undefined ? '' : typeof a.value === 'number' ? String(a.value) : renderVars(body, String(a.value))
            const n = raw ? Number(raw.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) : NaN
            await createKanbanCard(kanban, { companyId: hook.companyId }, { crmId: a.crm_id, columnId: a.crm_column_id, chatId: chatIdNow, ...(Number.isFinite(n) ? { valueCents: Math.round(n * 100) } : {}) })
          } else {
            const cards = await this.db
              .select({ id: kanbanCards.id, columnId: kanbanCards.columnId })
              .from(kanbanCards)
              .where(and(eq(kanbanCards.companyId, hook.companyId), eq(kanbanCards.crmId, a.crm_id), eq(kanbanCards.chatId, chatIdNow)))
            for (const card of cards) if (!a.crm_column_id || card.columnId === a.crm_column_id) await kanban.deleteCard(systemActor(hook.companyId), a.crm_id, card.id)
          }
        }
        ok('kanban')
      } catch (err) {
        failStep('kanban', err instanceof StepFailure ? err.reason : `kanban_apply_failed:${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
      }
    }

    // 7. condições + trigger_flow
    if (!config.trigger_flow || !config.flow_id) skip('trigger_flow', config.trigger_flow ? 'invalid_flow_config' : 'not_configured')
    else if (connBlock) skip('trigger_flow', connBlock)
    else {
      const fresh = await contactsSvc.get(hook.companyId, contact.id)
      const subject = {
        name: fresh.name,
        phone: fresh.phone_e164 ?? '',
        email: fresh.email ?? '',
        customFields: Object.fromEntries(Object.entries(fresh.custom_fields).map(([k, v]) => [k.toLowerCase(), v])),
        labels: new Set(fresh.labels.map((l) => l.name.trim().toLowerCase())),
      }
      if (!conditionsMet(config.trigger_conditions, subject)) skip('trigger_flow', 'conditions_not_met')
      else if (!this.opts.engine) failStep('trigger_flow', 'invalid_flow_config')
      else {
        try {
          const chatIdNow = await chat()
          await this.opts.control?.cancelForContact({ companyId: hook.companyId }, contact.id)
          await this.opts.engine.startRun(
            { companyId: hook.companyId },
            { flowId: config.flow_id, contactId: contact.id, chatId: chatIdNow, trigger: { type: 'inbound_webhook', webhook_id: hook.id, request_id: req.id }, vars: { webhook: body } },
          )
          ok('trigger_flow')
        } catch (err) {
          this.opts.logger?.warn({ err, requestId: req.id }, 'inbound-webhooks: fluxo não iniciado')
          failStep('trigger_flow', 'invalid_flow_config')
        }
      }
    }

    const failed = steps.find((s) => s.status === 'failed')
    const reason = failed?.reason ?? steps.find((s) => s.status === 'skipped' && s.reason && !QUIET_REASONS.has(s.reason))?.reason ?? null
    return { status: failed ? 'failed' : 'processed', steps, error: failed ? 'step_failed' : null, reason }
  }

  // ------------------------------------------------------------------ apoio

  private async findContact(companyId: string, phone: string, email: string | null): Promise<string | null> {
    const [byPhone] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.phoneE164, phone)))
      .limit(1)
    if (byPhone) return byPhone.id
    return email ? this.emailOwner(companyId, email) : null
  }

  private async emailOwner(companyId: string, email: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), sql`lower(${contacts.email}) = ${email.toLowerCase()}`))
      .limit(1)
    return row?.id ?? null
  }

  /** Conexão fixa do webhook ou pelo "número que dispara" (número ou `{variável}`), pelos 8 últimos dígitos. */
  private async resolveConnection(hook: Hook, config: InboundWebhookConfig, body: unknown): Promise<{ connection: ConnRow } | { reason: string }> {
    const legacy = config.connection_source === 'payload' && config.connection_path ? `{${config.connection_path}}` : null
    const value = (config.connection_value ?? legacy ?? '').trim()
    const cols = { id: connections.id, phoneNumber: connections.phoneNumber, connectionState: connections.connectionState }
    if (!value) {
      if (!hook.connectionId) return { reason: 'no_connection' }
      const [c] = await this.db.select(cols).from(connections).where(and(eq(connections.companyId, hook.companyId), eq(connections.id, hook.connectionId))).limit(1)
      return c ? { connection: c } : { reason: 'connection_not_resolved:not_found' }
    }
    const digits = digitsOf(renderVars(body, value))
    if (digits.length < 8) return { reason: 'connection_not_resolved:too_short' }
    const tail = digits.slice(-8)
    const rows = await this.db.select(cols).from(connections).where(eq(connections.companyId, hook.companyId))
    const matches = rows.filter((r) => r.phoneNumber && digitsOf(r.phoneNumber).slice(-8) === tail)
    if (!matches.length) return { reason: 'connection_not_resolved:not_found' }
    if (matches.length > 1) return { reason: 'connection_not_resolved:ambiguous' }
    return { connection: matches[0]! }
  }

  private async isDuplicate(req: Req): Promise<boolean> {
    if (!req.bodyHash) return false
    const since = new Date(req.createdAt.getTime() - INBOUND_DEDUPE_WINDOW_MS)
    const [dup] = await this.db
      .select({ id: inboundWebhookRequests.id })
      .from(inboundWebhookRequests)
      .where(
        and(
          eq(inboundWebhookRequests.webhookId, req.webhookId),
          eq(inboundWebhookRequests.bodyHash, req.bodyHash),
          lt(inboundWebhookRequests.seq, req.seq),
          gte(inboundWebhookRequests.createdAt, since),
        ),
      )
      .limit(1)
    return Boolean(dup)
  }

  private async publishSample(hook: Hook, req: Req): Promise<void> {
    if (!this.opts.redis || !this.opts.publisher) return
    try {
      const users = await new SampleListeners(this.opts.redis, { now: () => this.now() }).take(hook.id)
      for (const userId of users)
        await this.opts.publisher.publish(
          hook.companyId,
          'webhook.sample_received',
          { webhook_id: hook.id, request_id: req.id, request: { raw_body: req.rawBody, raw_body_truncated: req.rawBodyTruncated } } as never,
          { userId } as never,
        )
    } catch (err) {
      this.opts.logger?.warn({ err, webhookId: hook.id }, 'inbound-webhooks: falha ao publicar a amostra')
    }
  }

  private async finish(req: Req, r: Omit<InboundProcessResult, 'status'> & { status: 'processed' | 'failed' | 'skipped' }): Promise<InboundProcessResult> {
    const now = this.now()
    await this.db
      .update(inboundWebhookRequests)
      .set({ processingStatus: r.status, steps: r.steps, error: r.error, reason: r.reason, processedAt: now, updatedAt: now })
      .where(and(eq(inboundWebhookRequests.id, req.id), eq(inboundWebhookRequests.processingStatus, 'pending')))
    return r
  }
}

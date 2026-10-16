// CapiService (T104; STACK E §1.7; 11 §5.4): envia eventos de servidor (Purchase/Lead) à Conversions API da Meta.
// - Só eventos de site/servidor: `action_source` é `chat` ou `system_generated` — NUNCA `business_messaging` nem campos
//   de WABA (`messaging_channel`, `page_id`, `ctwa_clid`), que exigem a CAPI for Business Messaging (AC-T104-05).
// - Dedupe por (pixel, `event_id`) em `capi_event_log`: o mesmo `event_id` de novo não faz outro POST (AC-T104-02);
//   um envio que falhou pode ser repetido com o mesmo id.
// - `fetch` próprio (não o GraphClient): o token CAPI do pixel não usa `appsecret_proof`.
// - `test_event_code` (`META_CAPI_TEST_EVENT_CODE` ou o da config) só fora de produção.
// Escreve só no executor recebido (`db`): dentro de um passo de fluxo é a transação do passo (`ctx.repo.db`).
import { and, eq, sql } from 'drizzle-orm'
import { capiEventLog, contacts, pixelConfigs, type Database } from '@crm/db'
import { META_GRAPH_VERSION, parseGraphUrl } from '../meta-ads/client/graph'
import { buildUserData, normalizeCapiCurrency, parseMoney, type CapiUserInput } from './hashing'
import { PixelConfigService } from './pixels'

export const CAPI_EVENT_NAMES = ['Purchase', 'Lead'] as const
export type CapiEventName = (typeof CAPI_EVENT_NAMES)[number]
/** `chat`: conversa no WhatsApp conduzida pelo CRM (nó do fluxo); `system_generated`: venda registrada no CRM. */
export const CAPI_ACTION_SOURCES = ['chat', 'system_generated'] as const
export type CapiActionSource = (typeof CAPI_ACTION_SOURCES)[number]
export type CapiSource = 'flow' | 'sale' | 'manual'

export interface CapiSendInput {
  companyId: string
  pixelConfigId: string
  eventName: CapiEventName
  /** Id estável do evento (dedupe nosso e da Meta). */
  eventId: string
  /** Default: agora. */
  eventTime?: Date
  /** Valor já renderizado ("199,90", 199.9). Obrigatório para Purchase. */
  value?: string | number | null
  /** ISO-4217; vazio/inválido → BRL. */
  currency?: string | null
  user?: CapiUserInput
  actionSource?: CapiActionSource
  source: CapiSource
  sourceId?: string | null
  /** Executor de escrita (transação do passo no fluxo). Default: o `db` do serviço. */
  db?: Database
}

export type CapiSendResult =
  | { status: 'sent'; eventId: string; eventsReceived: number; fbtraceId: string | null }
  | { status: 'duplicate'; eventId: string }
  | { status: 'failed'; eventId: string; error: string }

export class CapiError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation' | 'upstream',
    message: string,
  ) {
    super(message)
    this.name = 'CapiError'
  }
}

export interface CapiServiceOptions {
  db: Database
  /** Base da Graph com ou sem versão (default `META_GRAPH_URL`). */
  graphUrl?: string
  version?: string
  fetch?: typeof globalThis.fetch
  /** Default `META_CAPI_TEST_EVENT_CODE`. Só é enviado quando `isProduction` é falso. */
  testEventCode?: string | null
  /** Default `NODE_ENV === 'production'`. */
  isProduction?: boolean
  pixels?: PixelConfigService
  timeoutMs?: number
  now?: () => Date
}

export class CapiService {
  private readonly graphUrl: string
  private readonly version: string
  private readonly pixels: PixelConfigService

  constructor(private readonly opts: CapiServiceOptions) {
    const parsed = parseGraphUrl(opts.graphUrl ?? process.env.META_GRAPH_URL, META_GRAPH_VERSION)
    this.graphUrl = parsed.graphUrl
    this.version = opts.version ?? parsed.version
    this.pixels = opts.pixels ?? new PixelConfigService({ db: opts.db })
  }

  private get testEventCode(): string | null {
    const production = this.opts.isProduction ?? process.env.NODE_ENV === 'production'
    if (production) return null
    const code = this.opts.testEventCode !== undefined ? this.opts.testEventCode : process.env.META_CAPI_TEST_EVENT_CODE
    return code?.trim() || null
  }

  /** Corpo do POST `/{pixel_id}/events` (sem o token). Exposto para os testes de contrato (AC-T104-05). */
  buildPayload(input: Omit<CapiSendInput, 'companyId' | 'pixelConfigId' | 'source' | 'db'>): Record<string, unknown> {
    const actionSource = input.actionSource ?? 'chat'
    if (!(CAPI_ACTION_SOURCES as readonly string[]).includes(actionSource)) throw new CapiError('validation', `action_source não permitido: ${actionSource}`)
    if (!(CAPI_EVENT_NAMES as readonly string[]).includes(input.eventName)) throw new CapiError('validation', `evento não suportado: ${input.eventName}`)
    const value = parseMoney(input.value)
    if (input.eventName === 'Purchase' && value === null) throw new CapiError('validation', 'valor da compra ausente ou inválido')
    const customData: Record<string, unknown> = { currency: normalizeCapiCurrency(input.currency) }
    if (value !== null) customData.value = value
    const now = input.eventTime ?? this.opts.now?.() ?? new Date()
    const event = {
      event_name: input.eventName,
      event_time: Math.floor(now.getTime() / 1000),
      event_id: input.eventId,
      action_source: actionSource,
      user_data: buildUserData(input.user ?? {}),
      custom_data: customData,
    }
    const code = this.testEventCode
    return { data: [event], ...(code ? { test_event_code: code } : {}) }
  }

  /** Dados do contato para o `user_data` (telefone, e-mail, nome, cidade; `external_id` = id do contato). */
  async userFromContact(companyId: string, contactId: string | null | undefined, db: Database = this.opts.db): Promise<CapiUserInput> {
    if (!contactId) return {}
    const [c] = await db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phoneE164, email: contacts.email, city: contacts.city })
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.id, contactId)))
      .limit(1)
    if (!c) return {}
    const [first, ...rest] = (c.name ?? '').trim().split(/\s+/)
    return { phone: c.phone, email: c.email, externalId: c.id, firstName: first || null, lastName: rest.join(' ') || null, city: c.city }
  }

  async send(input: CapiSendInput): Promise<CapiSendResult> {
    const db = input.db ?? this.opts.db
    const [pixel] = await db
      .select()
      .from(pixelConfigs)
      .where(and(eq(pixelConfigs.companyId, input.companyId), eq(pixelConfigs.id, input.pixelConfigId)))
      .limit(1)
    if (!pixel) throw new CapiError('not_found', 'Pixel não encontrado')
    const payload = this.buildPayload(input)
    const actionSource = input.actionSource ?? 'chat'

    // Dedupe: a primeira gravação do (pixel, event_id) ganha; um anterior `failed` pode reenviar.
    const inserted = await db
      .insert(capiEventLog)
      .values({
        companyId: input.companyId,
        pixelConfigId: pixel.id,
        eventId: input.eventId,
        eventName: input.eventName,
        actionSource,
        status: 'pending',
        source: input.source,
        sourceId: input.sourceId ?? null,
      })
      .onConflictDoNothing({ target: [capiEventLog.pixelConfigId, capiEventLog.eventId] })
      .returning({ id: capiEventLog.id })
    let logId = inserted[0]?.id
    if (!logId) {
      const retried = await db
        .update(capiEventLog)
        .set({ status: 'pending', error: null, updatedAt: sql`now()` })
        .where(and(eq(capiEventLog.pixelConfigId, pixel.id), eq(capiEventLog.eventId, input.eventId), eq(capiEventLog.status, 'failed')))
        .returning({ id: capiEventLog.id })
      logId = retried[0]?.id
      if (!logId) return { status: 'duplicate', eventId: input.eventId }
    }

    const finish = async (status: 'sent' | 'failed', response: Record<string, unknown> | null, error: string | null) => {
      await db.update(capiEventLog).set({ status, response, error, updatedAt: sql`now()` }).where(eq(capiEventLog.id, logId))
    }

    try {
      const token = this.pixels.accessToken(pixel)
      const res = await (this.opts.fetch ?? globalThis.fetch)(`${this.graphUrl}/${this.version}/${pixel.pixelId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: token }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || json.error) {
        const err = (json.error ?? {}) as Record<string, unknown>
        const message = `${String(err.message ?? `HTTP ${res.status}`)}${err.code !== undefined ? ` (code ${String(err.code)})` : ''}`
        await finish('failed', { status: res.status, code: err.code ?? null, fbtrace_id: err.fbtrace_id ?? null }, message)
        return { status: 'failed', eventId: input.eventId, error: message }
      }
      const eventsReceived = Number(json.events_received ?? 0)
      const fbtraceId = typeof json.fbtrace_id === 'string' ? json.fbtrace_id : null
      await finish('sent', { events_received: eventsReceived, fbtrace_id: fbtraceId }, null)
      return { status: 'sent', eventId: input.eventId, eventsReceived, fbtraceId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await finish('failed', null, message)
      return { status: 'failed', eventId: input.eventId, error: message }
    }
  }
}

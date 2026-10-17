// CapiService (T104; revisão 3 — paridade de rastreamento com o Leona): envia eventos de servidor à Conversions API.
// Doc oficial (consultada em 2026-10-17):
//   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event
//   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
//   https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
//   https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api
//   https://developers.facebook.com/docs/marketing-api/reference/ads-pixel/events/ (resposta events_received/messages/fbtrace_id)
// Regras:
// - Modo padrão: `action_source` `chat` (conversa no WhatsApp) ou `system_generated` (venda registrada), `user_data`
//   com os identificadores hasheados (hashing.ts).
// - Modo "mensagem de anúncio" (revisão 3, AC-T104-05 revisado): contato com `ctwa_clid` + pixel com WABA id ou
//   `page_id` + evento suportado pela CAPI for Business Messaging → `action_source: business_messaging`,
//   `messaging_channel: whatsapp`, `user_data: { whatsapp_business_account_id | page_id, ctwa_clid }`. A doc lista
//   `LeadSubmitted` (não `Lead`) entre os eventos suportados, então Lead vira LeadSubmitted nesse modo. A doc só traz
//   `whatsapp_business_account_id` para WhatsApp; `page_id` sem WABA é o que o Leona faz e NÃO está confirmado pela doc.
// - Fallback: se a Meta recusar o business_messaging (erro 4xx da Graph), o MESMO evento (mesmo `event_id`) vai no modo
//   padrão; o log guarda a recusa e qual modo foi aceito. O pixel guarda o último resultado e, depois de uma recusa,
//   só tenta business_messaging de novo após `BM_RETRY_AFTER_MS` (24 h).
// - `event_time` com mais de 7 dias: a Meta recusa o lote inteiro → não enviamos; o log fica `discarded` com o motivo
//   e o evento nunca é reenviado.
// - Dedupe por (pixel, `event_id`) em `capi_event_log`: o mesmo `event_id` de novo não faz outro POST (AC-T104-02);
//   um envio que falhou pode ser repetido com o mesmo id.
// - `test_event_code`: o do pixel (vale também em produção, só para ele) ou o do env (`META_CAPI_TEST_EVENT_CODE`), este
//   só fora de produção. Vai no nível do corpo, ao lado de `data`.
// - `fetch` próprio (não o GraphClient): o token CAPI do pixel não usa `appsecret_proof`.
// Escreve só no executor recebido (`db`): dentro de um passo de fluxo é a transação do passo (`ctx.repo.db`).
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { capiEventLog, contactAttribution, contacts, pixelConfigs, trackedLinkClicks, type Database } from '@crm/db'
import { META_GRAPH_VERSION, parseGraphUrl } from '../meta-ads/client/graph'
import { buildUserData, matchScore, normalizeCapiCurrency, parseMoney, type CapiUserInput } from './hashing'
import { PixelConfigService } from './pixels'

/** Eventos padrão da Meta aceitos pelo CRM (nó Pixel, vendas, Lead automático). */
export const CAPI_EVENT_NAMES = ['Purchase', 'Lead', 'InitiateCheckout', 'AddToCart', 'CompleteRegistration', 'Contact', 'Schedule', 'Subscribe'] as const
export type CapiEventName = (typeof CAPI_EVENT_NAMES)[number]
/** Origens do modo padrão: `chat` (conversa no WhatsApp) e `system_generated` (venda registrada no CRM). */
export const CAPI_ACTION_SOURCES = ['chat', 'system_generated'] as const
export type CapiActionSource = (typeof CAPI_ACTION_SOURCES)[number]
export type CapiMode = CapiActionSource | 'business_messaging'
export type CapiSource = 'flow' | 'sale' | 'manual' | 'ad_lead'

/**
 * Nome do evento no modo business_messaging (lista "supported events" da doc de Business Messaging). Ausente = não
 * suportado nesse modo → vai no modo padrão.
 */
export const BM_EVENT_NAMES: Readonly<Partial<Record<CapiEventName, string>>> = {
  Purchase: 'Purchase',
  Lead: 'LeadSubmitted',
  InitiateCheckout: 'InitiateCheckout',
  AddToCart: 'AddToCart',
}

/** "The event_time can be up to 7 days before you send an event" (server-event). */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Depois de uma recusa do business_messaging, reteste após 24 h. */
export const BM_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

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
  /** Página do Facebook só deste evento (campo opcional do nó Pixel, como no Leona); sobrepõe a do pixel. */
  pageId?: string | null
  /** WABA id só deste evento (nó Pixel); sobrepõe o do pixel. */
  wabaId?: string | null
}

export type CapiSendResult =
  | { status: 'sent'; eventId: string; eventsReceived: number; fbtraceId: string | null; mode: CapiMode; fallback: boolean }
  | { status: 'duplicate'; eventId: string }
  | { status: 'discarded'; eventId: string; reason: string }
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

/** Alvo do modo business_messaging (ids da conta). */
export interface BmTarget {
  wabaId?: string | null
  pageId?: string | null
}

export interface PayloadOptions {
  /** Com alvo e `user.ctwaClid`: payload business_messaging. */
  businessMessaging?: BmTarget | null
  /** Código de teste já resolvido (sobrepõe o do env). */
  testEventCode?: string | null
}

type PixelRow = typeof pixelConfigs.$inferSelect
type Attempt = { ok: true; eventsReceived: number; fbtraceId: string | null; messages: unknown } | { ok: false; status: number | null; code: unknown; fbtraceId: unknown; message: string; graph: boolean }

const DAY_MS = 24 * 60 * 60 * 1000

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

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /** Código de teste do env: só fora de produção. */
  private get envTestEventCode(): string | null {
    const production = this.opts.isProduction ?? process.env.NODE_ENV === 'production'
    if (production) return null
    const code = this.opts.testEventCode !== undefined ? this.opts.testEventCode : process.env.META_CAPI_TEST_EVENT_CODE
    return code?.trim() || null
  }

  /** Código de teste do pixel (vale em produção) ou, sem ele, o do env fora de produção. */
  testEventCodeFor(pixel: Pick<PixelRow, 'testEventCode'> | null | undefined): string | null {
    return pixel?.testEventCode?.trim() || this.envTestEventCode
  }

  /**
   * Corpo do POST `/{pixel_id}/events` (sem o token). Exposto para os testes de contrato.
   * Modo padrão: `action_source` `chat`/`system_generated`. Modo business_messaging: só com `opts.businessMessaging` e
   * `user.ctwaClid`, para eventos suportados (`BM_EVENT_NAMES`).
   */
  buildPayload(input: Omit<CapiSendInput, 'companyId' | 'pixelConfigId' | 'source' | 'db' | 'pageId' | 'wabaId'>,opts: PayloadOptions = {}): Record<string, unknown> {
    const actionSource = input.actionSource ?? 'chat'
    if (!(CAPI_ACTION_SOURCES as readonly string[]).includes(actionSource)) throw new CapiError('validation', `action_source não permitido: ${actionSource}`)
    if (!(CAPI_EVENT_NAMES as readonly string[]).includes(input.eventName)) throw new CapiError('validation', `evento não suportado: ${input.eventName}`)
    const value = parseMoney(input.value)
    if (input.eventName === 'Purchase' && value === null) throw new CapiError('validation', 'valor da compra ausente ou inválido')
    const customData: Record<string, unknown> = { currency: normalizeCapiCurrency(input.currency) }
    if (value !== null) customData.value = value
    const when = input.eventTime ?? this.now()
    const base = { event_time: Math.floor(when.getTime() / 1000), event_id: input.eventId }
    const bm = opts.businessMessaging
    const bmName = BM_EVENT_NAMES[input.eventName]
    let event: Record<string, unknown>
    if (bm && bmName && input.user?.ctwaClid && (bm.wabaId || bm.pageId)) {
      const userData: Record<string, unknown> = {}
      if (bm.wabaId) userData.whatsapp_business_account_id = bm.wabaId
      else userData.page_id = bm.pageId
      userData.ctwa_clid = input.user.ctwaClid
      event = { event_name: bmName, ...base, action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: userData, custom_data: customData }
    } else {
      event = { event_name: input.eventName, ...base, action_source: actionSource, user_data: buildUserData({ ...(input.user ?? {}), ctwaClid: null }), custom_data: customData }
    }
    const code = opts.testEventCode !== undefined ? opts.testEventCode : this.envTestEventCode
    return { data: [event], ...(code ? { test_event_code: code } : {}) }
  }

  /** Alvo business_messaging do pixel para este evento, ou null (sem ids, sem ctwa_clid, evento não suportado ou recusa recente). */
  bmTargetFor(pixel: Pick<PixelRow, 'pageId' | 'whatsappBusinessAccountId' | 'bmStatus' | 'bmCheckedAt'>, eventName: CapiEventName, ctwaClid: string | null | undefined): BmTarget | null {
    if (!ctwaClid || !BM_EVENT_NAMES[eventName]) return null
    if (!pixel.whatsappBusinessAccountId && !pixel.pageId) return null
    if (pixel.bmStatus === 'rejected' && pixel.bmCheckedAt && this.now().getTime() - pixel.bmCheckedAt.getTime() < BM_RETRY_AFTER_MS) return null
    return { wabaId: pixel.whatsappBusinessAccountId, pageId: pixel.pageId }
  }

  /**
   * Dados do contato para o `user_data`: telefone, e-mail, nome, cidade, UF, CEP, `external_id` (id do contato),
   * `ctwa_clid` (último toque de anúncio, senão o do contato) e, do último clique de link rastreável ligado a ele,
   * `fbc`/`fbp`/IP/user agent.
   */
  async userFromContact(companyId: string, contactId: string | null | undefined, db: Database = this.opts.db): Promise<CapiUserInput> {
    if (!contactId) return {}
    const [c] = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        phone: contacts.phoneE164,
        email: contacts.email,
        city: contacts.city,
        state: contacts.state,
        zip: contacts.zip,
        ctwaClid: contacts.ctwaClid,
        lastCtwaClid: contactAttribution.lastCtwaClid,
      })
      .from(contacts)
      .leftJoin(contactAttribution, eq(contactAttribution.contactId, contacts.id))
      .where(and(eq(contacts.companyId, companyId), eq(contacts.id, contactId)))
      .limit(1)
    if (!c) return {}
    const [click] = await db
      .select({ fbc: trackedLinkClicks.fbc, fbp: trackedLinkClicks.fbp, ip: trackedLinkClicks.clientIp, ua: trackedLinkClicks.userAgent })
      .from(trackedLinkClicks)
      .where(and(eq(trackedLinkClicks.companyId, companyId), eq(trackedLinkClicks.contactId, contactId), isNotNull(trackedLinkClicks.matchedAt)))
      .orderBy(desc(trackedLinkClicks.matchedAt))
      .limit(1)
    const [first, ...rest] = (c.name ?? '').trim().split(/\s+/)
    return {
      phone: c.phone,
      email: c.email,
      externalId: c.id,
      firstName: first || null,
      lastName: rest.join(' ') || null,
      city: c.city,
      state: c.state,
      zip: c.zip,
      ctwaClid: c.lastCtwaClid ?? c.ctwaClid ?? null,
      ...(click ? { fbc: click.fbc, fbp: click.fbp, clientIpAddress: click.ip, clientUserAgent: click.ua } : {}),
    }
  }

  async send(input: CapiSendInput): Promise<CapiSendResult> {
    const db = input.db ?? this.opts.db
    const [pixel] = await db
      .select()
      .from(pixelConfigs)
      .where(and(eq(pixelConfigs.companyId, input.companyId), eq(pixelConfigs.id, input.pixelConfigId)))
      .limit(1)
    if (!pixel) throw new CapiError('not_found', 'Pixel não encontrado')
    const actionSource = input.actionSource ?? 'chat'
    const user: CapiUserInput = { ...(input.user ?? {}), defaultCountry: input.user?.defaultCountry ?? pixel.defaultCountry }
    const testCode = this.testEventCodeFor(pixel)
    const standard = this.buildPayload({ ...input, user }, { testEventCode: testCode })
    const ids = { pageId: input.pageId?.trim() || pixel.pageId, whatsappBusinessAccountId: input.wabaId?.trim() || pixel.whatsappBusinessAccountId }
    const bmTarget = this.bmTargetFor({ ...pixel, ...ids }, input.eventName, user.ctwaClid)
    const bmPayload = bmTarget ? this.buildPayload({ ...input, user }, { businessMessaging: bmTarget, testEventCode: testCode }) : null
    const first = (bmPayload ?? standard).data as Record<string, unknown>[]
    const ev = first[0]!
    const fieldsOf = (p: Record<string, unknown>) => Object.keys(((p.data as Record<string, unknown>[])[0]!.user_data ?? {}) as Record<string, unknown>).sort()
    const scoreOf = (p: Record<string, unknown>) => matchScore(((p.data as Record<string, unknown>[])[0]!.user_data ?? {}) as Record<string, unknown>)
    const eventTime = new Date((ev.event_time as number) * 1000)
    const tooOld = this.now().getTime() - eventTime.getTime() > MAX_EVENT_AGE_MS

    const logBase = {
      eventName: input.eventName,
      eventTime,
      identifiers: fieldsOf(bmPayload ?? standard),
      matchScore: scoreOf(bmPayload ?? standard),
      testEvent: Boolean(testCode),
      customData: ev.custom_data as Record<string, unknown>,
    }

    if (tooOld) {
      const reason = 'event_time com mais de 7 dias: a Meta recusa o lote inteiro (server-event), evento não enviado'
      const inserted = await db
        .insert(capiEventLog)
        .values({
          companyId: input.companyId,
          pixelConfigId: pixel.id,
          eventId: input.eventId,
          actionSource: bmPayload ? 'business_messaging' : actionSource,
          status: 'discarded',
          source: input.source,
          sourceId: input.sourceId ?? null,
          error: reason,
          ...logBase,
        })
        .onConflictDoNothing({ target: [capiEventLog.pixelConfigId, capiEventLog.eventId] })
        .returning({ id: capiEventLog.id })
      if (!inserted[0]) {
        const [cur] = await db
          .select({ status: capiEventLog.status })
          .from(capiEventLog)
          .where(and(eq(capiEventLog.pixelConfigId, pixel.id), eq(capiEventLog.eventId, input.eventId)))
        if (cur?.status === 'sent' || cur?.status === 'pending') return { status: 'duplicate', eventId: input.eventId }
        await db
          .update(capiEventLog)
          .set({ status: 'discarded', error: reason, updatedAt: sql`now()` })
          .where(and(eq(capiEventLog.pixelConfigId, pixel.id), eq(capiEventLog.eventId, input.eventId)))
      }
      return { status: 'discarded', eventId: input.eventId, reason }
    }

    // Dedupe: a primeira gravação do (pixel, event_id) ganha; um anterior `failed` pode reenviar.
    const inserted = await db
      .insert(capiEventLog)
      .values({
        companyId: input.companyId,
        pixelConfigId: pixel.id,
        eventId: input.eventId,
        actionSource: bmPayload ? 'business_messaging' : actionSource,
        status: 'pending',
        source: input.source,
        sourceId: input.sourceId ?? null,
        ...logBase,
      })
      .onConflictDoNothing({ target: [capiEventLog.pixelConfigId, capiEventLog.eventId] })
      .returning({ id: capiEventLog.id })
    let logId = inserted[0]?.id
    if (!logId) {
      const retried = await db
        .update(capiEventLog)
        .set({ status: 'pending', error: null, actionSource: bmPayload ? 'business_messaging' : actionSource, ...logBase, updatedAt: sql`now()` })
        .where(and(eq(capiEventLog.pixelConfigId, pixel.id), eq(capiEventLog.eventId, input.eventId), eq(capiEventLog.status, 'failed')))
        .returning({ id: capiEventLog.id })
      logId = retried[0]?.id
      if (!logId) {
        const [cur] = await db
          .select({ status: capiEventLog.status, error: capiEventLog.error })
          .from(capiEventLog)
          .where(and(eq(capiEventLog.pixelConfigId, pixel.id), eq(capiEventLog.eventId, input.eventId)))
        if (cur?.status === 'discarded') return { status: 'discarded', eventId: input.eventId, reason: cur.error ?? 'descartado' }
        return { status: 'duplicate', eventId: input.eventId }
      }
    }

    const finish = async (set: Partial<typeof capiEventLog.$inferInsert>) => {
      await db
        .update(capiEventLog)
        .set({ ...set, updatedAt: sql`now()` })
        .where(eq(capiEventLog.id, logId))
    }
    const markBm = async (status: 'accepted' | 'rejected', error: string | null) => {
      await db.update(pixelConfigs).set({ bmStatus: status, bmCheckedAt: this.now(), bmError: error }).where(eq(pixelConfigs.id, pixel.id))
    }

    let token: string
    try {
      token = this.pixels.accessToken(pixel)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await finish({ status: 'failed', response: null, error: message })
      return { status: 'failed', eventId: input.eventId, error: message }
    }

    let bmRejected: Extract<Attempt, { ok: false }> | null = null
    if (bmPayload) {
      const r = await this.post(pixel.pixelId, token, bmPayload)
      if (r.ok) {
        await markBm('accepted', null)
        await finish({ status: 'sent', actionSource: 'business_messaging', response: { events_received: r.eventsReceived, fbtrace_id: r.fbtraceId, messages: r.messages, mode: 'business_messaging' }, error: null })
        return { status: 'sent', eventId: input.eventId, eventsReceived: r.eventsReceived, fbtraceId: r.fbtraceId, mode: 'business_messaging', fallback: false }
      }
      // Recusa da Graph (4xx com erro): fallback no modo padrão. Rede/5xx: falha retentável, sem fallback.
      if (!r.graph || r.status === null || r.status >= 500) {
        await finish({ status: 'failed', response: { status: r.status, code: r.code ?? null, fbtrace_id: r.fbtraceId ?? null, mode: 'business_messaging' }, error: r.message })
        return { status: 'failed', eventId: input.eventId, error: r.message }
      }
      bmRejected = r
    }

    const r = await this.post(pixel.pixelId, token, standard)
    const bmInfo = bmRejected ? { business_messaging: { rejected: true, status: bmRejected.status, code: bmRejected.code ?? null, fbtrace_id: bmRejected.fbtraceId ?? null, error: bmRejected.message } } : {}
    if (r.ok) {
      if (bmRejected) await markBm('rejected', bmRejected.message)
      await finish({
        status: 'sent',
        actionSource,
        identifiers: fieldsOf(standard),
        matchScore: scoreOf(standard),
        response: { events_received: r.eventsReceived, fbtrace_id: r.fbtraceId, messages: r.messages, mode: actionSource, ...bmInfo },
        error: null,
      })
      return { status: 'sent', eventId: input.eventId, eventsReceived: r.eventsReceived, fbtraceId: r.fbtraceId, mode: actionSource, fallback: Boolean(bmRejected) }
    }
    await finish({
      status: 'failed',
      actionSource,
      identifiers: fieldsOf(standard),
      matchScore: scoreOf(standard),
      response: { status: r.status, code: r.code ?? null, fbtrace_id: r.fbtraceId ?? null, mode: actionSource, ...bmInfo },
      error: r.message,
    })
    return { status: 'failed', eventId: input.eventId, error: r.message }
  }

  private async post(pixelId: string, token: string, payload: Record<string, unknown>): Promise<Attempt> {
    try {
      const res = await (this.opts.fetch ?? globalThis.fetch)(`${this.graphUrl}/${this.version}/${pixelId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: token }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || json.error) {
        const err = (json.error ?? {}) as Record<string, unknown>
        const message = `${String(err.error_user_msg ?? err.message ?? `HTTP ${res.status}`)}${err.code !== undefined ? ` (code ${String(err.code)})` : ''}`
        return { ok: false, status: res.status, code: err.code, fbtraceId: err.fbtrace_id, message, graph: Boolean(json.error) }
      }
      return { ok: true, eventsReceived: Number(json.events_received ?? 0), fbtraceId: typeof json.fbtrace_id === 'string' ? json.fbtrace_id : null, messages: json.messages ?? [] }
    } catch (err) {
      return { ok: false, status: null, code: null, fbtraceId: null, message: err instanceof Error ? err.message : String(err), graph: false }
    }
  }
}

/** Aviso usado pela UI/doc: dias do limite de `event_time`. */
export const MAX_EVENT_AGE_DAYS = MAX_EVENT_AGE_MS / DAY_MS

import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { connections } from './connections.js'
import { contacts } from './contacts.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Pixel / Conversions API da Meta (T104; 11 §3.3, §5.4; STACK E §1.7): configurações de pixel (token CAPI só cifrado,
// SPEC 1.4 nº 8) e o registro dos eventos enviados — dedupe por (pixel, event_id), já que a deduplicação de eventos
// de servidor fica por nossa conta.
// Revisão 3 (paridade de rastreamento com o Leona; docs/integrations/meta-capi.md): `page_id`/WABA id, código de
// teste por pixel, país padrão, Lead automático de anúncio, último resultado do modo business_messaging, diagnóstico
// por evento e links rastreáveis.
// Doc: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
//      https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const PIXEL_PLATFORMS = ['facebook'] as const
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number]

export const PIXEL_BM_STATUSES = ['accepted', 'rejected'] as const
export type PixelBmStatus = (typeof PIXEL_BM_STATUSES)[number]

export const pixelConfigs = crm.table(
  'pixel_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    platform: text('platform').$type<PixelPlatform>().notNull().default('facebook'),
    /** Id numérico do pixel/dataset. */
    pixelId: text('pixel_id').notNull(),
    /** `serializeEncrypted` (AES-256-GCM, AAD `pixel_config/<id>/token`). Nunca sai pela API sem pedido explícito. */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** Envia `Purchase` automaticamente a cada venda registrada (`sale.recorded`). */
    autoSendSales: boolean('auto_send_sales').notNull().default(false),
    /**
     * Página do Facebook do anúncio de clique para WhatsApp (campo do editor de pixel do Leona). Com ela (ou o WABA id)
     * e um contato com `ctwa_clid`, o evento vai como `action_source: business_messaging`, com fallback para `chat`.
     */
    pageId: text('page_id'),
    /** Id da conta do WhatsApp Business (WABA): o identificador que a doc da CAPI for Business Messaging pede. */
    whatsappBusinessAccountId: text('whatsapp_business_account_id'),
    /** `test_event_code` só deste pixel (vale também em produção: os eventos vão para "Testar eventos"). */
    testEventCode: text('test_event_code'),
    /** País (ISO 3166-1 alfa-2, minúsculo) de `user_data.country` quando o DDI do telefone não resolve. */
    defaultCountry: text('default_country').notNull().default('br'),
    /** Lead automático na 1ª mensagem vinda de anúncio (CTWA ou link rastreável), uma vez por contato. */
    autoLeadOnAd: boolean('auto_lead_on_ad').notNull().default(false),
    /** Último resultado do modo business_messaging neste pixel, para não insistir quando a Meta recusa. */
    bmStatus: text('bm_status').$type<PixelBmStatus>(),
    bmCheckedAt: timestamp('bm_checked_at', { withTimezone: true }),
    /** Mensagem da última recusa do modo business_messaging (sem dados pessoais). */
    bmError: text('bm_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('pixel_configs_company_idx').on(t.companyId, t.createdAt),
    check('pixel_configs_pixel_id_ck', sql`${t.pixelId} ~ '^[0-9]+$'`),
    check('pixel_configs_name_ck', sql`char_length(${t.name}) between 2 and 255`),
    check('pixel_configs_page_id_ck', sql`${t.pageId} is null or ${t.pageId} ~ '^[0-9]+$'`),
    check('pixel_configs_waba_id_ck', sql`${t.whatsappBusinessAccountId} is null or ${t.whatsappBusinessAccountId} ~ '^[0-9]+$'`),
    check('pixel_configs_country_ck', sql`${t.defaultCountry} ~ '^[a-z]{2}$'`),
    check('pixel_configs_bm_status_ck', sql`${t.bmStatus} is null or ${t.bmStatus} in ('accepted', 'rejected')`),
  ],
)

/**
 * `sent`: aceito pela CAPI (`events_received`) — não quer dizer que a Meta atribuiu a conversão a um anúncio.
 * `failed`: rejeitado pela Meta (motivo + `fbtrace_id`). `uncertain`: timeout/rede/5xx — a Meta pode ter recebido; é
 * retentado no MESMO modo e com o MESMO `event_id`. `discarded`: não enviado de propósito (ex.: `event_time` com mais
 * de 7 dias) — nunca é reenviado.
 */
export const CAPI_EVENT_STATUSES = ['pending', 'sent', 'failed', 'uncertain', 'discarded'] as const
export type CapiEventStatus = (typeof CAPI_EVENT_STATUSES)[number]

/** Um evento por (pixel, event_id): o mesmo `event_id` de novo não gera outro POST (AC-T104-02). */
export const capiEventLog = crm.table(
  'capi_event_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    pixelConfigId: uuid('pixel_config_id')
      .notNull()
      .references(() => pixelConfigs.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventName: text('event_name').notNull(),
    /** Modo usado: o `action_source` do envio aceito (ou do último tentado). */
    actionSource: text('action_source').notNull(),
    status: text('status').$type<CapiEventStatus>().notNull().default('pending'),
    /** Quem originou: `flow` (nó pixel), `sale` (venda registrada), `ad_lead` (Lead automático) ou `manual`. */
    source: text('source').notNull(),
    sourceId: text('source_id'),
    /** Resposta da Meta (`events_received`, `fbtrace_id`, `business_messaging` recusado) ou o erro. Sem dados pessoais. */
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    /** Quando o evento aconteceu (`event_time`). */
    eventTime: timestamp('event_time', { withTimezone: true }),
    /** Nomes (nunca valores) dos campos de `user_data` enviados. */
    identifiers: text('identifiers').array(),
    /** Pontuação estimada de correspondência: quantos identificadores fortes foram. */
    matchScore: integer('match_score'),
    /** Foi com `test_event_code` (aparece em "Testar eventos" no Gerenciador de Eventos). */
    testEvent: boolean('test_event').notNull().default(false),
    /** Valor/moeda enviados em `custom_data` (sem dados pessoais). */
    customData: jsonb('custom_data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('capi_event_log_pixel_event_uq').on(t.pixelConfigId, t.eventId),
    index('capi_event_log_company_idx').on(t.companyId, t.createdAt),
    index('capi_event_log_pixel_created_idx').on(t.pixelConfigId, t.createdAt),
  ],
)

// ---- Links rastreáveis -----------------------------------------------------------------------------------------------
// Link curto público `/w/:slug` → registra o clique (fbclid → fbc, fbp, utm_*, IP, user agent) e redireciona para o
// `wa.me` da conexão com a mensagem pronta e um código curto no fim. A 1ª mensagem com o código liga o clique ao
// contato (atribuição) e os eventos daquele contato passam a levar fbc/fbp/IP/user agent.

export const TRACKED_LINK_CODE_MODES = ['visible', 'discreet', 'off'] as const
export type TrackedLinkCodeMode = (typeof TRACKED_LINK_CODE_MODES)[number]

export const trackedLinks = crm.table(
  'tracked_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** Único global (o caminho público não leva a empresa). */
    slug: text('slug').notNull(),
    /** Número de destino (só dígitos, com DDI). Vazio: o número da conexão. */
    phone: text('phone'),
    /** Mensagem pronta do `wa.me` (o código vai no fim). */
    message: text('message').notNull().default(''),
    /** UTMs padrão do link (as da query do clique têm precedência). */
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    active: boolean('active').notNull().default(true),
    /**
     * Código na mensagem pronta: `visible` ("(ref ABC234)"), `discreet` (o mesmo código em caracteres invisíveis) ou
     * `off` (sem código: liga o clique ao 1º contato novo da conexão dentro de `match_window_minutes`, como "provável").
     */
    codeMode: text('code_mode').$type<TrackedLinkCodeMode>().notNull().default('visible'),
    /** Janela da ligação "provável" (sem código), em minutos. */
    matchWindowMinutes: integer('match_window_minutes').notNull().default(10),
    /** Ligação "provável" sem código (só proximidade de tempo). Desligada por padrão. */
    probableMatch: boolean('probable_match').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tracked_links_slug_uq').on(t.slug),
    check('tracked_links_code_mode_ck', sql`${t.codeMode} in ('visible', 'discreet', 'off')`),
    check('tracked_links_window_ck', sql`${t.matchWindowMinutes} between 1 and 1440`),
    index('tracked_links_company_idx').on(t.companyId, t.createdAt),
    check('tracked_links_slug_ck', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{2,62}$'`),
    check('tracked_links_phone_ck', sql`${t.phone} is null or ${t.phone} ~ '^[0-9]{8,15}$'`),
    check('tracked_links_name_ck', sql`char_length(${t.name}) between 2 and 120`),
  ],
)

export const trackedLinkClicks = crm.table(
  'tracked_link_clicks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => trackedLinks.id, { onDelete: 'cascade' }),
    /** Código curto do fim da mensagem (`ref XXXXXX`). Único por empresa. */
    code: text('code').notNull(),
    fbclid: text('fbclid'),
    /** Id do anúncio informado na URL do clique (`ad_id={{ad.id}}` nos parâmetros de URL do anúncio). */
    adId: text('ad_id'),
    /** `fb.1.<ms do clique>.<fbclid>` (subdomainIndex 1 quando gerado no servidor, sem cookie). */
    fbc: text('fbc'),
    fbp: text('fbp'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    clientIp: text('client_ip'),
    userAgent: text('user_agent'),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    /** `exact` (código na mensagem) ou `probable` (sem código: 1º contato novo da conexão dentro da janela). */
    matchConfidence: text('match_confidence').$type<'exact' | 'probable'>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tracked_link_clicks_code_uq').on(t.companyId, t.code),
    index('tracked_link_clicks_link_idx').on(t.linkId, t.createdAt),
    index('tracked_link_clicks_contact_idx').on(t.contactId, t.matchedAt),
  ],
)

// Links rastreáveis (revisão 3, "melhor que o Leona"): link curto público `/w/:slug` por conexão/campanha.
// - Clique: registra fbclid → `fbc` (`fb.1.<ms>.<fbclid>`), `fbp` (se vier na query), `utm_*`, IP, user agent e hora;
//   redireciona para `https://wa.me/<número>?text=<mensagem pronta> (ref XXXXXX)`.
// - 1ª mensagem com o código: liga o clique ao contato (atribuição first/last touch com as UTMs), tira o código do
//   texto gravado no chat e, daí em diante, os eventos CAPI do contato levam fbc/fbp/client_ip_address/
//   client_user_agent (CapiService.userFromContact).
// - A resposta pública nunca expõe dados: slug desconhecido/inativo → 404 genérico; o redirect só leva o número e a
//   mensagem que a própria empresa configurou.
// Doc fbc/fbp: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
//   "creationTime … in milliseconds … If you don't save the cookie, use the timestamp when you first observed or
//   received the fbclid value"; subdomainIndex 1 quando gerado no servidor; o fbclid não pode mudar de caixa.
import { randomInt, randomUUID } from 'node:crypto'
import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { connections, sales, trackedLinkClicks, trackedLinks, type Database } from '@crm/db'
import { AttributionService } from '../attribution/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
/** Sem 0/O, 1/I/L: o código é digitado/lido por gente quando a mensagem é editada. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const TRACKING_CODE_LENGTH = 6
/** Janela para ligar uma mensagem a um clique. */
export const TRACKING_MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** `(ref ABC234)` em qualquer ponto do texto (o usuário pode ter editado a mensagem). */
const CODE_RE = new RegExp(`\\s*\\(\\s*ref[:\\s]+([${CODE_ALPHABET}]{${TRACKING_CODE_LENGTH}})\\s*\\)`, 'i')
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const
type UtmKey = (typeof UTM_KEYS)[number]

export class TrackedLinkError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation' | 'conflict',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'TrackedLinkError'
  }
}

export interface TrackedLinkInput {
  name?: string | null
  slug?: string | null
  connection_id?: string | null
  phone?: string | null
  message?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
  active?: boolean
}

export interface TrackedLinkDto {
  id: string
  name: string
  slug: string
  /** Caminho público (a UI junta com a origem). */
  path: string
  connection_id: string | null
  connection_name: string | null
  phone: string | null
  message: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  active: boolean
  stats: { clicks: number; conversations: number; sales: number }
  created_at: string
  updated_at: string
}

export interface ClickRequest {
  query: Record<string, string | undefined>
  ip?: string | null
  userAgent?: string | null
}

export const trackingSuffix = (code: string) => `(ref ${code})`

/** Código do link rastreável no texto e o texto sem ele. */
export function extractTrackingCode(text: string | null | undefined): { code: string; cleaned: string } | null {
  if (!text) return null
  const m = CODE_RE.exec(text)
  if (!m) return null
  const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[ \t]+$/gm, '').trim()
  return { code: m[1]!.toUpperCase(), cleaned }
}

/** `fb.1.<ms>.<fbclid>` (fbclid sem mudar a caixa). */
export const fbcFromFbclid = (fbclid: string, at: Date) => `fb.1.${at.getTime()}.${fbclid}`

const FBP_RE = /^fb\.[0-2]\.\d{10,16}\.\d{1,32}$/
const FBC_RE = /^fb\.[0-2]\.\d{10,16}\.[A-Za-z0-9_-]{8,500}$/
const FBCLID_RE = /^[A-Za-z0-9_-]{8,500}$/

const clip = (v: string | null | undefined, max: number) => {
  const s = (v ?? '').trim()
  return s ? s.slice(0, max) : null
}

export function linkSlugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

const randomCode = (len: number) => Array.from({ length: len }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')

type Row = typeof trackedLinks.$inferSelect

export class TrackedLinksService {
  constructor(private readonly opts: { db: Database; now?: () => Date }) {}

  private get db() {
    return this.opts.db
  }

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  async list(companyId: string): Promise<TrackedLinkDto[]> {
    const rows = await this.db
      .select({ link: trackedLinks, connectionName: connections.name })
      .from(trackedLinks)
      .leftJoin(connections, eq(connections.id, trackedLinks.connectionId))
      .where(eq(trackedLinks.companyId, companyId))
      .orderBy(asc(trackedLinks.name), asc(trackedLinks.createdAt))
    const stats = await this.stats(companyId)
    return rows.map((r) => this.dto(r.link, r.connectionName, stats.get(r.link.id)))
  }

  async get(companyId: string, id: string): Promise<TrackedLinkDto> {
    const row = await this.row(companyId, id)
    const [conn] = row.connectionId ? await this.db.select({ name: connections.name }).from(connections).where(eq(connections.id, row.connectionId)) : []
    return this.dto(row, conn?.name ?? null, (await this.stats(companyId, id)).get(id))
  }

  async create(companyId: string, input: TrackedLinkInput): Promise<TrackedLinkDto> {
    const v = await this.validate(companyId, input, true)
    const base = v.slug ?? (linkSlugify(v.name ?? '') || 'link')
    for (let attempt = 0; attempt < 5; attempt++) {
      // Slug explícito: tenta só ele; automático: nome + sufixo aleatório se colidir.
      const slug = v.slug ? v.slug : attempt === 0 && base.length >= 3 ? base : `${base.slice(0, 33)}-${randomCode(5).toLowerCase()}`
      const [row] = await this.db
        .insert(trackedLinks)
        .values({ id: randomUUID(), companyId, ...this.values(v), slug, name: v.name!, message: v.message ?? '' })
        .onConflictDoNothing({ target: trackedLinks.slug })
        .returning()
      if (row) return this.get(companyId, row.id)
      if (v.slug) throw new TrackedLinkError('conflict', 'Este endereço já está em uso; escolha outro', { fields: [{ path: 'slug', message: 'Endereço em uso' }] })
    }
    throw new TrackedLinkError('conflict', 'Não foi possível gerar um endereço livre; informe um')
  }

  async update(companyId: string, id: string, input: TrackedLinkInput): Promise<TrackedLinkDto> {
    const cur = await this.row(companyId, id)
    const v = await this.validate(companyId, input, false)
    try {
      await this.db
        .update(trackedLinks)
        .set({ ...this.values(v), ...(v.name !== undefined ? { name: v.name } : {}), ...(v.slug ? { slug: v.slug } : {}), ...(v.message !== undefined ? { message: v.message ?? '' } : {}), updatedAt: this.now() })
        .where(eq(trackedLinks.id, cur.id))
    } catch (err) {
      if ((err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505')
        throw new TrackedLinkError('conflict', 'Este endereço já está em uso; escolha outro', { fields: [{ path: 'slug', message: 'Endereço em uso' }] })
      throw err
    }
    return this.get(companyId, id)
  }

  async remove(companyId: string, id: string): Promise<void> {
    const cur = await this.row(companyId, id)
    await this.db.delete(trackedLinks).where(eq(trackedLinks.id, cur.id))
  }

  /**
   * Clique público: grava o clique e devolve o destino `wa.me`. Slug desconhecido, inativo ou sem número → null
   * (a rota responde 404 genérico).
   */
  async click(slug: string, req: ClickRequest): Promise<{ location: string; code: string } | null> {
    const s = slug.trim().toLowerCase()
    if (!SLUG_RE.test(s)) return null
    const [r] = await this.db
      .select({ link: trackedLinks, connPhone: connections.phoneNumber })
      .from(trackedLinks)
      .leftJoin(connections, eq(connections.id, trackedLinks.connectionId))
      .where(eq(trackedLinks.slug, s))
      .limit(1)
    if (!r || !r.link.active) return null
    const phone = (r.link.phone ?? r.connPhone ?? '').replace(/\D/g, '')
    if (phone.length < 8) return null
    const at = this.now()
    const q = req.query
    const fbclid = q.fbclid && FBCLID_RE.test(q.fbclid) ? q.fbclid : null
    // `fbc` pronto (cookie `_fbc` repassado pela landing page) tem precedência; senão, derivado do fbclid.
    const fbc = q.fbc && FBC_RE.test(q.fbc) ? q.fbc : fbclid ? fbcFromFbclid(fbclid, at) : null
    const rawFbp = q.fbp ?? q._fbp
    const fbp = rawFbp && FBP_RE.test(rawFbp) ? rawFbp : null
    const utm = Object.fromEntries(UTM_KEYS.map((k) => [k, clip(q[k], 255) ?? r.link[camel(k)] ?? null])) as Record<UtmKey, string | null>
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode(TRACKING_CODE_LENGTH)
      const [click] = await this.db
        .insert(trackedLinkClicks)
        .values({
          companyId: r.link.companyId,
          linkId: r.link.id,
          code,
          fbclid,
          fbc,
          fbp,
          utmSource: utm.utm_source,
          utmMedium: utm.utm_medium,
          utmCampaign: utm.utm_campaign,
          utmContent: utm.utm_content,
          utmTerm: utm.utm_term,
          clientIp: clip(req.ip, 64),
          userAgent: clip(req.userAgent, 512),
          createdAt: at,
        })
        .onConflictDoNothing({ target: [trackedLinkClicks.companyId, trackedLinkClicks.code] })
        .returning({ id: trackedLinkClicks.id })
      if (!click) continue
      const text = [r.link.message.trim(), trackingSuffix(code)].filter(Boolean).join(' ')
      return { location: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, code }
    }
    throw new Error('tracked-links: não foi possível gerar um código livre')
  }

  /**
   * Mensagem recebida com código de link rastreável: liga o clique ao contato (se ainda livre ou já dele, dentro da
   * janela), grava o toque de atribuição e devolve o texto sem o código. Código inexistente → null (texto intacto).
   */
  async matchInbound(companyId: string, contactId: string, text: string | null | undefined): Promise<{ clickId: string; cleaned: string; firstMatch: boolean } | null> {
    const found = extractTrackingCode(text)
    if (!found) return null
    const since = new Date(this.now().getTime() - TRACKING_MATCH_WINDOW_MS)
    const [click] = await this.db
      .select()
      .from(trackedLinkClicks)
      .where(
        and(
          eq(trackedLinkClicks.companyId, companyId),
          eq(trackedLinkClicks.code, found.code),
          gte(trackedLinkClicks.createdAt, since),
          or(isNull(trackedLinkClicks.contactId), eq(trackedLinkClicks.contactId, contactId)),
        ),
      )
      .limit(1)
    if (!click) return null
    const firstMatch = !click.contactId
    if (firstMatch) {
      const at = this.now()
      const updated = await this.db
        .update(trackedLinkClicks)
        .set({ contactId, matchedAt: at })
        .where(and(eq(trackedLinkClicks.id, click.id), isNull(trackedLinkClicks.contactId)))
        .returning({ id: trackedLinkClicks.id })
      if (updated[0]) {
        await new AttributionService(this.db).recordTouch(
          companyId,
          contactId,
          {
            utm_source: click.utmSource,
            utm_medium: click.utmMedium,
            utm_campaign: click.utmCampaign,
            utm_content: click.utmContent,
            utm_term: click.utmTerm,
          },
          { at: click.createdAt },
        )
      }
    }
    return { clickId: click.id, cleaned: found.cleaned, firstMatch }
  }

  private async stats(companyId: string, linkId?: string): Promise<Map<string, { clicks: number; conversations: number; sales: number }>> {
    const rows = await this.db
      .select({
        linkId: trackedLinkClicks.linkId,
        clicks: sql<number>`count(*)::int`,
        conversations: sql<number>`count(distinct ${trackedLinkClicks.contactId})::int`,
        sales: sql<number>`(select count(*)::int from ${sales} s where s.company_id = ${companyId} and s.status = 'approved' and s.contact_id in (select c2.contact_id from ${trackedLinkClicks} c2 where c2.link_id = ${trackedLinkClicks.linkId} and c2.matched_at is not null and s.sold_at >= c2.matched_at))`,
      })
      .from(trackedLinkClicks)
      .where(and(eq(trackedLinkClicks.companyId, companyId), ...(linkId ? [eq(trackedLinkClicks.linkId, linkId)] : [])))
      .groupBy(trackedLinkClicks.linkId)
    return new Map(rows.map((r) => [r.linkId, { clicks: r.clicks, conversations: r.conversations, sales: r.sales }]))
  }

  private async row(companyId: string, id: string): Promise<Row> {
    if (!UUID_RE.test(id)) throw new TrackedLinkError('not_found', 'Link não encontrado')
    const [row] = await this.db
      .select()
      .from(trackedLinks)
      .where(and(eq(trackedLinks.companyId, companyId), eq(trackedLinks.id, id)))
      .limit(1)
    if (!row) throw new TrackedLinkError('not_found', 'Link não encontrado')
    return row
  }

  private values(v: Validated): Partial<typeof trackedLinks.$inferInsert> {
    const out: Partial<typeof trackedLinks.$inferInsert> = {}
    if (v.connectionId !== undefined) out.connectionId = v.connectionId
    if (v.phone !== undefined) out.phone = v.phone
    for (const k of UTM_KEYS) if (v.utm[k] !== undefined) out[camel(k)] = v.utm[k]
    if (v.active !== undefined) out.active = v.active
    return out
  }

  private async validate(companyId: string, input: TrackedLinkInput, creating: boolean): Promise<Validated> {
    const fields: { path: string; message: string }[] = []
    const out: Validated = { utm: {} }
    if (creating || input.name !== undefined) {
      const name = (input.name ?? '').trim()
      if (name.length < 2 || name.length > 120) fields.push({ path: 'name', message: 'O nome deve ter de 2 a 120 caracteres' })
      out.name = name
    }
    if (input.slug !== undefined && input.slug !== null && input.slug.trim()) {
      const slug = input.slug.trim().toLowerCase()
      if (!SLUG_RE.test(slug)) fields.push({ path: 'slug', message: 'Endereço: 3 a 63 letras minúsculas, números ou hífen' })
      out.slug = slug
    }
    if (input.connection_id !== undefined) {
      const id = input.connection_id?.trim() || null
      if (id) {
        const [c] = UUID_RE.test(id) ? await this.db.select({ id: connections.id }).from(connections).where(and(eq(connections.companyId, companyId), eq(connections.id, id))) : []
        if (!c) fields.push({ path: 'connection_id', message: 'Conexão não encontrada' })
      }
      out.connectionId = id
    }
    if (input.phone !== undefined) {
      const phone = (input.phone ?? '').replace(/\D/g, '').replace(/^0+/, '')
      if (phone && (phone.length < 8 || phone.length > 15)) fields.push({ path: 'phone', message: 'Número com DDI, só dígitos (ex.: 5511999998888)' })
      out.phone = phone || null
    }
    if (input.message !== undefined) {
      const message = (input.message ?? '').trim()
      if (message.length > 500) fields.push({ path: 'message', message: 'Mensagem com até 500 caracteres' })
      out.message = message
    }
    for (const k of UTM_KEYS) if (input[k] !== undefined) out.utm[k] = clip(input[k], 255)
    if (input.active !== undefined) out.active = input.active
    if (fields.length) throw new TrackedLinkError('validation', fields[0]!.message, { fields })
    if (creating && !out.connectionId && !out.phone) throw new TrackedLinkError('validation', 'Escolha a conexão ou informe o número', { fields: [{ path: 'connection_id', message: 'Escolha a conexão ou informe o número' }] })
    return out
  }

  private dto(r: Row, connectionName: string | null, stats?: { clicks: number; conversations: number; sales: number }): TrackedLinkDto {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      path: `/w/${r.slug}`,
      connection_id: r.connectionId,
      connection_name: connectionName,
      phone: r.phone,
      message: r.message,
      utm_source: r.utmSource,
      utm_medium: r.utmMedium,
      utm_campaign: r.utmCampaign,
      utm_content: r.utmContent,
      utm_term: r.utmTerm,
      active: r.active,
      stats: stats ?? { clicks: 0, conversations: 0, sales: 0 },
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }
  }
}

interface Validated {
  name?: string
  slug?: string
  connectionId?: string | null
  phone?: string | null
  message?: string
  utm: Partial<Record<UtmKey, string | null>>
  active?: boolean
}

function camel(k: UtmKey): 'utmSource' | 'utmMedium' | 'utmCampaign' | 'utmContent' | 'utmTerm' {
  return ({ utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_content: 'utmContent', utm_term: 'utmTerm' } as const)[k]
}

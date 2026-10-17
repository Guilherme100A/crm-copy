// Avisos e banners globais do admin (T96, AC-T96-01; 20-admin-interno.md §3.6, §3.7; 14-notificacoes.md 12–15).
// O admin faz o CRUD; o cliente (`/api/announcements`, `/api/banners` e bootstrap do dashboard) recebe só os ativos e
// não expirados, por prioridade decrescente. Fechar um aviso no cliente é só local (14 §14): não há API.
import { and, count, desc, eq, gt, ilike, isNull, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { ANNOUNCEMENT_TYPES, announcements, banners, type AnnouncementType, type Database } from '@crm/db'
import { buildPageMeta, pageOffset, type PageMeta } from '@crm/shared'
import { AdminOpsError, notFound } from './errors'

type AnnouncementRow = typeof announcements.$inferSelect
type BannerRow = typeof banners.$inferSelect

/** Teto de itens que o cliente recebe (avisos e banners, cada). */
export const CLIENT_ITEMS_MAX = 50

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** URL absoluta http(s); imagem e link de avisos/banners (o `/api/media` é por empresa: não serve a todas). */
const httpUrl = (label: string) =>
  z
    .string(`${label} inválida`)
    .trim()
    .max(2048, `${label} longa demais`)
    .refine((v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    }, `${label} precisa ser http(s)`)

/** `""`/null em campo opcional = limpar. */
const optionalUrl = (label: string) =>
  z
    .union([z.literal('').transform(() => null), httpUrl(label)])
    .nullable()
    .optional()
const priority = z.number('Prioridade inválida').int('A prioridade precisa ser inteira').min(-1_000_000).max(1_000_000)
const expiresAt = z.iso
  .datetime({ offset: true, message: 'Data de expiração inválida (ISO 8601)' })
  .nullable()
  .optional()

/** Aceita o fio legado `{ announcement: {...} }` / `{ banner: {...} }`. */
const unwrap = (key: string) => (v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = (v as Record<string, unknown>)[key]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
  }
  return v
}

const announcementFields = {
  title: z
    .string('Informe o título')
    .trim()
    .min(1, 'Informe o título')
    .max(200, 'O título pode ter até 200 caracteres'),
  message: z
    .string('Informe a mensagem')
    .trim()
    .min(1, 'Informe a mensagem')
    .max(5000, 'A mensagem pode ter até 5000 caracteres'),
  image_url: optionalUrl('URL da imagem'),
  url: optionalUrl('URL'),
  announcement_type: z.enum(ANNOUNCEMENT_TYPES, `Tipo inválido (use ${ANNOUNCEMENT_TYPES.join(', ')})`),
  priority,
  expires_at: expiresAt,
  active: z.boolean('Ativo precisa ser booleano'),
}

export const announcementCreateSchema = z.preprocess(
  unwrap('announcement'),
  z.object({
    ...announcementFields,
    announcement_type: announcementFields.announcement_type.default('info'),
    priority: priority.default(0),
    active: announcementFields.active.default(true),
  }),
)
export const announcementUpdateSchema = z.preprocess(unwrap('announcement'), z.object(announcementFields).partial())

const bannerFields = {
  /** Nome interno. */
  title: z.string('Título inválido').trim().max(200, 'O título pode ter até 200 caracteres').nullable().optional(),
  image_url: httpUrl('URL da imagem'),
  url: optionalUrl('URL'),
  priority,
  expires_at: expiresAt,
  active: z.boolean('Ativo precisa ser booleano'),
}

export const bannerCreateSchema = z.preprocess(
  unwrap('banner'),
  z.object({
    ...bannerFields,
    image_url: z.string('Informe a imagem do banner').pipe(httpUrl('URL da imagem')),
    priority: priority.default(0),
    active: bannerFields.active.default(true),
  }),
)
export const bannerUpdateSchema = z.preprocess(unwrap('banner'), z.object(bannerFields).partial())

export const adminListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  skip_total: z.enum(['1', '0', 'true', 'false']).optional(),
  active: z.enum(['1', '0', 'true', 'false'], 'Use active=true|false').optional(),
})
export type AdminListQuery = z.input<typeof adminListQuerySchema>

export interface AnnouncementDto {
  id: string
  title: string
  message: string
  image_url: string | null
  url: string | null
  announcement_type: AnnouncementType
  priority: number
  expires_at: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface BannerDto {
  id: string
  title: string | null
  image_url: string
  url: string | null
  priority: number
  expires_at: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export function announcementDto(r: AnnouncementRow): AnnouncementDto {
  return {
    id: r.id,
    title: r.title,
    message: r.message,
    image_url: r.imageUrl,
    url: r.url,
    announcement_type: r.announcementType,
    priority: r.priority,
    expires_at: iso(r.expiresAt),
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

export function bannerDto(r: BannerRow): BannerDto {
  return {
    id: r.id,
    title: r.title,
    image_url: r.imageUrl,
    url: r.url,
    priority: r.priority,
    expires_at: iso(r.expiresAt),
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input ?? {})
  if (!r.success)
    throw new AdminOpsError('validation', 'Dados inválidos', {
      fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    })
  return r.data
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const flag = (v: string | undefined) => (v === undefined ? undefined : v === '1' || v === 'true')
const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v))

/** Ativo e não expirado em `now` (expiração exata em `now` já conta como expirado). */
const visibleAnnouncement = (now: Date) =>
  and(eq(announcements.active, true), or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)))
const visibleBanner = (now: Date) =>
  and(eq(banners.active, true), or(isNull(banners.expiresAt), gt(banners.expiresAt, now)))

/** Avisos que o cliente vê: ativos, não expirados, por prioridade decrescente (empate: mais novo primeiro). */
export async function activeAnnouncements(db: Database, now: Date = new Date()): Promise<AnnouncementDto[]> {
  const rows = await db
    .select()
    .from(announcements)
    .where(visibleAnnouncement(now))
    .orderBy(desc(announcements.priority), desc(announcements.createdAt), desc(announcements.id))
    .limit(CLIENT_ITEMS_MAX)
  return rows.map(announcementDto)
}

/** Banners que o cliente vê: ativos, não expirados, por prioridade decrescente (empate: mais novo primeiro). */
export async function activeBanners(db: Database, now: Date = new Date()): Promise<BannerDto[]> {
  const rows = await db
    .select()
    .from(banners)
    .where(visibleBanner(now))
    .orderBy(desc(banners.priority), desc(banners.createdAt), desc(banners.id))
    .limit(CLIENT_ITEMS_MAX)
  return rows.map(bannerDto)
}

export interface AnnouncementsServiceOptions {
  db: Database
  now?: () => Date
}

export interface AdminPage<T> {
  items: T[]
  page: PageMeta
}

/** CRUD dos avisos e banners pelo admin da plataforma (globais: sem empresa). */
export class AnnouncementsService {
  private readonly db: Database
  private readonly clock: () => Date

  constructor(opts: AnnouncementsServiceOptions) {
    this.db = opts.db
    this.clock = opts.now ?? (() => new Date())
  }

  now(): Date {
    return this.clock()
  }

  // ---------- avisos ----------

  async listAnnouncements(query: unknown): Promise<AdminPage<AnnouncementDto>> {
    const q = parse(adminListQuerySchema, query)
    const where: SQL[] = []
    if (q.search)
      where.push(
        or(
          ilike(announcements.title, `%${escapeLike(q.search)}%`),
          ilike(announcements.message, `%${escapeLike(q.search)}%`),
        )!,
      )
    const active = flag(q.active)
    if (active !== undefined) where.push(eq(announcements.active, active))
    const cond = where.length ? and(...where) : undefined
    const skipTotal = flag(q.skip_total) === true
    const rows = await this.db
      .select()
      .from(announcements)
      .where(cond)
      .orderBy(desc(announcements.priority), desc(announcements.createdAt), desc(announcements.id))
      .limit(q.limit + (skipTotal ? 1 : 0))
      .offset(pageOffset(q))
    const items = rows.slice(0, q.limit).map(announcementDto)
    if (skipTotal) return { items, page: buildPageMeta(q, { fetchedCount: rows.length }) }
    const [total] = await this.db.select({ n: count() }).from(announcements).where(cond)
    return { items, page: buildPageMeta(q, { total: total?.n ?? 0 }) }
  }

  async getAnnouncement(id: string): Promise<AnnouncementDto> {
    return announcementDto(await this.announcementRow(id))
  }

  async createAnnouncement(input: unknown, actorUserId: string | null = null): Promise<AnnouncementDto> {
    const d = parse(announcementCreateSchema, input)
    const now = this.now()
    const [row] = await this.db
      .insert(announcements)
      .values({
        title: d.title,
        message: d.message,
        imageUrl: d.image_url ?? null,
        url: d.url ?? null,
        announcementType: d.announcement_type,
        priority: d.priority,
        expiresAt: toDate(d.expires_at) ?? null,
        active: d.active,
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return announcementDto(row!)
  }

  async updateAnnouncement(id: string, input: unknown): Promise<{ announcement: AnnouncementDto; fields: string[] }> {
    const d = parse(announcementUpdateSchema, input)
    await this.announcementRow(id)
    const patch: Partial<typeof announcements.$inferInsert> = {}
    if (d.title !== undefined) patch.title = d.title
    if (d.message !== undefined) patch.message = d.message
    if (d.image_url !== undefined) patch.imageUrl = d.image_url
    if (d.url !== undefined) patch.url = d.url
    if (d.announcement_type !== undefined) patch.announcementType = d.announcement_type
    if (d.priority !== undefined) patch.priority = d.priority
    if (d.expires_at !== undefined) patch.expiresAt = toDate(d.expires_at)
    if (d.active !== undefined) patch.active = d.active
    const fields = Object.keys(d).filter((k) => d[k as keyof typeof d] !== undefined)
    if (fields.length)
      await this.db
        .update(announcements)
        .set({ ...patch, updatedAt: this.now() })
        .where(eq(announcements.id, id))
    return { announcement: await this.getAnnouncement(id), fields }
  }

  async deleteAnnouncement(id: string): Promise<AnnouncementDto> {
    const row = await this.announcementRow(id)
    await this.db.delete(announcements).where(eq(announcements.id, id))
    return announcementDto(row)
  }

  // ---------- banners ----------

  async listBanners(query: unknown): Promise<AdminPage<BannerDto>> {
    const q = parse(adminListQuerySchema, query)
    const where: SQL[] = []
    if (q.search)
      where.push(
        or(ilike(banners.title, `%${escapeLike(q.search)}%`), ilike(banners.imageUrl, `%${escapeLike(q.search)}%`))!,
      )
    const active = flag(q.active)
    if (active !== undefined) where.push(eq(banners.active, active))
    const cond = where.length ? and(...where) : undefined
    const skipTotal = flag(q.skip_total) === true
    const rows = await this.db
      .select()
      .from(banners)
      .where(cond)
      .orderBy(desc(banners.priority), desc(banners.createdAt), desc(banners.id))
      .limit(q.limit + (skipTotal ? 1 : 0))
      .offset(pageOffset(q))
    const items = rows.slice(0, q.limit).map(bannerDto)
    if (skipTotal) return { items, page: buildPageMeta(q, { fetchedCount: rows.length }) }
    const [total] = await this.db.select({ n: count() }).from(banners).where(cond)
    return { items, page: buildPageMeta(q, { total: total?.n ?? 0 }) }
  }

  async getBanner(id: string): Promise<BannerDto> {
    return bannerDto(await this.bannerRow(id))
  }

  async createBanner(input: unknown, actorUserId: string | null = null): Promise<BannerDto> {
    const d = parse(bannerCreateSchema, input)
    const now = this.now()
    const [row] = await this.db
      .insert(banners)
      .values({
        title: d.title || null,
        imageUrl: d.image_url,
        url: d.url ?? null,
        priority: d.priority,
        expiresAt: toDate(d.expires_at) ?? null,
        active: d.active,
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return bannerDto(row!)
  }

  async updateBanner(id: string, input: unknown): Promise<{ banner: BannerDto; fields: string[] }> {
    const d = parse(bannerUpdateSchema, input)
    await this.bannerRow(id)
    const patch: Partial<typeof banners.$inferInsert> = {}
    if (d.title !== undefined) patch.title = d.title || null
    if (d.image_url !== undefined) patch.imageUrl = d.image_url
    if (d.url !== undefined) patch.url = d.url
    if (d.priority !== undefined) patch.priority = d.priority
    if (d.expires_at !== undefined) patch.expiresAt = toDate(d.expires_at)
    if (d.active !== undefined) patch.active = d.active
    const fields = Object.keys(d).filter((k) => d[k as keyof typeof d] !== undefined)
    if (fields.length)
      await this.db
        .update(banners)
        .set({ ...patch, updatedAt: this.now() })
        .where(eq(banners.id, id))
    return { banner: await this.getBanner(id), fields }
  }

  async deleteBanner(id: string): Promise<BannerDto> {
    const row = await this.bannerRow(id)
    await this.db.delete(banners).where(eq(banners.id, id))
    return bannerDto(row)
  }

  // ---------- internos ----------

  private async announcementRow(id: string): Promise<AnnouncementRow> {
    if (!UUID_RE.test(id)) throw notFound('Aviso')
    const [row] = await this.db.select().from(announcements).where(eq(announcements.id, id)).limit(1)
    if (!row) throw notFound('Aviso')
    return row
  }

  private async bannerRow(id: string): Promise<BannerRow> {
    if (!UUID_RE.test(id)) throw notFound('Banner')
    const [row] = await this.db.select().from(banners).where(eq(banners.id, id)).limit(1)
    if (!row) throw notFound('Banner')
    return row
  }
}

/** `%` e `_` da busca são literais. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

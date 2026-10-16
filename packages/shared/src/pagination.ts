// Paginação no fio (SPEC 3.6): por página (`?page=&limit=&skip_total=1`) e por cursor (`?cursor=&limit=`).
import * as z from 'zod'

export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

// z.coerce.boolean('0') === true (STACK.md armadilha zod 4): flag explícita.
const flagSchema = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true')

const limitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT)

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: limitSchema,
  skip_total: flagSchema.default(false),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

export const pageMetaSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total_count: z.number().int().min(0).nullable(),
  total_pages: z.number().int().min(0).nullable(),
  has_more: z.boolean(),
})
export type PageMeta = z.infer<typeof pageMetaSchema>

export function pageResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), page: pageMetaSchema })
}
export interface PageResponse<T> {
  items: T[]
  page: PageMeta
}

/** Deslocamento SQL da página (1-based). */
export function pageOffset(query: Pick<PageQuery, 'page' | 'limit'>): number {
  return (query.page - 1) * query.limit
}

/**
 * Monta o `page` da resposta. Com `total` conhecido calcula as contagens; sem total (`skip_total`),
 * `has_more` vem de `fetchedCount > limit` (busque `limit + 1` linhas).
 */
export function buildPageMeta(
  query: Pick<PageQuery, 'page' | 'limit'>,
  opts: { total: number } | { fetchedCount: number },
): PageMeta {
  const { page, limit } = query
  if ('total' in opts) {
    const totalPages = Math.ceil(opts.total / limit)
    return { page, limit, total_count: opts.total, total_pages: totalPages, has_more: page < totalPages }
  }
  return { page, limit, total_count: null, total_pages: null, has_more: opts.fetchedCount > limit }
}

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: limitSchema,
})
export type CursorQuery = z.infer<typeof cursorQuerySchema>

export function cursorResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() })
}
export interface CursorResponse<T> {
  items: T[]
  next_cursor: string | null
}

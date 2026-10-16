// Produtos (T34; 19 §3.5, §5.7): nome 2–255, moeda ISO, preços em centavos (mín ≤ máx, fallback > 0).
import { and, asc, eq, sql } from 'drizzle-orm'
import { products, type Database } from '@crm/db'
import { normalizeCurrency, salesInvalid, salesNotFound, UUID_RE } from '../sales/errors'

export interface ProductDto {
  id: string
  public_id: string
  name: string
  currency: string
  price_min_cents: number
  price_max_cents: number
  price_fallback_cents: number
  created_at: string
  updated_at: string
}

export interface ProductInput {
  name?: string
  currency?: string
  price_min_cents?: number
  price_max_cents?: number
  price_fallback_cents?: number
}

export interface PriceRange {
  price_min_cents?: number
  price_max_cents?: number
  price_fallback_cents?: number
  priceMinCents?: number
  priceMaxCents?: number
  priceFallbackCents?: number
}

/** Valor da venda: dentro de [mín, máx] usa o valor; fora (ou sem valor) usa o fallback (19 §5.7, AC-T34-02). */
export function resolvePrice(product: PriceRange, amountCents: number | null | undefined): number {
  const min = product.price_min_cents ?? product.priceMinCents ?? 0
  const max = product.price_max_cents ?? product.priceMaxCents ?? Number.MAX_SAFE_INTEGER
  const fallback = product.price_fallback_cents ?? product.priceFallbackCents ?? 0
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) return fallback
  return amountCents >= min && amountCents <= max ? amountCents : fallback
}

const toDto = (r: typeof products.$inferSelect): ProductDto => ({
  id: r.id,
  public_id: r.publicId,
  name: r.name,
  currency: r.currency,
  price_min_cents: r.priceMinCents,
  price_max_cents: r.priceMaxCents,
  price_fallback_cents: r.priceFallbackCents,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
})

const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/** Valida o produto completo (criação ou estado final da edição). */
function validate(p: Required<ProductInput>): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = []
  const name = p.name.trim()
  if (name.length < 2 || name.length > 255) errors.push({ path: 'name', message: 'O nome precisa ter de 2 a 255 caracteres' })
  if (!normalizeCurrency(p.currency)) errors.push({ path: 'currency', message: 'Moeda ISO 4217 inválida' })
  for (const f of ['price_min_cents', 'price_max_cents', 'price_fallback_cents'] as const)
    if (!isCents(p[f]) || p[f] < 0) errors.push({ path: f, message: 'Valor em centavos (inteiro ≥ 0)' })
  if (isCents(p.price_min_cents) && isCents(p.price_max_cents) && p.price_max_cents < p.price_min_cents)
    errors.push({ path: 'price_max_cents', message: 'O preço máximo deve ser maior ou igual ao mínimo' })
  if (isCents(p.price_fallback_cents) && p.price_fallback_cents <= 0) errors.push({ path: 'price_fallback_cents', message: 'O valor padrão deve ser maior que zero' })
  return errors
}

export class ProductsService {
  constructor(private readonly db: Database) {}

  async list(companyId: string, q: { search?: string } = {}): Promise<ProductDto[]> {
    const term = q.search?.trim()
    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.companyId, companyId), term ? sql`${products.name} ilike ${`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : undefined))
      .orderBy(asc(products.name), asc(products.id))
    return rows.map(toDto)
  }

  async get(companyId: string, id: string): Promise<ProductDto> {
    return toDto(await this.row(companyId, id))
  }

  async create(companyId: string, input: ProductInput): Promise<ProductDto> {
    const full = { name: input.name ?? '', currency: input.currency ?? 'BRL', price_min_cents: input.price_min_cents, price_max_cents: input.price_max_cents, price_fallback_cents: input.price_fallback_cents } as Required<ProductInput>
    const errors = validate(full)
    if (errors.length) throw salesInvalid(errors)
    const [row] = await this.db
      .insert(products)
      .values({
        companyId,
        name: full.name.trim(),
        currency: normalizeCurrency(full.currency)!,
        priceMinCents: full.price_min_cents,
        priceMaxCents: full.price_max_cents,
        priceFallbackCents: full.price_fallback_cents,
      })
      .returning()
    return toDto(row!)
  }

  async update(companyId: string, id: string, input: ProductInput): Promise<ProductDto> {
    const cur = await this.row(companyId, id)
    const full: Required<ProductInput> = {
      name: input.name ?? cur.name,
      currency: input.currency ?? cur.currency,
      price_min_cents: input.price_min_cents ?? cur.priceMinCents,
      price_max_cents: input.price_max_cents ?? cur.priceMaxCents,
      price_fallback_cents: input.price_fallback_cents ?? cur.priceFallbackCents,
    }
    const errors = validate(full)
    if (errors.length) throw salesInvalid(errors)
    const [row] = await this.db
      .update(products)
      .set({
        name: full.name.trim(),
        currency: normalizeCurrency(full.currency)!,
        priceMinCents: full.price_min_cents,
        priceMaxCents: full.price_max_cents,
        priceFallbackCents: full.price_fallback_cents,
        updatedAt: new Date(),
      })
      .where(and(eq(products.companyId, companyId), eq(products.id, id)))
      .returning()
    return toDto(row!)
  }

  /** Exclui; as vendas ficam com `product_id` nulo (FK SET NULL). */
  async delete(companyId: string, id: string): Promise<void> {
    await this.row(companyId, id)
    await this.db.delete(products).where(and(eq(products.companyId, companyId), eq(products.id, id)))
  }

  private async row(companyId: string, id: string) {
    if (!UUID_RE.test(id)) throw salesNotFound('Produto')
    const [row] = await this.db.select().from(products).where(and(eq(products.companyId, companyId), eq(products.id, id))).limit(1)
    if (!row) throw salesNotFound('Produto')
    return row
  }
}

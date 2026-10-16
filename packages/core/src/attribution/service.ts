// Atribuição do contato (T73; 11 §3.7): primeiro e último toque (UTM, CTWA, `source_id`/`source_url`). O primeiro é
// gravado uma única vez e NUNCA sobrescrito; o último é atualizado a cada toque (AC-T73-04).
import { and, eq, sql } from 'drizzle-orm'
import { contactAttribution, contacts, type Database } from '@crm/db'

export const TOUCH_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ctwa_clid', 'source_id', 'source_url'] as const
export type TouchField = (typeof TOUCH_FIELDS)[number]
export type Touch = Partial<Record<TouchField, string | null>>

export interface TouchDto extends Record<TouchField, string | null> {
  at: string
  sale_source_id: string | null
}

export interface AttributionDto {
  first_touch: TouchDto
  last_touch: TouchDto
}

const COLS = {
  utm_source: 'UtmSource',
  utm_medium: 'UtmMedium',
  utm_campaign: 'UtmCampaign',
  utm_content: 'UtmContent',
  utm_term: 'UtmTerm',
  ctwa_clid: 'CtwaClid',
  source_id: 'SourceId',
  source_url: 'SourceUrl',
} as const satisfies Record<TouchField, string>

type Row = typeof contactAttribution.$inferSelect

export const hasTouch = (t: Touch) => TOUCH_FIELDS.some((f) => Boolean(t[f]))

export class AttributionService {
  constructor(private readonly db: Database) {}

  /** Grava um toque. Sem nenhum campo de atribuição, não faz nada. */
  async recordTouch(companyId: string, contactId: string, touch: Touch, opts: { at?: Date; saleSourceId?: string | null } = {}): Promise<void> {
    if (!hasTouch(touch)) return
    const at = opts.at ?? new Date()
    const vals = (prefix: 'first' | 'last') =>
      Object.fromEntries(TOUCH_FIELDS.map((f) => [`${prefix}${COLS[f]}`, touch[f] ?? null])) as Partial<typeof contactAttribution.$inferInsert>
    await this.db
      .insert(contactAttribution)
      .values({
        contactId,
        companyId,
        ...vals('first'),
        firstAt: at,
        firstSaleSourceId: opts.saleSourceId ?? null,
        ...vals('last'),
        lastAt: at,
        lastSaleSourceId: opts.saleSourceId ?? null,
      } as typeof contactAttribution.$inferInsert)
      // Já existe: só o último toque muda.
      .onConflictDoUpdate({ target: contactAttribution.contactId, set: { ...vals('last'), lastAt: at, lastSaleSourceId: opts.saleSourceId ?? null, updatedAt: sql`now()` } })
  }

  async get(companyId: string, contactId: string): Promise<AttributionDto | null> {
    const [row] = await this.db
      .select()
      .from(contactAttribution)
      .where(and(eq(contactAttribution.companyId, companyId), eq(contactAttribution.contactId, contactId)))
      .limit(1)
    return row ? toAttributionDto(row) : null
  }

  /** O contato existe na empresa? (rota de leitura: 404 entre empresas). */
  async contactExists(companyId: string, contactId: string): Promise<boolean> {
    const [c] = await this.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.id, contactId))).limit(1)
    return Boolean(c)
  }
}

function touchOf(r: Row, prefix: 'first' | 'last'): TouchDto {
  const rec = r as unknown as Record<string, unknown>
  return {
    ...(Object.fromEntries(TOUCH_FIELDS.map((f) => [f, (rec[`${prefix}${COLS[f]}`] as string | null) ?? null])) as Record<TouchField, string | null>),
    at: (rec[`${prefix}At`] as Date).toISOString(),
    sale_source_id: (rec[`${prefix}SaleSourceId`] as string | null) ?? null,
  }
}

export const toAttributionDto = (r: Row): AttributionDto => ({ first_touch: touchOf(r, 'first'), last_touch: touchOf(r, 'last') })

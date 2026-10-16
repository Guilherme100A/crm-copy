// Etiquetas da empresa (17 §3.E): nome 2–50, cor `#RRGGBB`; excluir remove os vínculos (cascata em contact_labels).
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { contactLabels, labels, type Database } from '@crm/db'
import { ContactsError, invalid, notFound, uniqueViolation } from '../contacts/errors'

export const LABEL_NAME_MIN = 2
export const LABEL_NAME_MAX = 50
export const LABEL_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

export interface LabelDto {
  id: string
  name: string
  color: string
  contacts_count: number
  created_at: string
}

export interface LabelInput {
  name: string
  color: string
}

type Row = typeof labels.$inferSelect

const toDto = (r: Row, contactsCount = 0): LabelDto => ({
  id: r.id,
  name: r.name,
  color: r.color,
  contacts_count: contactsCount,
  created_at: r.createdAt.toISOString(),
})

function normalizeName(raw: string): string {
  const name = raw.trim()
  if (name.length < LABEL_NAME_MIN || name.length > LABEL_NAME_MAX)
    throw invalid('name', `O nome deve ter de ${LABEL_NAME_MIN} a ${LABEL_NAME_MAX} caracteres`)
  return name
}

function normalizeColor(raw: string): string {
  const color = raw.trim()
  if (!LABEL_COLOR_RE.test(color)) throw invalid('color', 'A cor deve estar no formato #RRGGBB')
  return color.toUpperCase()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class LabelsService {
  constructor(private readonly db: Database) {}

  async list(companyId: string): Promise<LabelDto[]> {
    const rows = await this.db
      .select({ label: labels, contactsCount: sql<number>`(select count(*)::int from ${contactLabels} where ${contactLabels.labelId} = ${labels.id})` })
      .from(labels)
      .where(eq(labels.companyId, companyId))
      .orderBy(asc(labels.name))
    return rows.map((r) => toDto(r.label, r.contactsCount))
  }

  async get(companyId: string, id: string): Promise<LabelDto> {
    if (!UUID_RE.test(id)) throw notFound('Etiqueta')
    const [row] = await this.db.select().from(labels).where(and(eq(labels.companyId, companyId), eq(labels.id, id)))
    if (!row) throw notFound('Etiqueta')
    const [c] = await this.db.select({ n: count() }).from(contactLabels).where(eq(contactLabels.labelId, id))
    return toDto(row, c?.n ?? 0)
  }

  async create(companyId: string, input: LabelInput): Promise<LabelDto> {
    const values = { companyId, name: normalizeName(input.name), color: normalizeColor(input.color) }
    try {
      const [row] = await this.db.insert(labels).values(values).returning()
      return toDto(row!)
    } catch (err) {
      if (uniqueViolation(err)) throw await this.nameConflict(companyId, values.name)
      throw err
    }
  }

  async update(companyId: string, id: string, patch: Partial<LabelInput>): Promise<LabelDto> {
    if (!UUID_RE.test(id)) throw notFound('Etiqueta')
    const set: Partial<typeof labels.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) set.name = normalizeName(patch.name)
    if (patch.color !== undefined) set.color = normalizeColor(patch.color)
    try {
      const [row] = await this.db.update(labels).set(set).where(and(eq(labels.companyId, companyId), eq(labels.id, id))).returning()
      if (!row) throw notFound('Etiqueta')
    } catch (err) {
      if (uniqueViolation(err) && set.name) throw await this.nameConflict(companyId, set.name)
      throw err
    }
    return this.get(companyId, id)
  }

  /** Exclui a etiqueta e todos os vínculos com contatos. */
  async delete(companyId: string, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw notFound('Etiqueta')
    const deleted = await this.db.delete(labels).where(and(eq(labels.companyId, companyId), eq(labels.id, id))).returning({ id: labels.id })
    if (!deleted.length) throw notFound('Etiqueta')
  }

  /** Confere que todas as etiquetas são da empresa; senão erro de validação em `path`. */
  async assertOwned(db: Pick<Database, 'select'>, companyId: string, ids: readonly string[], path = 'label_ids'): Promise<void> {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    if (unique.some((id) => !UUID_RE.test(id))) throw invalid(path, 'Etiqueta inválida')
    const found = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.companyId, companyId), inArray(labels.id, unique)))
    if (found.length !== unique.length) throw invalid(path, 'Etiqueta não encontrada')
  }

  private async nameConflict(companyId: string, name: string): Promise<ContactsError> {
    const [existing] = await this.db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), sql`lower(${labels.name}) = lower(${name})`))
    return new ContactsError('conflict', 'Já existe uma etiqueta com esse nome', { id: existing?.id ?? null, field: 'name' })
  }
}

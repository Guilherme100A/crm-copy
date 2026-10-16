// Catálogo de campos personalizados (features 05 §3.2 e 17 §3.D): chave minúscula imutável (2–255), só a
// descrição é editável, sem exclusão; nasce também quando um contato recebe uma chave nova. Campos de sistema
// (BOT) são somente leitura.
import { and, asc, eq, sql } from 'drizzle-orm'
import { customFieldDefs, type Database } from '@crm/db'
import { ContactsError, invalid, uniqueViolation } from '../contacts/errors'

type Executor = Pick<Database, 'select' | 'insert' | 'update'>

/** Campos de sistema (BOT), somente leitura (17 §3.D). */
export const SYSTEM_CUSTOM_FIELDS = [
  { key: 'full_name', description: 'Nome Completo' },
  { key: 'first_name', description: 'Primeiro Nome' },
  { key: 'phone_number', description: 'Telefone' },
  { key: 'hora', description: 'Hora (HH:mm)' },
  { key: 'data', description: 'Data (dd/MM)' },
  { key: 'dia', description: 'Dia da Semana' },
  { key: 'response.type', description: 'Tipo da Resposta (MIME da última resposta)' },
  { key: 'response.erro', description: 'Erro da Integração (último erro HTTP)' },
] as const

const SYSTEM_KEYS = new Set<string>(SYSTEM_CUSTOM_FIELDS.map((f) => f.key))

export const isSystemFieldKey = (key: string) => SYSTEM_KEYS.has(key.trim().toLowerCase())

export const CUSTOM_FIELD_KEY_MIN = 2
export const CUSTOM_FIELD_KEY_MAX = 255

/**
 * Chave de campo: trim + minúsculas, 2–255 caracteres, sem chaves `{}` nem ponto (o ponto é dot-path nas variáveis
 * de template). Chave de sistema → erro. `path` aponta o campo no erro de validação.
 */
export function normalizeFieldKey(raw: string, path = 'key'): string {
  const key = raw.trim().toLowerCase()
  if (key.length < CUSTOM_FIELD_KEY_MIN || key.length > CUSTOM_FIELD_KEY_MAX)
    throw invalid(path, `A chave deve ter de ${CUSTOM_FIELD_KEY_MIN} a ${CUSTOM_FIELD_KEY_MAX} caracteres`)
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(key)) throw invalid(path, 'A chave só pode ter letras, números, espaço, "_" e "-"')
  if (SYSTEM_KEYS.has(key)) throw invalid(path, 'Chave reservada para campo de sistema')
  return key
}

export interface CustomFieldDto {
  key: string
  description: string | null
  example_value: string | null
  system: boolean
}

type Row = typeof customFieldDefs.$inferSelect

const toDto = (r: Row): CustomFieldDto => ({ key: r.key, description: r.description, example_value: r.exampleValue, system: false })

/** Exemplo exibido no catálogo: o primeiro valor visto (texto curto). */
const exampleOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.slice(0, 500)
}

export class CustomFieldsService {
  constructor(private readonly db: Database) {}

  /** Sistema primeiro, depois os customizados em ordem alfabética. */
  async list(companyId: string): Promise<CustomFieldDto[]> {
    const rows = await this.db.select().from(customFieldDefs).where(eq(customFieldDefs.companyId, companyId)).orderBy(asc(customFieldDefs.key))
    return [...SYSTEM_CUSTOM_FIELDS.map((f) => ({ key: f.key, description: f.description, example_value: null, system: true })), ...rows.map(toDto)]
  }

  async create(companyId: string, input: { key: string; description?: string | null }): Promise<CustomFieldDto> {
    const key = normalizeFieldKey(input.key)
    try {
      const [row] = await this.db
        .insert(customFieldDefs)
        .values({ companyId, key, description: input.description?.trim() || null })
        .returning()
      return toDto(row!)
    } catch (err) {
      if (uniqueViolation(err)) throw new ContactsError('conflict', 'Campo já existe', { key, field: 'key' })
      throw err
    }
  }

  /** Só a descrição muda (a chave é imutável). Campo de sistema → erro de validação. */
  async updateDescription(companyId: string, rawKey: string, description: string | null): Promise<CustomFieldDto> {
    const key = rawKey.trim().toLowerCase()
    if (SYSTEM_KEYS.has(key)) throw invalid('key', 'Campos de sistema não são editáveis')
    const [row] = await this.db
      .update(customFieldDefs)
      .set({ description: description?.trim() || null, updatedAt: new Date() })
      .where(and(eq(customFieldDefs.companyId, companyId), eq(customFieldDefs.key, key)))
      .returning()
    if (!row) throw new ContactsError('not_found', 'Campo não encontrado')
    return toDto(row)
  }

  /** Garante as chaves no catálogo (chave nova gravada num contato aparece aqui). Idempotente. */
  async register(db: Executor, companyId: string, fields: Record<string, unknown>): Promise<void> {
    const values = Object.entries(fields).map(([key, v]) => ({ companyId, key, exampleValue: exampleOf(v) }))
    if (!values.length) return
    await db
      .insert(customFieldDefs)
      .values(values)
      .onConflictDoUpdate({
        target: [customFieldDefs.companyId, customFieldDefs.key],
        set: { exampleValue: sql`coalesce(${customFieldDefs.exampleValue}, excluded.example_value)` },
      })
  }
}

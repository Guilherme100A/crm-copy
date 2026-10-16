// Regras de despesa e grupos de filtro do dashboard (T34; 02 §3.5–3.6).
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { dashboardFilterGroups, EXPENSE_KINDS, EXPENSE_PERCENT_BASES, EXPENSE_PERIODS, expenseRules, type Database } from '@crm/db'
import { isUniqueViolation } from '../auth/errors'
import { normalizeCurrency, SalesError, salesInvalid, salesNotFound, UUID_RE } from './errors'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ExpenseRuleInput {
  name?: string
  kind?: (typeof EXPENSE_KINDS)[number]
  amount_cents?: number | null
  currency?: string | null
  percent?: number | null
  percent_base?: (typeof EXPENSE_PERCENT_BASES)[number] | null
  period?: (typeof EXPENSE_PERIODS)[number]
  active_from?: string | null
  active_to?: string | null
}

export interface ExpenseRuleDto {
  id: string
  name: string
  kind: (typeof EXPENSE_KINDS)[number]
  amount_cents: number | null
  currency: string | null
  percent: number | null
  percent_base: (typeof EXPENSE_PERCENT_BASES)[number] | null
  period: (typeof EXPENSE_PERIODS)[number]
  active_from: string | null
  active_to: string | null
  created_at: string
  updated_at: string
}

const ruleDto = (r: typeof expenseRules.$inferSelect): ExpenseRuleDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  amount_cents: r.amountCents,
  currency: r.currency,
  percent: r.percent === null ? null : Number(r.percent),
  percent_base: r.percentBase,
  period: r.period,
  active_from: r.activeFrom,
  active_to: r.activeTo,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
})

/** Valida o estado final da regra (AC-T34-03: percentual exige `percent_base`, sem default). */
function validateRule(r: Required<ExpenseRuleInput>) {
  const errors: { path: string; message: string }[] = []
  const name = (r.name ?? '').trim()
  if (!name || name.length > 120) errors.push({ path: 'name', message: 'Informe o nome (até 120 caracteres)' })
  if (!(EXPENSE_KINDS as readonly string[]).includes(r.kind)) errors.push({ path: 'kind', message: 'Use fixed ou percent' })
  if (!(EXPENSE_PERIODS as readonly string[]).includes(r.period)) errors.push({ path: 'period', message: 'Use day, week ou month' })
  const out = { name, kind: r.kind, period: r.period, amountCents: null as number | null, currency: null as string | null, percent: null as string | null, percentBase: null as ExpenseRuleDto['percent_base'] }
  if (r.kind === 'fixed') {
    if (!Number.isSafeInteger(r.amount_cents) || (r.amount_cents as number) < 0) errors.push({ path: 'amount_cents', message: 'Valor em centavos (inteiro ≥ 0)' })
    out.amountCents = r.amount_cents
    out.currency = normalizeCurrency(r.currency ?? 'BRL')
    if (!out.currency) errors.push({ path: 'currency', message: 'Moeda ISO 4217 inválida' })
  } else if (r.kind === 'percent') {
    const p = r.percent
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100 || Math.round(p * 100) !== p * 100)
      errors.push({ path: 'percent', message: 'Percentual de 0 a 100, com até 2 casas' })
    else out.percent = p.toFixed(2)
    if (!r.percent_base || !(EXPENSE_PERCENT_BASES as readonly string[]).includes(r.percent_base))
      errors.push({ path: 'percent_base', message: 'Escolha a base do percentual (revenue, spend ou profit_pre)' })
    else out.percentBase = r.percent_base
  }
  for (const f of ['active_from', 'active_to'] as const)
    if (r[f] !== null && r[f] !== undefined && (!DATE_RE.test(r[f]!) || Number.isNaN(Date.parse(r[f]!)))) errors.push({ path: f, message: 'Use YYYY-MM-DD' })
  if (r.active_from && r.active_to && r.active_to < r.active_from) errors.push({ path: 'active_to', message: 'O fim da vigência é antes do início' })
  if (errors.length) throw salesInvalid(errors)
  return { ...out, activeFrom: r.active_from ?? null, activeTo: r.active_to ?? null }
}

export class ExpenseRulesService {
  constructor(private readonly db: Database) {}

  async list(companyId: string): Promise<ExpenseRuleDto[]> {
    const rows = await this.db.select().from(expenseRules).where(eq(expenseRules.companyId, companyId)).orderBy(asc(expenseRules.name), asc(expenseRules.id))
    return rows.map(ruleDto)
  }

  async create(companyId: string, input: ExpenseRuleInput): Promise<ExpenseRuleDto> {
    const v = validateRule({
      name: input.name ?? '',
      kind: input.kind ?? 'fixed',
      amount_cents: input.amount_cents ?? null,
      currency: input.currency ?? null,
      percent: input.percent ?? null,
      percent_base: input.percent_base ?? null,
      period: input.period ?? 'month',
      active_from: input.active_from ?? null,
      active_to: input.active_to ?? null,
    })
    const [row] = await this.db.insert(expenseRules).values({ companyId, ...v }).returning()
    return ruleDto(row!)
  }

  async update(companyId: string, id: string, input: ExpenseRuleInput): Promise<ExpenseRuleDto> {
    const cur = await this.row(companyId, id)
    const pick = <K extends keyof ExpenseRuleInput>(k: K, fallback: ExpenseRuleInput[K]) => (input[k] !== undefined ? input[k] : fallback)
    const v = validateRule({
      name: pick('name', cur.name)!,
      kind: pick('kind', cur.kind)!,
      amount_cents: pick('amount_cents', cur.amountCents) ?? null,
      currency: pick('currency', cur.currency) ?? null,
      percent: pick('percent', cur.percent === null ? null : Number(cur.percent)) ?? null,
      percent_base: pick('percent_base', cur.percentBase) ?? null,
      period: pick('period', cur.period)!,
      active_from: pick('active_from', cur.activeFrom) ?? null,
      active_to: pick('active_to', cur.activeTo) ?? null,
    })
    const [row] = await this.db
      .update(expenseRules)
      .set({ ...v, updatedAt: new Date() })
      .where(and(eq(expenseRules.companyId, companyId), eq(expenseRules.id, id)))
      .returning()
    return ruleDto(row!)
  }

  async delete(companyId: string, id: string): Promise<void> {
    await this.row(companyId, id)
    await this.db.delete(expenseRules).where(and(eq(expenseRules.companyId, companyId), eq(expenseRules.id, id)))
  }

  private async row(companyId: string, id: string) {
    if (!UUID_RE.test(id)) throw salesNotFound('Regra de despesa')
    const [row] = await this.db.select().from(expenseRules).where(and(eq(expenseRules.companyId, companyId), eq(expenseRules.id, id))).limit(1)
    if (!row) throw salesNotFound('Regra de despesa')
    return row
  }
}

// ---------- grupos de filtro ----------

export interface FilterGroupInput {
  name?: string
  connection_ids?: string[]
  product_ids?: string[]
  ad_account_ids?: string[]
}

export interface FilterGroupDto {
  id: string
  name: string
  connection_ids: string[]
  product_ids: string[]
  ad_account_ids: string[]
  created_at: string
  updated_at: string
}

const groupDto = (r: typeof dashboardFilterGroups.$inferSelect): FilterGroupDto => ({
  id: r.id,
  name: r.name,
  connection_ids: r.connectionIds,
  product_ids: r.productIds,
  ad_account_ids: r.adAccountIds,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
})

const sortedUniq = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort()
const nameTaken = () => new SalesError('conflict', 'Já existe um grupo com esse nome', { fields: [{ path: 'name', message: 'Já existe um grupo com esse nome' }] })

export class FilterGroupsService {
  constructor(private readonly db: Database) {}

  async list(companyId: string): Promise<FilterGroupDto[]> {
    const rows = await this.db
      .select()
      .from(dashboardFilterGroups)
      .where(eq(dashboardFilterGroups.companyId, companyId))
      .orderBy(sql`lower(${dashboardFilterGroups.name}) collate "C"`, asc(dashboardFilterGroups.id))
    return rows.map(groupDto)
  }

  async create(companyId: string, input: FilterGroupInput): Promise<FilterGroupDto> {
    const v = this.validate(input, { name: '', connectionIds: [], productIds: [], adAccountIds: [] })
    await this.assertUnique(companyId, v, null)
    try {
      const [row] = await this.db.insert(dashboardFilterGroups).values({ companyId, ...v }).returning()
      return groupDto(row!)
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken()
      throw err
    }
  }

  async update(companyId: string, id: string, input: FilterGroupInput): Promise<FilterGroupDto> {
    const cur = await this.row(companyId, id)
    const v = this.validate(input, cur)
    await this.assertUnique(companyId, v, id)
    try {
      const [row] = await this.db
        .update(dashboardFilterGroups)
        .set({ ...v, updatedAt: new Date() })
        .where(and(eq(dashboardFilterGroups.companyId, companyId), eq(dashboardFilterGroups.id, id)))
        .returning()
      return groupDto(row!)
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken()
      throw err
    }
  }

  async delete(companyId: string, id: string): Promise<void> {
    await this.row(companyId, id)
    await this.db.delete(dashboardFilterGroups).where(and(eq(dashboardFilterGroups.companyId, companyId), eq(dashboardFilterGroups.id, id)))
  }

  private validate(input: FilterGroupInput, cur: { name: string; connectionIds: string[]; productIds: string[]; adAccountIds: string[] }) {
    const name = (input.name ?? cur.name).trim()
    const errors: { path: string; message: string }[] = []
    if (!name || name.length > 120) errors.push({ path: 'name', message: 'Informe o nome do grupo (até 120 caracteres)' })
    const connectionIds = sortedUniq(input.connection_ids ?? cur.connectionIds)
    const productIds = sortedUniq(input.product_ids ?? cur.productIds)
    const adAccountIds = sortedUniq(input.ad_account_ids ?? cur.adAccountIds)
    connectionIds.forEach((x, i) => !UUID_RE.test(x) && errors.push({ path: `connection_ids.${i}`, message: 'uuid inválido' }))
    productIds.forEach((x, i) => !UUID_RE.test(x) && errors.push({ path: `product_ids.${i}`, message: 'uuid inválido' }))
    if (errors.length) throw salesInvalid(errors)
    return { name, connectionIds, productIds, adAccountIds }
  }

  /** Nome único (trim, sem caixa) e conjunto de filtros único entre os grupos (02 §3.6). */
  private async assertUnique(companyId: string, v: { name: string; connectionIds: string[]; productIds: string[]; adAccountIds: string[] }, selfId: string | null) {
    const others = await this.db
      .select()
      .from(dashboardFilterGroups)
      .where(and(eq(dashboardFilterGroups.companyId, companyId), selfId ? ne(dashboardFilterGroups.id, selfId) : undefined))
    const key = (xs: string[]) => [...xs].sort().join(',')
    for (const o of others) {
      if (o.name.trim().toLowerCase() === v.name.toLowerCase()) throw nameTaken()
      if (key(o.connectionIds) === key(v.connectionIds) && key(o.productIds) === key(v.productIds) && key(o.adAccountIds) === key(v.adAccountIds))
        throw new SalesError('conflict', `Esses filtros já estão salvos no grupo "${o.name}"`, { reason: 'scope_taken', group_id: o.id })
    }
  }

  private async row(companyId: string, id: string) {
    if (!UUID_RE.test(id)) throw salesNotFound('Grupo de filtros')
    const [row] = await this.db
      .select()
      .from(dashboardFilterGroups)
      .where(and(eq(dashboardFilterGroups.companyId, companyId), eq(dashboardFilterGroups.id, id)))
      .limit(1)
    if (!row) throw salesNotFound('Grupo de filtros')
    return row
  }
}

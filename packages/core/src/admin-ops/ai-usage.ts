// Uso de IA da plataforma por empresa × provedor × modelo (T96, AC-T96-04; 20-admin-interno.md §3.9). Mesma regra do
// resumo da empresa (T37): chamadas com erro não entram; custo, valor cobrado e créditos somam só o que ficou `charged`
// (reembolsado não conta). O detalhe evento a evento continua em `GET /api/platform/ai/usage`.
import { and, desc, eq, gte, lt, ne, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { aiUsage, companies, type Database } from '@crm/db'
import { AdminOpsError } from './errors'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dateParam = z.iso.datetime({ offset: true, message: 'Data inválida (ISO 8601)' }).optional()

export const aiUsageAggregateQuerySchema = z
  .object({
    from: dateParam,
    to: dateParam,
    company_id: z.string().max(64).optional(),
    provider: z.string().max(100).optional(),
    model: z.string().max(200).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` precisa ser anterior a `to`',
    path: ['to'],
  })

export interface AiUsageAggregateItem {
  company_id: string
  company_name: string
  provider: string
  model: string
  count: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  billed_micros: number
  credits: number
}

export interface AiUsageAggregate {
  from: string | null
  to: string | null
  items: AiUsageAggregateItem[]
  totals: Omit<AiUsageAggregateItem, 'company_id' | 'company_name' | 'provider' | 'model'>
}

export async function aiUsageByCompanyModel(db: Database, query: unknown): Promise<AiUsageAggregate> {
  const parsed = aiUsageAggregateQuerySchema.safeParse(query ?? {})
  if (!parsed.success)
    throw new AdminOpsError('validation', 'Dados inválidos', {
      fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    })
  const q = parsed.data
  const where: SQL[] = [ne(aiUsage.status, 'error')]
  if (q.company_id) where.push(UUID_RE.test(q.company_id) ? eq(aiUsage.companyId, q.company_id) : sql`false`)
  if (q.from) where.push(gte(aiUsage.createdAt, new Date(q.from)))
  if (q.to) where.push(lt(aiUsage.createdAt, new Date(q.to)))
  if (q.provider) where.push(eq(aiUsage.provider, q.provider))
  if (q.model) where.push(eq(aiUsage.model, q.model))
  const charged = sql`${aiUsage.status} = 'charged'`
  const credits = sql<string>`coalesce(sum(${aiUsage.credits}) filter (where ${charged}), 0)`
  const rows = await db
    .select({
      company_id: aiUsage.companyId,
      company_name: companies.name,
      provider: aiUsage.provider,
      model: aiUsage.model,
      count: sql<string>`count(*)`,
      input_tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
      output_tokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
      cost_micros: sql<string>`coalesce(sum(${aiUsage.costMicros}) filter (where ${charged}), 0)`,
      billed_micros: sql<string>`coalesce(sum(${aiUsage.billedMicros}) filter (where ${charged}), 0)`,
      credits,
    })
    .from(aiUsage)
    .innerJoin(companies, eq(companies.id, aiUsage.companyId))
    .where(and(...where))
    .groupBy(aiUsage.companyId, companies.name, aiUsage.provider, aiUsage.model)
    .orderBy(desc(credits), companies.name, aiUsage.provider, aiUsage.model)
  const items = rows.map((r) => ({
    company_id: r.company_id,
    company_name: r.company_name,
    provider: r.provider,
    model: r.model,
    count: Number(r.count),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cost_micros: Number(r.cost_micros),
    billed_micros: Number(r.billed_micros),
    credits: Number(r.credits),
  }))
  const totals = { count: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0, billed_micros: 0, credits: 0 }
  for (const i of items) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += i[k]
  return { from: q.from ?? null, to: q.to ?? null, items, totals }
}

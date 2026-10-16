// Vendas, regras de despesa e grupos de filtro do dashboard (SPEC T34; 02 §3.5–3.7, §6).
// Ler e editar regras/grupos: dashboard.sales; criar/editar/excluir vendas: sales.edit.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { ExpenseRulesService, FilterGroupsService, RealtimePublisher, SalesService, type ChatPublisher } from '@crm/core'
import { SALE_SOURCES, SALE_STATUSES } from '@crm/db'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { salesDomain } from '../products/index'

declare module '../../lib/types' {
  interface AppDeps {
    /** Publicador de `sale.recorded` (padrão: `RealtimePublisher` sobre `redis`). */
    salesPublisher?: Pick<ChatPublisher, 'publish'>
  }
}

const unwrap = (key: string) => (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && key in v && Object.keys(v).length === 1 ? (v as Record<string, unknown>)[key] : v
const nstr = (max: number) => z.string().max(max).nullish()

const saleBody = z.object({
  amount_cents: z.number().optional(),
  currency: z.string().max(10).optional(),
  sold_at: z.string().max(40).nullish(),
  status: z.enum(SALE_STATUSES).optional(),
  product_id: nstr(64),
  contact_id: nstr(64),
  connection_id: nstr(64),
  source_id: nstr(200),
  ctwa_clid: nstr(500),
  external_id: nstr(200),
  instance_name: nstr(255),
  instance_number: nstr(64),
  lead_number: nstr(64),
  customer_name: nstr(255),
})
const createSale = z.preprocess(unwrap('sale'), saleBody)
const updateSale = z.preprocess(unwrap('sale'), saleBody.omit({ external_id: true }))

const ruleSchema = z.preprocess(
  unwrap('expense_rule'),
  z.object({
    name: z.string().max(1000).optional(),
    kind: z.enum(['fixed', 'percent']).optional(),
    amount_cents: z.number().nullish(),
    currency: nstr(10),
    percent: z.number().nullish(),
    percent_base: z.enum(['revenue', 'spend', 'profit_pre']).nullish(),
    period: z.enum(['day', 'week', 'month']).optional(),
    active_from: nstr(20),
    active_to: nstr(20),
  }),
)
const groupSchema = z.preprocess(
  unwrap('filter_group'),
  z.object({
    name: z.string().max(1000).optional(),
    connection_ids: z.array(z.string().max(64)).max(500).optional(),
    product_ids: z.array(z.string().max(64)).max(500).optional(),
    ad_account_ids: z.array(z.string().max(100)).max(500).optional(),
  }),
)

const uuid = z.uuid()

/** Query do histórico: listas aceitam `?x=a&x=b`, `?x[]=a` e `?x=a,b`. */
function listQuery(c: Context<AppEnv>) {
  const list = (name: string) =>
    [...(c.req.queries(name) ?? []), ...(c.req.queries(`${name}[]`) ?? [])].flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  const fail = (path: string, message: string) => new ApiError('VALIDATION_ERROR', message, { fields: [{ path, message }] })
  const page = Number(c.req.query('page') ?? 1)
  const limit = Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT)
  if (!Number.isInteger(page) || page < 1) throw fail('page', 'Página inválida')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw fail('limit', `Limite de 1 a ${MAX_PAGE_LIMIT}`)
  const connection_ids = list('connection_ids').concat(list('connection_id'))
  const product_ids = list('product_ids').concat(list('product_id'))
  for (const [name, ids] of [
    ['connection_ids', connection_ids],
    ['product_ids', product_ids],
  ] as const) {
    const bad = ids.findIndex((v) => !uuid.safeParse(v).success)
    if (bad >= 0) throw fail(`${name}.${bad}`, 'uuid inválido')
  }
  const status = list('status')
  if (status.some((s) => !(SALE_STATUSES as readonly string[]).includes(s))) throw fail('status', 'Status inválido')
  const source = c.req.query('source')
  if (source && !(SALE_SOURCES as readonly string[]).includes(source)) throw fail('source', 'Origem inválida')
  const contact_id = c.req.query('contact_id')
  if (contact_id && !uuid.safeParse(contact_id).success) throw fail('contact_id', 'uuid inválido')
  const skip = c.req.query('skip_total')
  return {
    page,
    limit,
    start_date: c.req.query('start_date') || undefined,
    end_date: c.req.query('end_date') || undefined,
    connection_ids,
    product_ids,
    status: status as (typeof SALE_STATUSES)[number][],
    source: (source || undefined) as (typeof SALE_SOURCES)[number] | undefined,
    contact_id: contact_id || undefined,
    skip_total: skip === '1' || skip === 'true',
  }
}

type SaleBody = z.output<typeof saleBody>
const toRecordInput = (b: Partial<SaleBody>) => ({
  ...(b.amount_cents !== undefined ? { amountCents: b.amount_cents } : {}),
  ...(b.currency !== undefined ? { currency: b.currency } : {}),
  ...(b.sold_at !== undefined ? { soldAt: b.sold_at } : {}),
  ...(b.status !== undefined ? { status: b.status } : {}),
  ...(b.product_id !== undefined ? { productId: b.product_id } : {}),
  ...(b.contact_id !== undefined ? { contactId: b.contact_id } : {}),
  ...(b.connection_id !== undefined ? { connectionId: b.connection_id } : {}),
  ...(b.source_id !== undefined ? { sourceId: b.source_id } : {}),
  ...(b.ctwa_clid !== undefined ? { ctwaClid: b.ctwa_clid } : {}),
  ...(b.instance_name !== undefined ? { instanceName: b.instance_name } : {}),
  ...(b.instance_number !== undefined ? { instanceNumber: b.instance_number } : {}),
  ...(b.lead_number !== undefined ? { leadNumber: b.lead_number } : {}),
  ...(b.customer_name !== undefined ? { customerName: b.customer_name } : {}),
})

export function salesRoutes(deps: ResolvedDeps) {
  const sales = new SalesService({ db: deps.db, publisher: deps.salesPublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }) })
  const rules = new ExpenseRulesService(deps.db)
  const groups = new FilterGroupsService(deps.db)
  const app = new Hono<AppEnv>()
  const view = requirePerm('dashboard.sales')
  const edit = requirePerm('sales.edit')

  // ---------- regras de despesa (antes de /:id) ----------

  app.get('/api/sales/expense-rules', view, async (c) => c.json({ items: await salesDomain(() => rules.list(getCompanyCtx(c).companyId)) }, 200))
  app.post('/api/sales/expense-rules', view, validate('json', ruleSchema), async (c) => {
    const expense_rule = await salesDomain(() => rules.create(getCompanyCtx(c).companyId, c.req.valid('json')))
    setAudit(c, { action: 'expense_rules.create', targetType: 'expense_rule', targetId: expense_rule.id })
    return c.json({ expense_rule }, 201)
  })
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/sales/expense-rules/:id', view, validate('json', ruleSchema), async (c) => {
      const expense_rule = await salesDomain(() => rules.update(getCompanyCtx(c).companyId, c.req.param('id'), c.req.valid('json')))
      setAudit(c, { action: 'expense_rules.update', targetType: 'expense_rule', targetId: expense_rule.id })
      return c.json({ expense_rule }, 200)
    })
  }
  app.delete('/api/sales/expense-rules/:id', view, async (c) => {
    const id = c.req.param('id')
    await salesDomain(() => rules.delete(getCompanyCtx(c).companyId, id))
    setAudit(c, { action: 'expense_rules.delete', targetType: 'expense_rule', targetId: id })
    return c.body(null, 204)
  })

  // ---------- grupos de filtro ----------

  app.get('/api/sales/filter-groups', view, async (c) => c.json({ items: await salesDomain(() => groups.list(getCompanyCtx(c).companyId)) }, 200))
  app.post('/api/sales/filter-groups', view, validate('json', groupSchema), async (c) => {
    const filter_group = await salesDomain(() => groups.create(getCompanyCtx(c).companyId, c.req.valid('json')))
    setAudit(c, { action: 'filter_groups.create', targetType: 'dashboard_filter_group', targetId: filter_group.id })
    return c.json({ filter_group }, 201)
  })
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/sales/filter-groups/:id', view, validate('json', groupSchema), async (c) => {
      const filter_group = await salesDomain(() => groups.update(getCompanyCtx(c).companyId, c.req.param('id'), c.req.valid('json')))
      setAudit(c, { action: 'filter_groups.update', targetType: 'dashboard_filter_group', targetId: filter_group.id })
      return c.json({ filter_group }, 200)
    })
  }
  app.delete('/api/sales/filter-groups/:id', view, async (c) => {
    const id = c.req.param('id')
    await salesDomain(() => groups.delete(getCompanyCtx(c).companyId, id))
    setAudit(c, { action: 'filter_groups.delete', targetType: 'dashboard_filter_group', targetId: id })
    return c.body(null, 204)
  })

  // ---------- vendas ----------

  app.get('/api/sales', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const q = listQuery(c)
    return c.json(await salesDomain(() => sales.list(companyId, q)), 200)
  })

  app.post('/api/sales', edit, validate('json', createSale), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const b = c.req.valid('json')
    const res = await salesDomain(() =>
      sales.record({ companyId, source: 'manual', externalId: b.external_id ?? null, amountCents: b.amount_cents as number, ...toRecordInput(b) }),
    )
    setAudit(c, { action: res.created ? 'sales.create' : 'sales.update', targetType: 'sale', targetId: res.sale.id })
    return c.json(res, res.created ? 201 : 200)
  })

  app.get('/api/sales/:id', view, async (c) => c.json({ sale: await salesDomain(() => sales.get(getCompanyCtx(c).companyId, c.req.param('id'))) }, 200))

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/sales/:id', edit, validate('json', updateSale), async (c) => {
      const sale = await salesDomain(() => sales.update(getCompanyCtx(c).companyId, c.req.param('id'), toRecordInput(c.req.valid('json'))))
      setAudit(c, { action: 'sales.update', targetType: 'sale', targetId: sale.id })
      return c.json({ sale }, 200)
    })
  }

  app.delete('/api/sales/:id', edit, async (c) => {
    const id = c.req.param('id')
    await salesDomain(() => sales.delete(getCompanyCtx(c).companyId, id))
    setAudit(c, { action: 'sales.delete', targetType: 'sale', targetId: id })
    return c.body(null, 204)
  })

  return app
}

// Bootstrap do dashboard (T55; 02-dashboard.md §3.4; spec de marcos §3.3): opções de filtro, grupos salvos,
// avisos/banners (vazios até a spec 20), leads acumulados e faturamento acumulado com o marco (só com `dashboard.sales`).
import { asc, count, eq, and, sql } from 'drizzle-orm'
import { connections, contacts, products, sales, type Database } from '@crm/db'
import { FilterGroupsService, type FilterGroupDto } from '../../sales/expenses'
import { computeMilestone, type MilestoneResult } from '../milestones/index'

export interface LifetimeRevenue {
  /** BRL quando há vendas em BRL; senão a soma das moedas (sem conversão). */
  revenue_cents: number
  revenue_by_currency: Record<string, number>
  display_currency: string
  milestone: MilestoneResult
}

export interface DashboardBootstrap {
  products: { id: string; name: string; currency: string }[]
  connections: { id: string; name: string; phone_number: string | null; status: string; scheduled_for_deletion: boolean }[]
  filter_groups: FilterGroupDto[]
  announcements: unknown[]
  banners: unknown[]
  leads_count: number
  lifetime_revenue?: LifetimeRevenue
}

/** Faturamento acumulado (todas as vendas aprovadas) por moeda. */
export async function lifetimeRevenue(db: Database, companyId: string, locale = 'pt-BR'): Promise<LifetimeRevenue> {
  const rows = await db
    .select({ currency: sales.currency, cents: sql<number>`coalesce(sum(${sales.amountCents}), 0)::bigint` })
    .from(sales)
    .where(and(eq(sales.companyId, companyId), eq(sales.status, 'approved')))
    .groupBy(sales.currency)
  const byCurrency: Record<string, number> = {}
  for (const r of rows) byCurrency[r.currency.toUpperCase()] = (byCurrency[r.currency.toUpperCase()] ?? 0) + Number(r.cents)
  const revenue = byCurrency.BRL ?? Object.values(byCurrency).reduce((a, v) => a + v, 0)
  return { revenue_cents: revenue, revenue_by_currency: byCurrency, display_currency: 'BRL', milestone: computeMilestone(revenue, locale) }
}

export async function dashboardBootstrap(db: Database, companyId: string, o: { includeSales: boolean; locale?: string }): Promise<DashboardBootstrap> {
  const [prods, conns, groups, [leads], lifetime] = await Promise.all([
    db.select({ id: products.id, name: products.name, currency: products.currency }).from(products).where(eq(products.companyId, companyId)).orderBy(asc(products.name), asc(products.id)),
    db
      .select({ id: connections.id, name: connections.name, phone: connections.phoneNumber, state: connections.connectionState, deletion: connections.scheduledForDeletionAt })
      .from(connections)
      .where(eq(connections.companyId, companyId))
      .orderBy(asc(connections.name), asc(connections.id)),
    new FilterGroupsService(db).list(companyId),
    db.select({ n: count() }).from(contacts).where(eq(contacts.companyId, companyId)),
    o.includeSales ? lifetimeRevenue(db, companyId, o.locale) : Promise.resolve(undefined),
  ])
  return {
    products: prods,
    connections: conns.map((c) => ({ id: c.id, name: c.name, phone_number: c.phone, status: c.state ?? 'disconnected', scheduled_for_deletion: c.deletion !== null })),
    filter_groups: groups,
    announcements: [],
    banners: [],
    leads_count: leads?.n ?? 0,
    ...(lifetime ? { lifetime_revenue: lifetime } : {}),
  }
}

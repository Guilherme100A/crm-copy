// Regras puras do histórico de vendas (T87; 02 §3.7, §5.36): parâmetros da lista a partir dos filtros do dashboard,
// venda criada no topo do cache (decisão: entra na 1ª página mesmo que o `sold_at` a pusesse mais abaixo na ordem do
// servidor; a próxima recarga completa da lista devolve a ordem real), deduplicação entre páginas (paginação por
// deslocamento + venda inserida à mão), data/hora do formulário no fuso da empresa e estado do botão Exportar.
import type { InfiniteData } from '@tanstack/react-query'
import type { DashboardSearch, Period } from '@/features/dashboard/search'
import type { SaleDto, SalesPage } from './api'

/** Filtros do `GET /api/sales`: período, conexões e produtos do dashboard. */
export function historyParams(period: Period, connectionIds: readonly string[], search?: Pick<DashboardSearch, 'product_ids'>): Record<string, string> {
  const q: Record<string, string> = { start_date: period.start_date, end_date: period.end_date }
  if (connectionIds.length) q.connection_ids = [...new Set(connectionIds)].join(',')
  if (search?.product_ids?.length) q.product_ids = [...new Set(search.product_ids)].join(',')
  return q
}

/** Linhas de todas as páginas, sem repetir id. */
export function flattenSales(data: InfiniteData<SalesPage> | undefined): SaleDto[] {
  if (!data) return []
  const seen = new Set<string>()
  const out: SaleDto[] = []
  for (const page of data.pages)
    for (const s of page.items) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
  return out
}

/** Coloca a venda no início da 1ª página (removendo uma cópia anterior dela em qualquer página). */
export function prependSale(data: InfiniteData<SalesPage> | undefined, sale: SaleDto): InfiniteData<SalesPage> {
  if (!data || data.pages.length === 0) {
    return { pages: [{ items: [sale], page: { page: 1, limit: 20, has_more: false } }], pageParams: [1] }
  }
  const pages = data.pages.map((p, i) => {
    const items = p.items.filter((s) => s.id !== sale.id)
    return { ...p, items: i === 0 ? [sale, ...items] : items }
  })
  return { ...data, pages }
}

export type ExportState = { enabled: false; reason: 'empty' | 'soon' }

/** Exportar: 0 linhas bloqueia (AC-T87-01); com linhas, ainda não há exportação de vendas no backend ("em breve"). */
export const exportState = (rows: number): ExportState => ({ enabled: false, reason: rows === 0 ? 'empty' : 'soon' })

/** Diferença (ms) entre o relógio de parede do fuso e o UTC no instante `t`. */
function offsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t))
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(t / 1000) * 1000
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** `yyyy-MM-ddTHH:mm` no fuso `tz` → ISO UTC; inválido → null. */
export function zonedToIso(local: string, tz: string): string | null {
  const m = LOCAL_RE.exec(local)
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number]
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  if (Number.isNaN(wall)) return null
  let t = wall - offsetMs(wall, tz)
  // Perto da troca de horário de verão o deslocamento muda: recalcula no instante encontrado.
  t = wall - offsetMs(t, tz)
  return new Date(t).toISOString()
}

/** Valor do `datetime-local` para `now` no fuso `tz` (padrão do campo "Data da venda"). */
export function nowLocalIn(tz: string, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + offsetMs(now.getTime(), tz))
  return shifted.toISOString().slice(0, 16)
}

/** "12,50" ou "12.50" → 1250 centavos; vazio/negativo/inválido → null. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, '')
  if (!s) return null
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
  return Math.round(Number(normalized) * 100)
}

/** Texto opcional: vazio vira null. */
export const optional = (v: string): string | null => (v.trim() ? v.trim() : null)

const NBSP = new RegExp('[\\u00a0\\u202f]', 'g')

/** Valor na moeda da venda (`R$ 1.234,56`, `US$ 10,00`). */
export function formatAmount(cents: number, currency: string, locale = 'pt-BR'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100).replace(NBSP, ' ')
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

/** `dd/MM/yyyy HH:mm` no fuso da empresa. */
export const formatSoldAt = (iso: string, tz: string, locale = 'pt-BR') =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(', ', ' ')

/** Moedas oferecidas no formulário (BRL primeiro, padrão). */
export const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'CLP', 'COP', 'MXN', 'PEN', 'UYU', 'PYG', 'BOB', 'CAD', 'AUD', 'JPY', 'CHF'] as const

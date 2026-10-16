// Mapeamento JSONPath → SaleEvent (T73). JSONPath no subconjunto usado por plataformas de checkout: `$.a.b`,
// `$.itens[0].x`, `$['a b']`, `$["a"]` ou caminho sem `$` (`a.b`). Sem filtros/curingas (não há lib na STACK).
import { normalizeContactPhone } from '../contacts/normalize'

export const SALE_EVENT_FIELDS = [
  'external_id',
  'status',
  'amount',
  'phone',
  'currency',
  'sold_at',
  'name',
  'email',
  'product_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ctwa_clid',
  'source_id',
  'source_url',
] as const
export type SaleEventField = (typeof SALE_EVENT_FIELDS)[number]
export const REQUIRED_SALE_EVENT_FIELDS: readonly SaleEventField[] = ['external_id', 'status', 'amount', 'phone']
export const ATTRIBUTION_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ctwa_clid', 'source_id', 'source_url'] as const
export type AttributionField = (typeof ATTRIBUTION_FIELDS)[number]

export const SALE_EVENT_STATUSES = ['approved', 'refunded', 'chargeback', 'pending'] as const
export type SaleEventStatus = (typeof SALE_EVENT_STATUSES)[number]

/** Mapa padrão (somado ao da fonte; o da fonte vence). Chaves em minúsculas. */
export const DEFAULT_STATUS_MAP: Readonly<Record<string, SaleEventStatus>> = {
  approved: 'approved',
  paid: 'approved',
  pago: 'approved',
  aprovado: 'approved',
  aprovada: 'approved',
  completed: 'approved',
  complete: 'approved',
  refunded: 'refunded',
  reembolsado: 'refunded',
  reembolsada: 'refunded',
  estornado: 'refunded',
  chargeback: 'chargeback',
  pending: 'pending',
  pendente: 'pending',
  waiting: 'pending',
  waiting_payment: 'pending',
  aguardando: 'pending',
  aguardando_pagamento: 'pending',
}

export interface SaleEvent {
  external_id: string
  status: SaleEventStatus
  amount_cents: number
  currency: string
  sold_at: string | null
  customer: { phone: string; name: string | null; email: string | null }
  product_id: string | null
  attribution: Record<AttributionField, string | null>
}

export interface SaleMappingConfig {
  mapping: Record<string, string>
  statusMap?: Record<string, string>
  amountUnit?: 'decimal' | 'cents'
}

export type ResolveResult =
  | { ok: true; event: SaleEvent }
  | { ok: false; missing: { field: SaleEventField; path: string }[]; errors: string[] }

/** `$.a.b[0]['c d']` → `['a','b',0,'c d']`. Caminho inválido → null. */
export function parseJsonPath(path: string): (string | number)[] | null {
  let s = path.trim()
  if (!s) return null
  if (s.startsWith('$')) s = s.slice(1)
  const out: (string | number)[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '.') {
      i++
      const m = /^[^.[\]]+/.exec(s.slice(i))
      if (!m) return null
      out.push(m[0])
      i += m[0].length
    } else if (ch === '[') {
      const rest = s.slice(i)
      const idx = /^\[(\d+)\]/.exec(rest)
      const quoted = /^\[(['"])(.*?)\1\]/.exec(rest)
      if (idx) {
        out.push(Number(idx[1]))
        i += idx[0].length
      } else if (quoted) {
        out.push(quoted[2]!)
        i += quoted[0].length
      } else return null
    } else if (i === 0) {
      // Caminho sem `$`: primeiro segmento solto.
      const m = /^[^.[\]]+/.exec(s)
      if (!m) return null
      out.push(m[0])
      i += m[0].length
    } else return null
  }
  return out.length ? out : null
}

export function readJsonPath(root: unknown, path: string): unknown {
  const segs = parseJsonPath(path)
  if (!segs) return undefined
  let cur: unknown = root
  for (const seg of segs) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined
    if (cur === null || cur === undefined) return undefined
    if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : undefined
    else cur = typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined
  }
  return cur
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/** "1.299,90" | "199.9" | 199.9 → centavos (decimal) ou o inteiro (cents). */
export function saleAmountToCents(v: unknown, unit: 'decimal' | 'cents'): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null
    return unit === 'cents' ? Math.round(v) : Math.round(v * 100)
  }
  const s = text(v)
  if (!s) return null
  let t = s.replace(/[^\d.,-]/g, '')
  if (!t || t.startsWith('-')) return null
  const lastComma = t.lastIndexOf(',')
  const lastDot = t.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    const dec = lastComma > lastDot ? ',' : '.'
    t = t.split(dec === ',' ? '.' : ',').join('').replace(dec, '.')
  } else if (lastComma > -1) t = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, '')
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  return unit === 'cents' ? Math.round(n) : Math.round(n * 100)
}

/** Resolve o SaleEvent de um payload (sem gravar nada). */
export function resolveSaleEvent(body: unknown, cfg: SaleMappingConfig): ResolveResult {
  const missing: { field: SaleEventField; path: string }[] = []
  const errors: string[] = []
  const get = (field: SaleEventField): unknown => {
    const path = cfg.mapping[field]
    if (!path) {
      if (REQUIRED_SALE_EVENT_FIELDS.includes(field)) missing.push({ field, path: '' })
      return undefined
    }
    const v = readJsonPath(body, path)
    if ((v === undefined || v === null || (typeof v === 'string' && !v.trim())) && REQUIRED_SALE_EVENT_FIELDS.includes(field)) missing.push({ field, path })
    return v
  }
  const externalId = text(get('external_id'))
  const statusRaw = text(get('status'))
  const amountRaw = get('amount')
  const phoneRaw = text(get('phone'))
  if (missing.length) return { ok: false, missing, errors }

  const map: Record<string, string> = { ...DEFAULT_STATUS_MAP, ...Object.fromEntries(Object.entries(cfg.statusMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v])) }
  const status = map[statusRaw!.toLowerCase()]
  if (!status || !(SALE_EVENT_STATUSES as readonly string[]).includes(status)) errors.push(`unknown_status:${statusRaw}`)
  const amountCents = saleAmountToCents(amountRaw, cfg.amountUnit ?? 'decimal')
  if (amountCents === null) errors.push('invalid_value:amount')
  let phone: string | null = null
  try {
    phone = normalizeContactPhone(phoneRaw!)
  } catch {
    errors.push('invalid_phone')
  }
  const currencyRaw = text(get('currency'))
  const currency = (currencyRaw ?? 'BRL').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('invalid_value:currency')
  const soldRaw = get('sold_at')
  let soldAt: string | null = null
  if (soldRaw !== undefined && soldRaw !== null && soldRaw !== '') {
    const d = typeof soldRaw === 'number' ? new Date(soldRaw < 1e12 ? soldRaw * 1000 : soldRaw) : new Date(String(soldRaw))
    if (Number.isNaN(d.getTime())) errors.push('invalid_value:sold_at')
    else soldAt = d.toISOString()
  }
  const email = text(get('email'))
  if (errors.length) return { ok: false, missing, errors }
  return {
    ok: true,
    event: {
      external_id: externalId!.slice(0, 200),
      status: status as SaleEventStatus,
      amount_cents: amountCents!,
      currency,
      sold_at: soldAt,
      customer: { phone: phone!, name: text(get('name'))?.slice(0, 255) ?? null, email: email ? email.toLowerCase().slice(0, 255) : null },
      product_id: text(get('product_id')),
      attribution: Object.fromEntries(ATTRIBUTION_FIELDS.map((f) => [f, text(get(f))?.slice(0, 500) ?? null])) as SaleEvent['attribution'],
    },
  }
}

export const hasAttribution = (e: SaleEvent) => ATTRIBUTION_FIELDS.some((f) => e.attribution[f])

// Contratos da SPEC usados pelos testes de T02 (seções 3.3, 3.5, 3.6, 3.7 e tarefa T02).
// Os testes falam só com a porta pública `@crm/shared` (index do pacote). Os acessores abaixo
// toleram formas equivalentes (mapa ou lista, string ou objeto de resultado, throw ou Result)
// porque a SPEC fixa os nomes das funções, não a forma exata do retorno.
import * as shared from '@crm/shared'

export const mod = shared as unknown as Record<string, any>

/** SPEC 3.5 — código → HTTP. */
export const SPEC_ERROR_CODES: Record<string, number> = {
  MALFORMED_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LIMIT_REACHED: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMIT: 429,
  WARMUP_LIMIT: 429,
  QUOTA_EXCEEDED: 429,
  SESSION_NOT_CONNECTED: 409,
  CONTACT_NOT_ALLOWED: 403,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
}

/** Exige que `@crm/shared` exporte `name` como função. */
export function fn(name: string): (...args: any[]) => any {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`@crm/shared não exporta a função ${name} (exports: ${Object.keys(mod).join(', ') || '—'})`)
  return f
}

const httpOf = (v: any): number | undefined =>
  typeof v === 'number' ? v : v && typeof v === 'object' ? (v.http ?? v.status ?? v.httpStatus ?? v.http_status) : undefined

/** Normaliza `ERROR_CODES` (mapa `{CODE: http | {http}}` ou lista `[{code, http}]` / `['CODE']`) para `{CODE: http}`. */
export function errorTable(): Record<string, number | undefined> {
  const raw = mod.ERROR_CODES
  if (raw == null) throw new Error('@crm/shared não exporta ERROR_CODES')
  const out: Record<string, number | undefined> = {}
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === 'string') out[e] = undefined
      else out[e.code] = httpOf(e)
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      const code = v && typeof v === 'object' && typeof (v as any).code === 'string' ? (v as any).code : k
      out[code] = httpOf(v)
    }
  }
  return out
}

/** Membro da empresa para `can()`: papel + lista explícita (snake_case no fio; camelCase aceito). */
export function member(role: 'owner' | 'admin' | 'member', keys: string[] | null = null) {
  return { role, permission_keys: keys, permissionKeys: keys, permissions: keys }
}

const KEY_RE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/

function collectKeys(v: any, out: Set<string>, depth = 0) {
  if (depth > 6 || v == null) return
  if (typeof v === 'string') {
    if (KEY_RE.test(v)) out.add(v)
  } else if (Array.isArray(v) || v instanceof Set) {
    for (const x of v) collectKeys(x, out, depth + 1)
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (KEY_RE.test(k) && (x === true || typeof x !== 'object' || x == null)) out.add(k)
      collectKeys(x, out, depth + 1)
    }
  }
}

/**
 * Chaves do catálogo de permissões exportado por `@crm/shared`. Procura o export de catálogo
 * (nome com "catalog" ou "permission_keys"); a forma pode ser lista, mapa ou grupos.
 */
export function catalogKeys(): string[] {
  const names = Object.keys(mod).filter((n) => /catalog|^PERMISSION(_KEYS|S)?$|^permissionKeys$/i.test(n) && typeof mod[n] !== 'function')
  if (!names.length) throw new Error(`@crm/shared não exporta o catálogo de permissões (exports: ${Object.keys(mod).join(', ')})`)
  const out = new Set<string>()
  for (const n of names) {
    const v = mod[n]
    // schema zod de enum: z.enum([...]).options
    collectKeys(v && typeof v === 'object' && Array.isArray(v.options) ? v.options : v, out)
  }
  return [...out].sort()
}

/** SPEC 3.3 + 16#8.1 — catálogo esperado (sem billing.*). */
export const SETTINGS_AREAS = [
  'labels', 'departments', 'fields', 'products', 'mcp', 'integrations', 'dispatch', 'business_hours',
  'quick_replies', 'accounts', 'platform_invitations', 'global_variables',
] as const
const ved = (p: string) => [`${p}.view`, `${p}.edit`, `${p}.delete`]
export const EXPECTED_CATALOG = [
  'dashboard.sales', 'dashboard.support', 'chat.view', 'chat.block',
  ...ved('kanban'), ...ved('flows'), ...ved('contacts'), ...ved('webhooks'), ...ved('connections'),
  'facebook.campaigns', 'facebook.pixel', 'facebook.profiles', ...ved('team'),
  'settings.view', ...SETTINGS_AREAS.flatMap((a) => ved(`settings.${a}`)),
]

/** Resultado de chamar `f()`: lançou, devolveu vazio ou devolveu um Result de falha. */
export function outcome(f: () => any): { ok: true; value: any } | { ok: false; error: unknown } {
  let v: any
  try {
    v = f()
  } catch (error) {
    return { ok: false, error }
  }
  if (v == null || v === false || v === '') return { ok: false, error: v }
  if (typeof v === 'object' && !(v instanceof String)) {
    if (v.ok === false || v.success === false || (v.error != null && v.ok !== true)) return { ok: false, error: v.error ?? v }
    if (v.ok === true || v.success === true) return { ok: true, value: v.value ?? v.data ?? v.e164 ?? v }
  }
  return { ok: true, value: v }
}

/** Extrai o E.164 de um retorno string ou objeto (`{ e164 }`, `{ value }`, `{ phone }`). */
export function e164Of(v: any): string | undefined {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') return v.e164 ?? v.phone_e164 ?? v.phoneE164 ?? v.value ?? v.phone ?? v.number
  return undefined
}

/** Schema zod do envelope realtime (export com "envelope" no nome e `safeParse`). */
export function envelopeSchema(): { safeParse: (v: unknown) => { success: boolean } } {
  const names = Object.keys(mod).filter((n) => /envelope/i.test(n) && typeof mod[n]?.safeParse === 'function')
  if (!names.length) throw new Error(`@crm/shared não exporta o schema do envelope realtime (exports: ${Object.keys(mod).join(', ')})`)
  // Preferir o schema "geral" (nome mais curto) a variantes específicas.
  names.sort((a, b) => a.length - b.length)
  return mod[names[0]!]
}

export const COMPANY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

/** SPEC 3.7 — envelope `{ id, type, company_id, at, data }`. */
export function envelope(type: string, data: Record<string, unknown> = {}) {
  return { id: '1760486400000-0', type, company_id: COMPANY_ID, at: '2026-10-15T00:00:00.000Z', data }
}
